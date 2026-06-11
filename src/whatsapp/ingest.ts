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
import { loadChat as defaultLoadChat, saveChat as defaultSaveChat } from "../persistence/chatStore.js";
import {
  applyDeliveryReceipt,
  applyMessageDeletion,
  applyMessageEdit,
  applyReaction,
  mergeChatMeta,
  upsertChat,
} from "../persistence/reconcile.js";
import { chatTypeOf, createEmptyChat, minimalChatMeta, type Chat, type DeliveryStatus, type MediaRef } from "../types/index.js";
import { createSerialQueues } from "../util/serialQueues.js";
import type { Connection, ConnectionStatus } from "./connection.js";
import { decryptEncryptedEdit, encryptedEditOf } from "./edits.js";
import { getLogger } from "./logger.js";
import { downloadAndStore as defaultDownloadAndStore } from "./media.js";
import {
  editedTargetIdOf,
  editedTextOf,
  mapChat,
  mapContact,
  mapDeliveryStatus,
  mapGroupMetadata,
  mapGroupParticipants,
  mapWAMessage,
  MEDIA_CONTENT_KEYS,
  phoneNumberFromJid,
  phoneNumberFromMessages,
  timestampToMillis,
  verifiedBizNameFromMessages,
} from "./mappers.js";

export interface IngestorDeps {
  loadChat: (jid: string) => Promise<Chat | null>;
  saveChat: (chat: Chat) => Promise<void>;
  downloadAndStore: (conn: Connection, waMsg: WAMessage, jid: string) => Promise<MediaRef | null>;
}

export interface Ingestor extends EventEmitter {
  stop(): void;
  /** Resolves once every queued chat write has settled — for clean shutdown ("flush pending saves"). */
  flush(): Promise<void>;
}

