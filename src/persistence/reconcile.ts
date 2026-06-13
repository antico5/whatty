import {
  createEmptyChat,
  isGroupJid,
  type Chat,
  type DeliveryStatus,
  type GroupParticipant,
  type Message,
} from "../types/index.js";

const DELIVERY_ORDER: DeliveryStatus[] = ["pending", "sent", "delivered", "read"];

/**
 * Forward-only progression along pending → sent → delivered → read.
 * `failed` is terminal once reached. WhatsApp can reject a message after
 * Baileys has returned it from sendMessage, so an ERROR update must override
 * both pending and sent. A delivered/read message has definitively arrived and
 * cannot be downgraded by a stale error.
 */
export function advanceDeliveryStatus(
  local: DeliveryStatus | null,
  incoming: DeliveryStatus | null,
): DeliveryStatus | null {
  if (incoming == null) return local;
  if (local == null) return incoming;
  if (local === incoming) return local;
  if (local === "failed") return local;
  if (incoming === "failed") {
    return local === "pending" || local === "sent" ? incoming : local;
  }
  const localRank = DELIVERY_ORDER.indexOf(local);
  const incomingRank = DELIVERY_ORDER.indexOf(incoming);
  return incomingRank > localRank ? incoming : local;
}

function isEmptyRaw(raw: unknown): boolean {
  if (raw == null) return true;
  if (typeof raw === "object") return Object.keys(raw as object).length === 0;
  return false;
}

function rawHasMessageSecret(raw: unknown): boolean {
  const message = (raw as { message?: { messageContextInfo?: { messageSecret?: unknown } } } | null)?.message;
  return message?.messageContextInfo?.messageSecret != null;
}

function unionReactions(
  a: { emoji: string; sender: string }[] | undefined,
  b: { emoji: string; sender: string }[] | undefined,
): { emoji: string; sender: string }[] | undefined {
  if (!a && !b) return undefined;
  const byKey = new Map<string, { emoji: string; sender: string }>();
  for (const r of [...(a ?? []), ...(b ?? [])]) {
    byKey.set(`${r.sender}:${r.emoji}`, r);
  }
  return Array.from(byKey.values());
}

function mergeParticipants(
  local: GroupParticipant[],
  incoming: GroupParticipant[] | undefined,
): GroupParticipant[] {
  if (!incoming || incoming.length === 0) return local;
  const byJid = new Map(local.map((p): [string, GroupParticipant] => [p.jid, p]));
  for (const p of incoming) {
    const existing = byJid.get(p.jid);
    byJid.set(p.jid, {
      jid: p.jid,
      displayName: p.displayName ?? existing?.displayName ?? null,
      isAdmin: p.isAdmin ?? existing?.isAdmin,
    });
  }
  return Array.from(byJid.values());
}

function newestMessageTimestamp(messages: Message[]): number {
  return messages.reduce((max, m) => Math.max(max, m.timestamp), 0);
}

/**
 * Merge incoming chat metadata into a local record. Never null-out an
 * existing non-null field just because incoming lacks it — only apply
 * incoming values that are actually present (non-nullish).
 */
export function mergeChatMeta(local: Chat | null, incoming: Partial<Chat>): Chat {
  const jid = local?.jid ?? incoming.jid;
  if (!jid) throw new Error("mergeChatMeta: need a jid from local or incoming");
  const type = local?.type ?? incoming.type ?? (isGroupJid(jid) ? "group" : "individual");
  const base = local ?? createEmptyChat(jid, type);

  const merged: Chat = {
    ...base,
    displayName: incoming.displayName ?? base.displayName,
    phoneNumber: incoming.phoneNumber ?? base.phoneNumber,
    groupSubject: incoming.groupSubject ?? base.groupSubject,
    participants: mergeParticipants(base.participants, incoming.participants),
    archived: incoming.archived ?? base.archived,
    unreadCount: incoming.unreadCount ?? base.unreadCount,
  };

  merged.lastActivity = Math.max(
    base.lastActivity,
    incoming.lastActivity ?? 0,
    newestMessageTimestamp(base.messages),
  );

  return merged;
}

function mergeMessage(local: Message, incoming: Message): Message {
  const textChanged =
    local.text != null &&
    incoming.text != null &&
    local.text !== incoming.text;

  return {
    ...local,
    senderJid: local.senderJid ?? incoming.senderJid,
    senderName: local.senderName ?? incoming.senderName,
    type: local.type === "other" ? incoming.type : local.type,
    text: textChanged ? incoming.text : (local.text ?? incoming.text),
    media: local.media ?? incoming.media,
    quoted: local.quoted ?? incoming.quoted,
    deliveryStatus:
      local.direction === "outbound"
        ? advanceDeliveryStatus(local.deliveryStatus, incoming.deliveryStatus)
        : (local.deliveryStatus ?? incoming.deliveryStatus),
    deleted: local.deleted || incoming.deleted,
    deletedAt: local.deletedAt ?? incoming.deletedAt,
    edited: local.edited || incoming.edited || textChanged,
    reactions: unionReactions(local.reactions, incoming.reactions),
    raw:
      isEmptyRaw(local.raw) || (!rawHasMessageSecret(local.raw) && rawHasMessageSecret(incoming.raw))
        ? incoming.raw
        : local.raw,
  };
}

