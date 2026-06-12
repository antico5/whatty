import { EventEmitter } from "node:events";
import {
  getContentType,
  jidNormalizedUser,
  normalizeMessageContent,
  proto,
  type Chat as BaileysChat,
  type Contact,
  type GroupMetadata,
  type MessageUserReceiptUpdate,
  type WAMessage,
  type WAMessageUpdate,
} from "baileys";
import { chatOps, type ChatOps } from "../persistence/chatStore.js";
import type { AccountObservation } from "../persistence/peerStore.js";
import { chatTypeOf, type Chat, type DeliveryStatus, type MediaRef } from "../types/index.js";
import { createSerialQueues } from "../util/serialQueues.js";
import type { Connection, ConnectionStatus } from "./connection.js";
import { decryptEncryptedEdit, encryptedEditOf } from "./edits.js";
import { getLogger } from "./logger.js";
import { downloadAndStore as defaultDownloadAndStore } from "./media.js";
import {
  editedTargetIdOf,
  editedTextOf,
  groupParticipantAliases,
  mapChat,
  mapDeliveryStatus,
  mapGroupMetadata,
  mapGroupParticipants,
  mapWAMessage,
  MEDIA_CONTENT_KEYS,
  rawWAMessage,
  timestampToMillis,
  verifiedBizNameFromMessages,
} from "./mappers.js";

export interface IngestorDeps {
  ops: ChatOps;
  downloadAndStore: (conn: Connection, waMsg: WAMessage, jid: string) => Promise<MediaRef | null>;
}

export interface Ingestor extends EventEmitter {
  stop(): void;
  /** Resolves once every queued chat write has settled — for clean shutdown ("flush pending saves"). */
  flush(): Promise<void>;
  /** Fetch and store fresh group metadata (participants, subject) for `jid`. No-op when offline. */
  refreshGroup(jid: string): void;
}

const STATUS_BROADCAST_JID = "status@broadcast";

/**
 * Only auto-download media for messages within this window. History syncs on a
 * fresh device link can span years; downloading all of that eagerly wastes disk
 * and bandwidth. Messages older than 7 days are skipped — their `media` field
 * stays `null`. WhatsApp media URLs expire within a similar window, so older
 * media would likely be unrecoverable anyway.
 */
const MEDIA_AUTODOWNLOAD_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

interface GroupedMessages {
  byJid: Map<string, WAMessage[]>;
  /** lid → phone-jid pairs discovered from live message keys (`remoteJidAlt` / `participantAlt`). */
  aliases: Map<string, string>;
}

/** Record a lid → phone-jid pair, accepting only a well-formed pairing. */
function collectAlias(aliases: Map<string, string>, lid: string, pn: string): void {
  if (lid.endsWith("@lid") && pn.endsWith("@s.whatsapp.net")) aliases.set(lid, pn);
}

/**
 * Group messages by chat, normalizing each message to its canonical address:
 * live messages addressed to a `@lid` jid carry `remoteJidAlt` — the same
 * chat's phone jid — and are routed there so the two address spaces never
 * split one conversation into two chats. `status@broadcast` (Status updates)
 * never becomes a chat. History-synced messages lack `remoteJidAlt`; their
 * lid-ness is handled by the alias table downstream.
 */
