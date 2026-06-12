import {
  getContentType,
  jidDecode,
  jidNormalizedUser,
  normalizeMessageContent,
  proto,
  type Chat as BaileysChat,
  type Contact,
  type GroupMetadata,
  type WAMessage,
  type WAMessageContent,
} from "baileys";
import { isGroupJid, type ChatType } from "../types/chat.js";
import type {
  Chat,
  DeliveryStatus,
  Message,
  MessageDirection,
  MessageType,
  QuotedRef,
} from "../types/index.js";

/** Baileys content keys that carry downloadable media — shared by ingest (download
 * scheduling) and media (payload extraction) so the three layers can't drift. */
export const MEDIA_CONTENT_KEYS = new Set([
  "imageMessage",
  "videoMessage",
  "audioMessage",
  "documentMessage",
  "stickerMessage",
]);

type WAMessageRecord = Record<string, unknown>;

/**
 * The persisted Baileys envelope, if this message carries one. `Message.raw`
 * is `unknown` in storage; this is the single sanctioned narrowing back to
 * `WAMessage` — don't cast `raw` anywhere else.
 */
export function rawWAMessage(message: Pick<Message, "raw">): WAMessage | null {
  return (message.raw as WAMessage | null | undefined) ?? null;
}

/** protobufjs represents 64-bit ints as `Long` (number | Long-like with toNumber()).
 * After a JSON round-trip (job queue payloads, the `raw` column) the same value
 * arrives as a decimal string or a plain `{low, high, unsigned}` object. */
type LongLike =
  | number
  | string
  | { toNumber(): number }
  | { low: number; high: number; unsigned?: boolean }
  | null
  | undefined;

/** Seconds-since-epoch (number, Long, or round-tripped Long) → epoch milliseconds (0 when absent). */
export function timestampToMillis(ts: LongLike): number {
  if (ts == null) return 0;
  let n: number;
  if (typeof ts === "number") n = ts;
  else if (typeof ts === "string") n = Number(ts);
  else if ("toNumber" in ts) n = ts.toNumber();
  else n = ts.high * 4294967296 + (ts.low >>> 0);
  return Number.isFinite(n) ? n * 1000 : 0;
}

interface ContentEntry {
  key: string;
  /** Raw value for this content key — a plain string for `conversation`, an object for everything else. */
  value: unknown;
}

function contentEntry(content: WAMessageContent | undefined): ContentEntry | null {
  const key = getContentType(content);
  if (!key) return null;
  return { key, value: (content as unknown as WAMessageRecord | undefined)?.[key] };
}

/** The inner payload object for media/text-extended content keys (not `conversation`, which is a bare string). */
function innerObject(entry: ContentEntry | null): WAMessageRecord | null {
  if (entry?.value && typeof entry.value === "object") return entry.value as WAMessageRecord;
  return null;
}

/**
 * View-once messages show up two ways: wrapped in a dedicated container
 * (unwrapped already by `normalizeMessageContent`, so we check the raw
 * message for the wrapper keys) or as a `viewOnce: true` flag directly on
 * the inner media payload.
 */
function isViewOnce(waMsg: WAMessage): boolean {
  const raw = waMsg.message as WAMessageRecord | null | undefined;
  if (raw && (raw.viewOnceMessage || raw.viewOnceMessageV2 || raw.viewOnceMessageV2Extension)) {
    return true;
  }
  const entry = contentEntry(normalizeMessageContent(waMsg.message));
  return Boolean(innerObject(entry)?.viewOnce);
}

function mediaTypeForKey(key: string): MessageType | null {
  switch (key) {
    case "imageMessage":
      return "image";
    case "videoMessage":
      return "video";
    case "audioMessage":
      return "audio";
    case "documentMessage":
      return "document";
    case "stickerMessage":
      return "sticker";
    default:
      return null;
  }
}

/** Classify a message's domain `MessageType`, including view-once detection. */
export function messageType(waMsg: WAMessage): MessageType {
  const content = normalizeMessageContent(waMsg.message);
  const entry = contentEntry(content);
  if (!entry) return "other";

  if (isViewOnce(waMsg)) return "viewOnce";

  if (entry.key === "conversation" || entry.key === "extendedTextMessage") return "text";
  return mediaTypeForKey(entry.key) ?? "other";
}

function textOf(entry: ContentEntry | null): string | null {
  if (!entry) return null;
  if (entry.key === "conversation") {
    return typeof entry.value === "string" ? entry.value : null;
  }
  const inner = innerObject(entry);
  if (entry.key === "extendedTextMessage") {
    return typeof inner?.text === "string" ? inner.text : null;
  }
  return typeof inner?.caption === "string" ? inner.caption : null;
}