function groupMessagesByJid(messages: WAMessage[]): Map<string, WAMessage[]> {
  const byJid = new Map<string, WAMessage[]>();
  for (const m of messages) {
    if (!m.key.remoteJid) continue;
    const jid = jidNormalizedUser(m.key.remoteJid);
    const list = byJid.get(jid);
    if (list) list.push(m);
    else byJid.set(jid, [m]);
  }
  return byJid;
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
  const loadChat = deps.loadChat ?? defaultLoadChat;
  const saveChat = deps.saveChat ?? defaultSaveChat;
  const downloadAndStore = deps.downloadAndStore ?? defaultDownloadAndStore;
  const log = getLogger().child({ module: "ingest" });
  const emitter = new EventEmitter() as Ingestor;

  const contacts = new Map<string, Contact>();
  const queues = createSerialQueues();
  const pendingEncryptedEdits = new Map<string, WAMessage>();
  const requestedEditHistory = new Set<string>();

  /**
   * Field-merge two records for the same contact, with the incoming value
   * winning only when present. History sync emits a bland chat-derived contact
   * (`{ id, name: undefined }`) alongside the real address-book contact; a blind
   * overwrite would let that empty record clobber a known name, so we merge
   * instead and never let a nullish field erase an existing one.
   */
  function mergeContacts(a: Contact, b: Contact): Contact {
    return {
      ...a,
      ...b,
      id: b.id ?? a.id,
      lid: b.lid ?? a.lid,
      phoneNumber: b.phoneNumber ?? a.phoneNumber,
      name: b.name ?? a.name,
      notify: b.notify ?? a.notify,
      verifiedName: b.verifiedName ?? a.verifiedName,
      imgUrl: b.imgUrl ?? a.imgUrl,
      status: b.status ?? a.status,
    };
  }

  /**
   * Index a contact under every identifier it carries — its `id`, its `@lid`
   * (anonymous) address, and its `@s.whatsapp.net` (phone) address. WhatsApp now
   * keys many chats by `@lid` while contacts may report the phone jid (or vice
   * versa); indexing all of them lets `mapChat` resolve a name regardless of
   * which address space the chat is keyed by. Merges into any existing record so
   * a later, sparser sighting of the same contact never wipes a known name.
   */
  function indexContact(c: Contact): void {
    for (const key of [c.id, c.lid, c.phoneNumber]) {
      if (!key) continue;
      const k = jidNormalizedUser(key);
      const existing = contacts.get(k);
      contacts.set(k, existing ? mergeContacts(existing, c) : c);
    }
  }

  /** Load → mutate → save → notify, serialized per-jid so concurrent events can't race writes to chats.json. */
  function update(jid: string, mutate: (local: Chat | null) => Chat | null): void {
    queues.enqueue(jid, async () => {
      try {
        const local = await loadChat(jid);
        const next = mutate(local);
        if (!next) return;
        await saveChat(next);
        emitter.emit("chat-updated", jid);
      } catch (err) {
        log.error({ err, jid }, "failed to persist chat update");
      }
    });
  }

  function applyDeletion(jid: string, targetId: string, deletedAt: number): void {
    update(jid, (local) => applyMessageDeletion(local ?? createEmptyChat(jid, chatTypeOf(jid)), targetId, deletedAt));
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
    update(jid, (local) => {
      if (!local) return null;
      const original = local.messages.find((message) => message.id === encryptedEdit.targetId);
      if (!original) {
        requestEditHistory(jid, encryptedEdit.targetId, [
          { key: waMsg.key, timestamp: waMsg.messageTimestamp },
          { key: targetKey ?? waMsg.key, timestamp: waMsg.messageTimestamp },
        ]);
        return null;
      }
      const originalRaw = original.raw as WAMessage | null | undefined;
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
          return null;
        }
        pendingEncryptedEdits.delete(key);
        requestedEditHistory.delete(key);
        return applyMessageEdit(local, encryptedEdit.targetId, text);
      } catch (err) {
        requestEditHistory(jid, encryptedEdit.targetId, historyRequests);
        log.warn({ err, jid, targetId: encryptedEdit.targetId }, "failed to decrypt encrypted message edit");
        return null;
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
    if (status !== "open" || pendingEncryptedEdits.size === 0) return;
    requestedEditHistory.clear();
    for (const [key, envelope] of [...pendingEncryptedEdits]) {
      applyEncryptedEdit(key.slice(0, key.indexOf("\0")), envelope);
    }
  }

  function scheduleMediaDownload(jid: string, waMsg: WAMessage): void {
    const messageId = waMsg.key.id;
    if (!messageId) return;
    queues.enqueue(jid, async () => {
      try {
        const media = await downloadAndStore(conn, waMsg, jid);
        if (!media) return;
        update(jid, (local) => {
          if (!local) return null;
          const idx = local.messages.findIndex((m) => m.id === messageId);
          if (idx === -1 || local.messages[idx]!.media) return null;
          const messages = [...local.messages];
          messages[idx] = { ...messages[idx]!, media };
          return { ...local, messages };
        });
      } catch (err) {
        log.error({ err, jid, messageId }, "media download task failed");
      }
    });
  }

  /**
   * History-synced message keys carry no alt-jid (unlike live messages), so a
   * `@lid` chat restored from history has no way to learn its phone number
   * from messages. Baileys' signal store keeps the lid↔pn pairs delivered at
   * pairing time — resolve from there and merge the number in.
   */
  function refreshLidPhoneNumber(jid: string): void {
    const lidMapping = conn.getSocket()?.signalRepository?.lidMapping;
    if (!lidMapping) return;
    lidMapping.getPNForLID(jid).then(
      (pn) => {
        const phoneNumber = pn ? phoneNumberFromJid(jidNormalizedUser(pn)) : null;
        if (!phoneNumber) return;
        update(jid, (local) => (local ? mergeChatMeta(local, { jid, phoneNumber }) : null));
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

  function ingestMessages(jid: string, waMessages: WAMessage[], baseMeta: Partial<Chat>): void {
    const regular = waMessages.filter(isRegularMessage);
    const incoming = regular.map(mapWAMessage);

    const meta = { ...baseMeta };
    // A `@lid`-keyed chat carries no number of its own; inbound message keys
    // do (their alt-jid), so harvest it whenever the chat meta lacks one.
    if (chatTypeOf(jid) === "individual" && meta.phoneNumber == null) {
      const phoneNumber = phoneNumberFromMessages(waMessages);
      if (phoneNumber != null) meta.phoneNumber = phoneNumber;
      else if (jid.endsWith("@lid")) refreshLidPhoneNumber(jid);
    }
    // Business accounts are rarely saved contacts, so their chats would render
    // as "Not Contact" forever; their messages carry a WhatsApp-verified name.
    // Only fills a missing name — a saved-contact name always wins.
    const bizName =
      chatTypeOf(jid) === "individual" && baseMeta.displayName == null
        ? verifiedBizNameFromMessages(waMessages)
        : null;

    if (incoming.length > 0 || Object.keys(meta).length > 2 || bizName != null) {
      update(jid, (local) => {
        const withBiz =
          bizName != null && local?.displayName == null ? { ...meta, displayName: bizName } : meta;
        return upsertChat(local, withBiz, incoming);
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
        update(jid, (local) => (local ? applyMessageEdit(local, editedTargetId, editedText) : null));
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
    for (const c of payload.contacts) indexContact(c);

    const messagesByJid = groupMessagesByJid(payload.messages);
    const jids = new Set<string>();
    for (const c of payload.chats) {
      if (c.id) jids.add(jidNormalizedUser(c.id));
    }
    for (const jid of messagesByJid.keys()) jids.add(jid);

    for (const jid of jids) {
      const waChat = payload.chats.find((c) => c.id && jidNormalizedUser(c.id) === jid);
      const meta = waChat ? mapChat(waChat, contacts) : minimalChatMeta(jid);
      ingestMessages(jid, messagesByJid.get(jid) ?? [], meta);
    }
  }

  function handleMessages(payload: { messages: WAMessage[] }): void {
    const byJid = groupMessagesByJid(payload.messages);
    for (const [jid, waMessages] of byJid) {
      ingestMessages(jid, waMessages, minimalChatMeta(jid));
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
        update(jid, (local) => (local ? applyMessageEdit(local, targetId, editedText) : null));
        continue;
      }

      const status = mapDeliveryStatus(patch.status);
      if (status) {
        const targetId = key.id;
        update(jid, (local) => (local ? applyDeliveryReceipt(local, targetId, status) : null));
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
      update(jid, (local) => (local ? applyDeliveryReceipt(local, targetId, status) : null));
    }
  }

  function handleReaction(entries: { key: proto.IMessageKey; reaction: proto.IReaction }[]): void {
    for (const { key, reaction } of entries) {
      if (!key.remoteJid || !key.id) continue;
      const jid = jidNormalizedUser(key.remoteJid);
      const sender = reactionSender(reaction.key);
      if (!sender) continue;
      const targetId = key.id;
      const value = { emoji: reaction.text ?? "", sender };
      update(jid, (local) => (local ? applyReaction(local, targetId, value) : null));
    }
  }

  function handleContacts(payload: Contact[]): void {
    log.debug({ count: payload.length }, "contacts received");
    for (const c of payload) {
      indexContact(c);
      // A contact can arrive after its chat was already persisted (events have
      // no guaranteed order). Push the name/number onto every chat the contact
      // might be keyed under so a chat never stays stuck at "Not Contact" — but
      // only onto chats that already exist (don't conjure chats from contacts).
      const meta = mapContact(c);
      if (meta.displayName == null && meta.phoneNumber == null) continue;
      for (const key of [c.id, c.lid, c.phoneNumber]) {
        if (!key) continue;
        const jid = jidNormalizedUser(key);
        update(jid, (local) => (local ? mergeChatMeta(local, { ...meta, jid }) : null));
      }
    }
  }

  function handleChats(payload: BaileysChat[] | Partial<BaileysChat>[]): void {
    for (const waChat of payload) {
      if (!waChat.id) continue;
      const jid = jidNormalizedUser(waChat.id);
      const meta = mapChat(waChat, contacts);
      update(jid, (local) => mergeChatMeta(local, meta));
    }
  }

  function refreshGroupMetadata(jid: string): void {
    const sock = conn.getSocket();
    if (!sock) return;
    sock.groupMetadata(jid).then(
      (meta: GroupMetadata) => update(jid, (local) => mergeChatMeta(local, mapGroupMetadata(meta))),
      (err: unknown) => log.warn({ err, jid }, "failed to refresh group metadata"),
    );
  }

  function handleGroups(payload: unknown): void {
    if (Array.isArray(payload)) {
      for (const meta of payload as Partial<GroupMetadata>[]) {
        if (!meta.id) continue;
        const jid = jidNormalizedUser(meta.id);
        const partial: Partial<Chat> = { jid, type: "group" };
        if (meta.subject != null) {
          partial.displayName = meta.subject;
          partial.groupSubject = meta.subject;
        }
        if (meta.participants) partial.participants = mapGroupParticipants(meta.participants);
        update(jid, (local) => mergeChatMeta(local, partial));
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

  return emitter;
}