function groupMessagesByJid(messages: WAMessage[]): GroupedMessages {
  const byJid = new Map<string, WAMessage[]>();
  const aliases = new Map<string, string>();
  for (const m of messages) {
    if (!m.key.remoteJid) continue;
    let jid = jidNormalizedUser(m.key.remoteJid);
    if (jid === STATUS_BROADCAST_JID) continue;
    if (jid.endsWith("@lid")) {
      // Inbound messages additionally qualify via the legacy `senderPn`
      // field (pre-v7 raw data).
      const legacySenderPn = m.key.fromMe ? undefined : (m.key as { senderPn?: string }).senderPn;
      const rawAlt = m.key.remoteJidAlt ?? legacySenderPn;
      const alt = rawAlt ? jidNormalizedUser(rawAlt) : null;
      if (alt?.endsWith("@s.whatsapp.net")) {
        aliases.set(jid, alt);
        jid = alt;
      }
    }
    // Group senders are lid-addressed the same way the chat itself can be:
    // `participantAlt` carries the sender's phone jid alongside the lid in
    // `participant`. Harvest the pair so group sender labels resolve to a
    // contact name / phone number instead of the raw lid.
    if (m.key.participant && m.key.participantAlt) {
      collectAlias(aliases, jidNormalizedUser(m.key.participant), jidNormalizedUser(m.key.participantAlt));
    }
    const list = byJid.get(jid);
    if (list) list.push(m);
    else byJid.set(jid, [m]);
  }
  return { byJid, aliases };
}

/** Reaction and protocol (revoke/edit/etc.) content never become standalone chat messages. */
function isRegularMessage(waMsg: WAMessage): boolean {
  if (waMsg.messageStubType === proto.WebMessageInfo.StubType.REVOKE) return false;
  if (encryptedEditOf(waMsg)) return false;
  if (waMsg.message?.editedMessage || waMsg.message?.protocolMessage || waMsg.message?.reactionMessage) return false;
  const key = getContentType(normalizeMessageContent(waMsg.message));
  return key !== "protocolMessage" && key !== "reactionMessage";
}

function hasMediaContent(waMsg: WAMessage): boolean {
  const key = getContentType(normalizeMessageContent(waMsg.message));
  return key != null && MEDIA_CONTENT_KEYS.has(key);
}

function revokedTargetId(waMsg: WAMessage): string | null {
  if (waMsg.messageStubType !== proto.WebMessageInfo.StubType.REVOKE) return null;
  return waMsg.key.id ?? null;
}

function statusFromReceipt(receipt: proto.IUserReceipt): DeliveryStatus | null {
  if (receipt.playedTimestamp != null || receipt.readTimestamp != null) return "read";
  if (receipt.receiptTimestamp != null) return "delivered";
  return null;
}