function typeHint(key: string): string {
  const mediaType = mediaTypeForKey(key);
  if (mediaType) return mediaType;
  if (key === "conversation" || key === "extendedTextMessage") return "text";
  return "message";
}

function snippetOf(content: proto.IMessage | null | undefined): string {
  const normalized = normalizeMessageContent(content as WAMessageContent | null | undefined);
  const entry = contentEntry(normalized);
  const text = textOf(entry);
  if (text) return text;
  if (entry) return `[${typeHint(entry.key)}]`;
  return "";
}

function mapQuoted(contextInfo: proto.IContextInfo | null | undefined): QuotedRef | null {
  if (!contextInfo?.stanzaId) return null;
  return {
    messageId: contextInfo.stanzaId,
    sender: contextInfo.participant ? jidNormalizedUser(contextInfo.participant) : null,
    snippet: snippetOf(contextInfo.quotedMessage),
  };
}

function mapReactions(reactions: proto.IReaction[] | null | undefined): { emoji: string; sender: string }[] | undefined {
  if (!reactions || reactions.length === 0) return undefined;
  const mapped = reactions
    .filter((r): r is proto.IReaction & { text: string } => Boolean(r.text))
    .map((r) => ({
      emoji: r.text,
      sender: jidNormalizedUser(r.key?.participant ?? r.key?.remoteJid ?? undefined),
    }));
  return mapped.length > 0 ? mapped : undefined;
}

/**
 * New text carried by a MESSAGE_EDIT update. Baileys delivers edits as a
 * `messages.update` whose patch message wraps the revision in `editedMessage`
 * (unwrapped by `normalizeMessageContent`). Returns null for non-edit patches.
 */
export function editedTextOf(message: unknown): string | null {
  const raw = message as proto.IMessage | null | undefined;
  const edited =
    raw?.editedMessage?.message ??
    (raw?.protocolMessage?.type === proto.Message.ProtocolMessage.Type.MESSAGE_EDIT
      ? raw.protocolMessage.editedMessage
      : null);
  if (!edited) return null;
  const content = normalizeMessageContent(edited as WAMessageContent);
  return textOf(contentEntry(content));
}

/** Target id carried by a legacy protocol edit; future-proof editedMessage wrappers reuse the WAMessage key id. */
export function editedTargetIdOf(message: unknown): string | null {
  const raw = message as proto.IMessage | null | undefined;
  if (raw?.protocolMessage?.type !== proto.Message.ProtocolMessage.Type.MESSAGE_EDIT) return null;
  return raw.protocolMessage.key?.id ?? null;
}

export function mapDeliveryStatus(status: proto.WebMessageInfo.Status | null | undefined): DeliveryStatus | null {
  switch (status) {
    case proto.WebMessageInfo.Status.ERROR:
      return "failed";
    case proto.WebMessageInfo.Status.PENDING:
      return "pending";
    case proto.WebMessageInfo.Status.SERVER_ACK:
      return "sent";
    case proto.WebMessageInfo.Status.DELIVERY_ACK:
      return "delivered";
    case proto.WebMessageInfo.Status.READ:
    case proto.WebMessageInfo.Status.PLAYED:
      return "read";
    default:
      return null;
  }
}

function senderOf(waMsg: WAMessage): { jid: string | null; name: string | null } {
  if (waMsg.key.fromMe) return { jid: null, name: null };
  const candidate = waMsg.key.participant ?? waMsg.participant ?? waMsg.key.remoteJid ?? undefined;
  return {
    jid: candidate ? jidNormalizedUser(candidate) : null,
    name: waMsg.pushName ?? null,
  };
}

/** Map a raw Baileys `WAMessage` into our domain `Message`. The media field is
 * left null here — `media.ts` fills it in once the bytes are downloaded. */
export function mapWAMessage(waMsg: WAMessage): Message {
  const content = normalizeMessageContent(waMsg.message);
  const entry = contentEntry(content);
  const direction: MessageDirection = waMsg.key.fromMe ? "outbound" : "inbound";
  const { jid: senderJid, name: senderName } = senderOf(waMsg);
  const contextInfo = (innerObject(entry)?.contextInfo ?? null) as proto.IContextInfo | null;

  return {
    id: waMsg.key.id ?? "",
    senderJid,
    senderName,
    direction,
    timestamp: timestampToMillis(waMsg.messageTimestamp) || Date.now(),
    type: messageType(waMsg),
    text: textOf(entry),
    media: null,
    quoted: mapQuoted(contextInfo),
    deliveryStatus: direction === "outbound" ? mapDeliveryStatus(waMsg.status) : null,
    deleted: false,
    deletedAt: null,
    reactions: mapReactions((waMsg as unknown as { reactions?: proto.IReaction[] | null }).reactions),
    raw: waMsg,
  };
}