function compareMessages(a: Message, b: Message): number {
  if (a.timestamp !== b.timestamp) return a.timestamp - b.timestamp;
  if (a.id < b.id) return -1;
  if (a.id > b.id) return 1;
  return 0;
}

/**
 * Merge by message id: existing ids are field-merged (never discarding
 * locally-held data), new ids are appended. Result sorted ascending by
 * timestamp, then id, for stable ordering.
 */
export function mergeMessages(local: Message[], incoming: Message[]): Message[] {
  const byId = new Map(local.map((m): [string, Message] => [m.id, m]));
  for (const msg of incoming) {
    const existing = byId.get(msg.id);
    byId.set(msg.id, existing ? mergeMessage(existing, msg) : msg);
  }
  return Array.from(byId.values()).sort(compareMessages);
}

export function tombstone(messageId: string, deletedAt: number): Message {
  return {
    id: messageId,
    senderJid: null,
    senderName: null,
    direction: "inbound",
    timestamp: deletedAt,
    type: "other",
    text: null,
    media: null,
    quoted: null,
    deliveryStatus: null,
    deleted: true,
    deletedAt,
    raw: null,
  };
}

/**
 * Mark a message as deleted in place; original content is retained. If the
 * message isn't known locally, create a minimal tombstone so the deletion
 * itself is never lost.
 */
export function applyMessageDeletion(chat: Chat, messageId: string, deletedAt: number): Chat {
  const idx = chat.messages.findIndex((m) => m.id === messageId);
  if (idx === -1) {
    return { ...chat, messages: mergeMessages(chat.messages, [tombstone(messageId, deletedAt)]) };
  }

  const existing = chat.messages[idx]!;
  if (existing.deleted) return chat;

  const messages = [...chat.messages];
  messages[idx] = { ...existing, deleted: true, deletedAt };
  return { ...chat, messages };
}

/**
 * Replace a message's text with its edited revision, in place — original
 * timestamp and position are kept, the message is flagged so the UI can mark
 * it "(edited)". Unknown ids are ignored: there's nothing locally to edit.
 */
export function applyMessageEdit(chat: Chat, messageId: string, text: string): Chat {
  const idx = chat.messages.findIndex((m) => m.id === messageId);
  if (idx === -1) return chat;

  const existing = chat.messages[idx]!;
  if (existing.edited && existing.text === text) return chat;

  const messages = [...chat.messages];
  messages[idx] = { ...existing, text, edited: true };
  return { ...chat, messages };
}

/** Forward-only delivery-status update for an outbound message. */
export function applyDeliveryReceipt(chat: Chat, messageId: string, status: DeliveryStatus): Chat {
  const idx = chat.messages.findIndex((m) => m.id === messageId);
  if (idx === -1) return chat;

  const existing = chat.messages[idx]!;
  if (existing.direction !== "outbound") return chat;

  const next = advanceDeliveryStatus(existing.deliveryStatus, status);
  if (next === existing.deliveryStatus) return chat;

  const messages = [...chat.messages];
  messages[idx] = { ...existing, deliveryStatus: next };
  return { ...chat, messages };
}

/**
 * Apply an incoming reaction to a known message: WhatsApp allows at most one
 * reaction per sender per message, so a new one replaces any prior reaction
 * from the same sender, and an empty emoji removes it. Unknown target ids are
 * ignored — there's nothing locally to attach the reaction to.
 */
export function applyReaction(
  chat: Chat,
  targetMessageId: string,
  reaction: { emoji: string; sender: string },
): Chat {
  const idx = chat.messages.findIndex((m) => m.id === targetMessageId);
  if (idx === -1) return chat;

  const existing = chat.messages[idx]!;
  const withoutSender = (existing.reactions ?? []).filter((r) => r.sender !== reaction.sender);
  const reactions = reaction.emoji ? [...withoutSender, reaction] : withoutSender;

  const messages = [...chat.messages];
  messages[idx] = { ...existing, reactions: reactions.length > 0 ? reactions : undefined };
  return { ...chat, messages };
}

export function upsertChat(
  local: Chat | null,
  incomingMeta: Partial<Chat>,
  incomingMessages: Message[],
): Chat {
  const metaMerged = mergeChatMeta(local, incomingMeta);
  const messages = mergeMessages(metaMerged.messages, incomingMessages);
  return {
    ...metaMerged,
    messages,
    lastActivity: Math.max(metaMerged.lastActivity, newestMessageTimestamp(messages)),
  };
}