export function createIngestor(conn: Connection, deps: Partial<IngestorDeps> = {}): Ingestor {
  const ops = deps.ops ?? chatOps;
  const downloadAndStore = deps.downloadAndStore ?? defaultDownloadAndStore;
  const log = getLogger().child({ module: "ingest" });
  const emitter = new EventEmitter() as Ingestor;

  const queues = createSerialQueues();
  const pendingEncryptedEdits = new Map<string, WAMessage>();
  const requestedEditHistory = new Set<string>();

  /** Reserved queue key for account-level writes — they're cross-chat, so they serialize together. */
  const ACCOUNTS_QUEUE_KEY = "\0accounts";

  /**
   * Run a targeted store operation, serialized per-jid so concurrent events
   * can't interleave multi-step logical operations on the same chat. The task
   * receives the chat's preferred jid; a truthy result emits `chat-updated`
   * for it.
   */
  function mutate(jid: string, task: (canonicalJid: string) => Promise<boolean>): void {
    queues.enqueue(jid, async () => {
      try {
        const canonical = await ops.resolveChatJid(jid);
        if (await task(canonical)) emitter.emit("chat-updated", canonical);
      } catch (err) {
        log.error({ err, jid }, "failed to persist chat update");
      }
    });
  }

  function applyDeletion(jid: string, targetId: string, deletedAt: number): void {
    mutate(jid, (cjid) => ops.applyMessageDeletion(cjid, targetId, deletedAt));
  }

  /**
   * Land name/identity sightings on persistent account rows — the single
   * write path replacing the old in-memory contact index, which evaporated
   * on exit and lost every push name history sync had delivered.
   */
  function observe(observations: AccountObservation[]): void {
    const usable = observations.filter((o) => {
      const jids = o.jids.filter(Boolean);
      if (jids.length === 0) return false;
      return jids.length > 1 || o.pushName != null || o.contactName != null || o.verifiedName != null;
    });
    if (usable.length === 0) return;
    queues.enqueue(ACCOUNTS_QUEUE_KEY, async () => {
      try {
        const affected = await ops.observeAccounts(usable);
        for (const jid of affected) emitter.emit("chat-updated", jid);
      } catch (err) {
        log.error({ err }, "failed to record account observations");
      }
    });
  }

  /** Everything a contact event tells us about one person, as an observation. */
  function contactObservation(c: Contact): AccountObservation {
    return {
      jids: [c.id, c.lid, c.phoneNumber].filter(Boolean).map((j) => jidNormalizedUser(j!)),
      pushName: c.notify ?? null,
      // Only trustworthy names become contact/verified names: `name` is the
      // user's own address-book entry, `verifiedName` is WhatsApp-verified.
      contactName: c.name ?? null,
      verifiedName: c.verifiedName ?? null,
    };
  }

  /**
   * Register lid ↔ phone-jid pairs. Pairing may merge two account rows (and
   * fold duplicate individual chats) and re-keys the chat to the phone jid;
   * every affected jid is announced so subscribers reload it — including a
   * now-orphaned lid-keyed list entry, which the reload drops.
   */
  function registerPairs(aliases: Map<string, string>): void {
    for (const [lid, pn] of aliases) {
      queues.enqueue(pn, async () => {
        try {
          const affected = await ops.registerJidPair(lid, pn);
          for (const jid of affected) emitter.emit("chat-updated", jid);
        } catch (err) {
          log.error({ err, lid, pn }, "failed to register jid pair");
        }
      });
    }
  }

  function encryptedEditKey(jid: string, targetId: string): string {
    return `${jid}\0${targetId}`;
  }

  function requestEditHistory(
    jid: string,
    targetId: string,
    requests: { key: proto.IMessageKey; timestamp: WAMessage["messageTimestamp"] }[],
  ): void {
    const pendingKey = encryptedEditKey(jid, targetId);
    if (requestedEditHistory.has(pendingKey)) return;
    const socket = conn.getSocket();
    const validRequests = requests.filter((request) => request.key.id);
    if (!socket || validRequests.length === 0) return;
    requestedEditHistory.add(pendingKey);
    log.info({ jid, targetId, requests: validRequests.length }, "requesting history for encrypted edit");
    void Promise.allSettled(
      validRequests.map((request) =>
        socket.fetchMessageHistory(
          10,
          request.key,
          request.timestamp ?? Math.floor(Date.now() / 1000),
        ),
      ),
    ).then((results) => {
      if (results.every((result) => result.status === "rejected")) {
        requestedEditHistory.delete(pendingKey);
        log.warn({ jid, targetId }, "all history requests for encrypted edit failed");
      }
    });
  }

  function applyEncryptedEdit(jid: string, waMsg: WAMessage): void {
    const encryptedEdit = encryptedEditOf(waMsg);
    if (!encryptedEdit) return;

    const key = encryptedEditKey(jid, encryptedEdit.targetId);
    pendingEncryptedEdits.set(key, waMsg);
    if (pendingEncryptedEdits.size > 100) {
      pendingEncryptedEdits.delete(pendingEncryptedEdits.keys().next().value!);
    }
    const socket = conn.getSocket();
    const me = socket?.user?.id ? jidNormalizedUser(socket.user.id) : null;
    const targetKey = waMsg.message?.secretEncryptedMessage?.targetMessageKey;
    const envelopeAuthor = waMsg.key.fromMe
      ? me
      : jidNormalizedUser(waMsg.key.participant ?? waMsg.key.remoteJid ?? undefined);
    const originalSender = targetKey?.participant
      ? jidNormalizedUser(targetKey.participant)
      : targetKey?.fromMe
        ? envelopeAuthor
        : jidNormalizedUser(targetKey?.remoteJid ?? undefined);

    if (!envelopeAuthor || !originalSender) return;
    mutate(jid, async (cjid) => {
      const original = await ops.getMessage(cjid, encryptedEdit.targetId);
      if (!original) {
        requestEditHistory(jid, encryptedEdit.targetId, [
          { key: waMsg.key, timestamp: waMsg.messageTimestamp },
          { key: targetKey ?? waMsg.key, timestamp: waMsg.messageTimestamp },
        ]);
        return false;
      }
      const originalRaw = rawWAMessage(original);
      const historyKey = originalRaw?.key ?? targetKey ?? waMsg.key;
      const historyTimestamp = originalRaw?.messageTimestamp ?? original.timestamp / 1000;
      const historyRequests = [
        { key: waMsg.key, timestamp: waMsg.messageTimestamp },
        { key: historyKey, timestamp: waMsg.messageTimestamp },
        { key: historyKey, timestamp: historyTimestamp },
      ];
      try {
        const text = decryptEncryptedEdit(encryptedEdit, original, originalSender, envelopeAuthor);
        if (text == null) {
          requestEditHistory(jid, encryptedEdit.targetId, historyRequests);
          return false;
        }
        pendingEncryptedEdits.delete(key);
        requestedEditHistory.delete(key);
        return ops.applyMessageEdit(cjid, encryptedEdit.targetId, text);
      } catch (err) {
        requestEditHistory(jid, encryptedEdit.targetId, historyRequests);
        log.warn({ err, jid, targetId: encryptedEdit.targetId }, "failed to decrypt encrypted message edit");
        return false;
      }
    });
  }

  /**
   * A dropped connection kills any in-flight on-demand history response — the
   * only recovery path for edits whose original lacks a `messageSecret` (all
   * phone-sent messages) — and the `requestedEditHistory` dedup mark would then
   * block re-requesting it forever. On reconnect, clear the marks and re-drive
   * every pending envelope on the fresh socket.
   */
  function handleStatus(status: ConnectionStatus): void {
    if (status !== "open") return;
    registerOwnIdentity();
    if (pendingEncryptedEdits.size === 0) return;
    requestedEditHistory.clear();
    for (const [key, envelope] of [...pendingEncryptedEdits]) {
      applyEncryptedEdit(key.slice(0, key.indexOf("\0")), envelope);
    }
  }

  /**
   * Our own lid↔pn pair never arrives through message keys — our lid shows up
   * only inside *other people's* quoted refs (`contextInfo.participant`),
   * which carry no alt-jid — so quoted replies to our own messages would
   * render the raw `@lid`. The socket knows both of our identities once the
   * connection opens; land them on the self account like any other pairing.
   */
  function registerOwnIdentity(): void {
    const user = conn.getSocket()?.user;
    if (!user?.id) return;
    const id = jidNormalizedUser(user.id);
    const lid = user.lid ? jidNormalizedUser(user.lid) : null;
    observe([{ jids: [id, lid], pushName: user.name ?? null }]);
    if (lid) registerPairs(new Map([[lid, id]]));
  }

  function scheduleMediaDownload(jid: string, waMsg: WAMessage): void {
    const messageId = waMsg.key.id;
    if (!messageId) return;
    const ageMs = Date.now() - timestampToMillis(waMsg.messageTimestamp);
    if (ageMs > MEDIA_AUTODOWNLOAD_MAX_AGE_MS) {
      log.debug({ jid, messageId, ageMs }, "skipping media download: message older than 7 days");
      return;
    }
    queues.enqueue(jid, async () => {
      try {
        const media = await downloadAndStore(conn, waMsg, jid);
        if (!media) return;
        mutate(jid, (cjid) => ops.setMessageMedia(cjid, messageId, media));
      } catch (err) {
        log.error({ err, jid, messageId }, "media download task failed");
      }
    });
  }

  /**
   * History-synced message keys carry no alt-jid (unlike live messages), so a
   * `@lid` chat restored from history has no way to learn its phone number
   * from messages. Baileys' signal store keeps the lid↔pn pairs delivered at
   * pairing time — resolve from there and register the pair (which merges the
   * accounts and re-keys the chat to the phone jid).
   */
  function refreshLidPhoneNumber(jid: string): void {
    const lidMapping = conn.getSocket()?.signalRepository?.lidMapping;
    if (!lidMapping) return;
    lidMapping.getPNForLID(jid).then(
      (pn) => {
        const phoneJid = pn ? jidNormalizedUser(pn) : null;
        if (!phoneJid?.endsWith("@s.whatsapp.net")) return;
        registerPairs(new Map([[jid, phoneJid]]));
      },
      (err: unknown) => log.warn({ err, jid }, "failed to resolve phone number for lid chat"),
    );
  }

  function reactionSender(senderKey: proto.IMessageKey | null | undefined): string | null {
    if (!senderKey) return null;
    if (senderKey.fromMe) {
      const me = conn.getSocket()?.user?.id;
      return me ? jidNormalizedUser(me) : null;
    }
    const candidate = senderKey.participant ?? senderKey.remoteJid ?? undefined;
    return candidate ? jidNormalizedUser(candidate) : null;
  }

  /**
   * Push-name sightings carried by message keys — for group senders and
   * individual peers alike. These are the only name source for non-contact
   * group members (history-synced messages carry none, and contacts events
   * only cover the address book); landing them on account rows retroactively
   * names that sender's old messages everywhere.
   */
  function messageObservations(waMessages: WAMessage[]): AccountObservation[] {
    const out: AccountObservation[] = [];
    for (const waMsg of waMessages) {
      if (waMsg.key.fromMe || !waMsg.pushName) continue;
      const sender = waMsg.key.participant ?? waMsg.key.remoteJid;
      if (!sender) continue;
      const alt = waMsg.key.participant ? waMsg.key.participantAlt : waMsg.key.remoteJidAlt;
      out.push({
        jids: [jidNormalizedUser(sender), alt ? jidNormalizedUser(alt) : null],
        pushName: waMsg.pushName,
      });
    }
    return out;
  }

  /**
   * Group-metadata participant names land as push names on purpose: `name`
   * here is whatever the group exposes, not the user's own address book —
   * a saved-contact name must always win at label time.
   */
  function participantObservations(raw: GroupMetadata["participants"]): AccountObservation[] {
    return raw
      .filter((p) => p.name ?? p.notify)
      .map((p) => ({
        jids: [jidNormalizedUser(p.id), p.phoneNumber ? jidNormalizedUser(p.phoneNumber) : null],
        pushName: p.name ?? p.notify ?? null,
      }));
  }

  function ingestMessages(jid: string, waMessages: WAMessage[], baseMeta: Partial<Chat>): void {
    const regular = waMessages.filter(isRegularMessage);
    const incoming = regular.map(mapWAMessage);
    observe(messageObservations(waMessages));

    if (chatTypeOf(jid) === "individual") {
      // Business accounts are rarely saved contacts, so their chats would
      // render as "Not Contact" forever; their messages carry a WhatsApp-
      // verified name, which lands on the peer account (a saved-contact name
      // still wins at label time).
      const bizName = verifiedBizNameFromMessages(waMessages);
      if (bizName != null) observe([{ jids: [jid], verifiedName: bizName }]);
      // Still keyed by `@lid` here means no message in this batch carried the
      // phone-jid pairing — recover it from Baileys' signal store.
      if (jid.endsWith("@lid")) refreshLidPhoneNumber(jid);
    }

    if (incoming.length > 0 || Object.keys(baseMeta).length > 2) {
      mutate(jid, async (cjid) => {
        await ops.upsertChatMessages(cjid, baseMeta, incoming);
        return true;
      });
    }

    for (const waMsg of waMessages) {
      const targetId = revokedTargetId(waMsg);
      if (targetId) {
        applyDeletion(jid, targetId, timestampToMillis(waMsg.messageTimestamp) || Date.now());
      }

      const editedText = editedTextOf(waMsg.message);
      const editedTargetId = editedTargetIdOf(waMsg.message) ?? waMsg.key.id;
      if (editedText != null && editedTargetId) {
        mutate(jid, (cjid) => ops.applyMessageEdit(cjid, editedTargetId, editedText));
      }

      applyEncryptedEdit(jid, waMsg);
    }

    for (const waMsg of regular) {
      if (hasMediaContent(waMsg)) scheduleMediaDownload(jid, waMsg);
      if (!waMsg.key.id) continue;
      const pending = pendingEncryptedEdits.get(encryptedEditKey(jid, waMsg.key.id));
      if (pending) applyEncryptedEdit(jid, pending);
    }
  }

  function handleHistory(payload: { chats: BaileysChat[]; contacts: Contact[]; messages: WAMessage[] }): void {
    log.debug(
      {
        chats: payload.chats.length,
        contacts: payload.contacts.length,
        messages: payload.messages.length,
      },
      "history.set received",
    );
    // History sync delivers push names as bare contacts (`{ id, notify }`) —
    // often the only name we'll ever see for non-contact group members. This
    // chunk arrives once at link time; persisting it is what keeps those
    // names across restarts.
    observe(payload.contacts.map(contactObservation));

    const { byJid: messagesByJid, aliases } = groupMessagesByJid(payload.messages);
    registerPairs(aliases);
    const jids = new Set<string>();
    for (const c of payload.chats) {
      if (c.id) jids.add(jidNormalizedUser(c.id));
    }
    for (const jid of messagesByJid.keys()) jids.add(jid);

    for (const jid of jids) {
      if (jid === STATUS_BROADCAST_JID) continue;
      const waChat = payload.chats.find((c) => c.id && jidNormalizedUser(c.id) === jid);
      const meta = waChat ? mapChat(waChat) : minimalMeta(jid);
      ingestMessages(jid, messagesByJid.get(jid) ?? [], meta);
    }
  }

  function minimalMeta(jid: string): Partial<Chat> {
    return { jid, type: chatTypeOf(jid) };
  }

  function handleMessages(payload: { messages: WAMessage[] }): void {
    const { byJid, aliases } = groupMessagesByJid(payload.messages);
    registerPairs(aliases);
    for (const [jid, waMessages] of byJid) {
      ingestMessages(jid, waMessages, minimalMeta(jid));
    }
  }

  function handleMessageUpdate(updates: WAMessageUpdate[]): void {
    for (const { key, update: patch } of updates) {
      if (!key.remoteJid || !key.id) continue;
      const jid = jidNormalizedUser(key.remoteJid);

      if (patch.messageStubType === proto.WebMessageInfo.StubType.REVOKE) {
        applyDeletion(jid, key.id, timestampToMillis(patch.messageTimestamp) || Date.now());
        continue;
      }

      const editedText = editedTextOf(patch.message);
      if (editedText != null) {
        const targetId = editedTargetIdOf(patch.message) ?? key.id;
        mutate(jid, (cjid) => ops.applyMessageEdit(cjid, targetId, editedText));
        continue;
      }

      const status = mapDeliveryStatus(patch.status);
      if (status) {
        const targetId = key.id;
        mutate(jid, (cjid) => ops.applyDeliveryReceipt(cjid, targetId, status));
      }
    }
  }

  function handleReceipts(updates: MessageUserReceiptUpdate[]): void {
    for (const { key, receipt } of updates) {
      if (!key.remoteJid || !key.id) continue;
      const jid = jidNormalizedUser(key.remoteJid);
      const status = statusFromReceipt(receipt);
      if (!status) continue;
      const targetId = key.id;
      mutate(jid, (cjid) => ops.applyDeliveryReceipt(cjid, targetId, status));
    }
  }

  function handleReaction(entries: { key: proto.IMessageKey; reaction: proto.IReaction }[]): void {
    for (const { key, reaction } of entries) {
      if (!key.remoteJid || !key.id) continue;
      const jid = jidNormalizedUser(key.remoteJid);
      const sender = reactionSender(reaction.key);
      if (!sender) continue;
      const targetId = key.id;
      const value = { emoji: reaction.text ?? "", senderJid: sender };
      mutate(jid, (cjid) => ops.applyReaction(cjid, targetId, value));
    }
  }

  function handleContacts(payload: Contact[]): void {
    log.debug({ count: payload.length }, "contacts received");
    // A contact can arrive after its chat was already persisted (events have
    // no guaranteed order). Order no longer matters: the names land on the
    // account row whenever they're seen, and `observeAccounts` announces any
    // existing chat of that peer so it never stays stuck at "Not Contact".
    observe(payload.map(contactObservation));
  }

  function handleChats(payload: BaileysChat[] | Partial<BaileysChat>[]): void {
    for (const waChat of payload) {
      if (!waChat.id) continue;
      const jid = jidNormalizedUser(waChat.id);
      if (jid === STATUS_BROADCAST_JID) continue;
      const meta = mapChat(waChat);
      mutate(jid, (cjid) => ops.mergeChatMeta(cjid, meta, true));
    }
  }

  function refreshGroupMetadata(jid: string): void {
    const sock = conn.getSocket();
    if (!sock) return;
    sock.groupMetadata(jid).then(
      (meta: GroupMetadata) => {
        registerPairs(groupParticipantAliases(meta.participants));
        observe(participantObservations(meta.participants));
        mutate(jid, (cjid) => ops.mergeChatMeta(cjid, mapGroupMetadata(meta), true));
      },
      (err: unknown) => log.warn({ err, jid }, "failed to refresh group metadata"),
    );
  }

  function handleGroups(payload: unknown): void {
    if (Array.isArray(payload)) {
      for (const meta of payload as Partial<GroupMetadata>[]) {
        if (!meta.id) continue;
        const jid = jidNormalizedUser(meta.id);
        const partial: Partial<Chat> = { jid, type: "group" };
        if (meta.subject != null) partial.groupSubject = meta.subject;
        if (meta.participants) {
          registerPairs(groupParticipantAliases(meta.participants));
          observe(participantObservations(meta.participants));
          partial.participants = mapGroupParticipants(meta.participants);
        }
        mutate(jid, (cjid) => ops.mergeChatMeta(cjid, partial, true));
      }
      return;
    }

    const evt = payload as { id?: string } | null | undefined;
    if (evt?.id) refreshGroupMetadata(jidNormalizedUser(evt.id));
  }

  conn.on("status", handleStatus);
  conn.on("history", handleHistory);
  conn.on("messages", handleMessages);
  conn.on("message-update", handleMessageUpdate);
  conn.on("receipts", handleReceipts);
  conn.on("reaction", handleReaction);
  conn.on("contacts", handleContacts);
  conn.on("chats", handleChats);
  conn.on("groups", handleGroups);

  emitter.stop = () => {
    conn.off("status", handleStatus);
    conn.off("history", handleHistory);
    conn.off("messages", handleMessages);
    conn.off("message-update", handleMessageUpdate);
    conn.off("receipts", handleReceipts);
    conn.off("reaction", handleReaction);
    conn.off("contacts", handleContacts);
    conn.off("chats", handleChats);
    conn.off("groups", handleGroups);
  };

  emitter.flush = () => queues.drain();
  emitter.refreshGroup = (jid: string) => refreshGroupMetadata(jid);

  return emitter;
}