/**
 * Derive a human phone number from a JID. Only the phone-number address space
 * (`@s.whatsapp.net`) carries a real number — a `@lid` ("linked ID", WhatsApp's
 * anonymous addressing) decodes to an opaque routing id, never a dialable
 * number, so we must not present it as one.
 */
export function phoneNumberFromJid(jid: string): string | null {
  if (isGroupJid(jid)) return null;
  const decoded = jidDecode(jid);
  // user "0" is WhatsApp's official service account (PSA), not a dialable number
  if (!decoded?.user || decoded.user === "0" || decoded.server === "lid") return null;
  return `+${decoded.user}`;
}

/**
 * Recover a business account's display name from its message stanzas. Unlike
 * push names, `verifiedBizName` is verified by WhatsApp (it's what the phone
 * shows for businesses like "WhatsApp" or carriers), so it's safe to display
 * for a chat that has no saved-contact name.
 */
export function verifiedBizNameFromMessages(waMessages: WAMessage[]): string | null {
  for (const waMsg of waMessages) {
    if (waMsg.key.fromMe) continue;
    if (waMsg.verifiedBizName) return waMsg.verifiedBizName;
  }
  return null;
}

/**
 * Map a Baileys chat (history sync / upsert / update) into a partial domain
 * `Chat`. Names and phone numbers deliberately don't appear here — they live
 * on the peer's accounts row (written via `chatOps.observeAccounts`) and are
 * derived at load time; a chat row carries pure conversation state only.
 */
export function mapChat(waChat: Partial<BaileysChat>): Partial<Chat> {
  const rawJid = waChat.id;
  if (!rawJid) return {};
  const jid = jidNormalizedUser(rawJid);
  const type: ChatType = isGroupJid(jid) ? "group" : "individual";

  const partial: Partial<Chat> = { jid, type };

  // Groups title by their subject (`waChat.name`); for individual chats
  // `waChat.name` is the peer's push name whenever they aren't a saved
  // contact, so it never lands anywhere from here.
  if (type === "group") partial.groupSubject = waChat.name ?? null;
  if (waChat.archived != null) partial.archived = waChat.archived;

  const lastActivity = Math.max(
    timestampToMillis(waChat.conversationTimestamp),
    timestampToMillis(waChat.lastMsgTimestamp),
    timestampToMillis((waChat as { lastMessageRecvTimestamp?: number }).lastMessageRecvTimestamp),
  );
  if (lastActivity > 0) partial.lastActivity = lastActivity;

  return partial;
}

function isAdminOf(p: GroupMetadata["participants"][number]): boolean | undefined {
  if (p.isAdmin || p.isSuperAdmin) return true;
  if (p.admin === "admin" || p.admin === "superadmin") return true;
  return undefined;
}

/** Map Baileys group participants into domain `GroupParticipant`s. */
export function mapGroupParticipants(participants: GroupMetadata["participants"]): Chat["participants"] {
  return participants.map((p) => ({
    jid: jidNormalizedUser(p.id),
    displayName: p.name ?? p.notify ?? null,
    isAdmin: isAdminOf(p),
  }));
}

/**
 * lid → phone-jid pairs carried by group metadata. In lid-addressed groups
 * each participant's `id` is its `@lid` address and `phoneNumber` its real
 * phone jid — the pairing that lets group sender labels resolve to a contact
 * name or number instead of the raw lid.
 */
export function groupParticipantAliases(participants: GroupMetadata["participants"]): Map<string, string> {
  const aliases = new Map<string, string>();
  for (const p of participants) {
    if (!p.phoneNumber) continue;
    const lid = jidNormalizedUser(p.id);
    const pn = jidNormalizedUser(p.phoneNumber);
    if (lid.endsWith("@lid") && pn.endsWith("@s.whatsapp.net")) aliases.set(lid, pn);
  }
  return aliases;
}

/** Map full group metadata (subject + participants) into a partial domain `Chat`. */
export function mapGroupMetadata(meta: GroupMetadata): Partial<Chat> {
  const jid = jidNormalizedUser(meta.id);
  return {
    jid,
    type: "group",
    groupSubject: meta.subject,
    participants: mapGroupParticipants(meta.participants),
  };
}
