import {
  getContentType,
  jidNormalizedUser,
  normalizeMessageContent,
  proto,
  type Contact,
  type GroupMetadata,
  type WAMessage,
} from "baileys";
import { chatOps } from "../../persistence/chatStore.js";
import { getActiveDb } from "../../persistence/db.js";
import { sanitizeForFilename } from "../../persistence/mediaStore.js";
import { accountById, preferredJid, selfAccountId, type AccountObservation } from "../../persistence/peerStore.js";
import { chatTypeOf, type Chat, type DeliveryStatus } from "../../types/index.js";
import type { Connection } from "../../whatsapp/connection.js";
import { encryptedEditOf } from "../../whatsapp/edits.js";
import { MEDIA_CONTENT_KEYS } from "../../whatsapp/mappers.js";
import type { DataChange } from "../types.js";

/** Pure helpers shared by the job handlers — moved verbatim from the old ingestor. */

export const STATUS_BROADCAST_JID = "status@broadcast";

/**
 * Window for *eager* media auto-download. History syncs on a fresh device link
 * can span years; downloading all of that eagerly wastes disk and bandwidth, so
 * messages older than 7 days are not fetched automatically — their `media` field
 * stays `null` and the chat view shows a "not downloaded" hint. Scrolling such a
 * message into view triggers an on-demand download regardless of age (the
 * `force` path in `download-media`), which is why the gate lives only on the
 * eager path. WhatsApp media URLs expire within a similar window, so a forced
 * fetch of very old media may still fail server-side.
 */
export const MEDIA_AUTODOWNLOAD_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export interface GroupedMessages {
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
export function groupMessagesByJid(messages: WAMessage[]): GroupedMessages {
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
export function isRegularMessage(waMsg: WAMessage): boolean {
  if (waMsg.messageStubType === proto.WebMessageInfo.StubType.REVOKE) return false;
  if (encryptedEditOf(waMsg)) return false;
  if (waMsg.message?.editedMessage || waMsg.message?.protocolMessage || waMsg.message?.reactionMessage) return false;
  const key = getContentType(normalizeMessageContent(waMsg.message));
  // A message that has a body but resolves to no displayable content type is a
  // pure protocol artifact — most often a `senderKeyDistributionMessage` that
  // Baileys split into its own `<id>-N` stanza. Persisting it stamps a blank
  // duplicate row beside the real message. (An empty envelope with *no* body —
  // e.g. an unavailable view-once or a system stub — is left alone.)
  if (waMsg.message && !key) return false;
  return key !== "protocolMessage" && key !== "reactionMessage";
}

export function hasMediaContent(waMsg: WAMessage): boolean {
  const key = getContentType(normalizeMessageContent(waMsg.message));
  return key != null && MEDIA_CONTENT_KEYS.has(key);
}

export function revokedTargetId(waMsg: WAMessage): string | null {
  if (waMsg.messageStubType !== proto.WebMessageInfo.StubType.REVOKE) return null;
  return waMsg.key.id ?? null;
}

export function statusFromReceipt(receipt: proto.IUserReceipt): DeliveryStatus | null {
  if (receipt.playedTimestamp != null || receipt.readTimestamp != null) return "read";
  if (receipt.receiptTimestamp != null) return "delivered";
  return null;
}

export function minimalMeta(jid: string): Partial<Chat> {
  return { jid, type: chatTypeOf(jid) };
}

/** Everything a contact event tells us about one person, as an observation. */
export function contactObservation(c: Contact): AccountObservation {
  return {
    jids: [c.id, c.lid, c.phoneNumber].filter(Boolean).map((j) => jidNormalizedUser(j!)),
    pushName: c.notify ?? null,
    // Only trustworthy names become contact/verified names: `name` is the
    // user's own address-book entry, `verifiedName` is WhatsApp-verified.
    contactName: c.name ?? null,
    verifiedName: c.verifiedName ?? null,
  };
}

export function messageObservations(waMessages: WAMessage[]): AccountObservation[] {
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
export function participantObservations(raw: GroupMetadata["participants"]): AccountObservation[] {
  return raw
    .filter((p) => p.name ?? p.notify)
    .map((p) => ({
      jids: [jidNormalizedUser(p.id), p.phoneNumber ? jidNormalizedUser(p.phoneNumber) : null],
      pushName: p.name ?? p.notify ?? null,
    }));
}

/**
 * Land name/identity sightings on persistent account rows. Returns the
 * affected chat jids as a `DataChange` (empty when nothing usable changed).
 */
export async function observeAccounts(observations: AccountObservation[]): Promise<DataChange[]> {
  const usable = observations.filter((o) => {
    const jids = o.jids.filter(Boolean);
    if (jids.length === 0) return false;
    return jids.length > 1 || o.pushName != null || o.contactName != null || o.verifiedName != null;
  });
  if (usable.length === 0) return [];
  const affected = await chatOps.observeAccounts(usable);
  return affected.length > 0 ? [{ table: "accounts", jids: affected }] : [];
}

/**
 * Register lid ↔ phone-jid pairs. Pairing may merge two account rows (and
 * fold duplicate individual chats) and re-keys the chat to the phone jid;
 * every affected jid is announced so subscribers reload it — including a
 * now-orphaned lid-keyed list entry, which the reload drops.
 */
export async function registerPairs(aliases: Map<string, string>): Promise<DataChange[]> {
  const affected = new Set<string>();
  for (const [lid, pn] of aliases) {
    for (const jid of await chatOps.registerJidPair(lid, pn)) affected.add(jid);
  }
  return affected.size > 0 ? [{ table: "accounts", jids: [...affected] }] : [];
}

/**
 * Our own jid, replay-safe: during offline job replay the socket is gone, but
 * the self account row survives in the DB. Socket is the fallback for the very
 * first session, before any identity landed.
 */
export async function resolveSelfJid(conn: Connection): Promise<string | null> {
  try {
    const db = await getActiveDb();
    const self = accountById(db, selfAccountId(db));
    const jid = self ? preferredJid(self) : null;
    if (jid) return jid;
  } catch {
    // fall through to the socket
  }
  const id = conn.getSocket()?.user?.id;
  return id ? jidNormalizedUser(id) : null;
}

export function mediaJobName(jid: string, messageId: string): string {
  return `media-${sanitizeForFilename(jid)}-${sanitizeForFilename(messageId)}`;
}

export function encryptedEditJobName(jid: string, targetId: string): string {
  return `enc-edit-${sanitizeForFilename(jid)}-${sanitizeForFilename(targetId)}`;
}

export function refreshGroupJobName(jid: string): string {
  return `refresh-group-${sanitizeForFilename(jid)}`;
}
