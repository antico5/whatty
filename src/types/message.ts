export type MessageDirection = "inbound" | "outbound";

export type MessageType =
  | "text"
  | "image"
  | "video"
  | "audio"
  | "document"
  | "sticker"
  | "viewOnce"
  | "other";

export type DeliveryStatus = "pending" | "sent" | "delivered" | "read" | "failed";

export interface MediaRef {
  relativePath: string;
  mimeType: string | null;
  fileName: string | null;
}

export interface QuotedRef {
  messageId: string;
  /** Raw sender jid on the way into the store; resolved display label (or "You") on the way out. */
  sender: string | null;
  /** Sender's accounts-table id, set by the store at load so re-saving an aggregate stays lossless. */
  senderAccountId?: number | null;
  snippet: string;
}

export interface Message {
  id: string;
  /** Raw sender jid on the way into the store; the sender account's preferred (phone-first) jid on the way out. */
  senderJid: string | null;
  /** Push name on the way into the store (landed on the sender's account row, not persisted per-message);
   * resolved display label on the way out (group inbound only). */
  senderName: string | null;
  direction: MessageDirection;
  timestamp: number;
  type: MessageType;
  text: string | null;
  media: MediaRef | null;
  /** Media download failed permanently (server 410/403 — the blob is gone from
   * WhatsApp's CDN). Mutually exclusive with `media` in practice; the UI shows
   * an "unavailable" hint and stops trying to fetch it. */
  mediaUnavailable?: boolean;
  quoted: QuotedRef | null;
  deliveryStatus: DeliveryStatus | null;
  deleted: boolean;
  deletedAt: number | null;
  /** Text was replaced by a later MESSAGE_EDIT — rendered as "(edited)". Optional so pre-existing persisted messages need no migration. */
  edited?: boolean;
  /** Derived at load (never persisted): `@`-mention jids resolved to display labels,
   * so the UI can substitute `@<digits>` tokens — lid digits aren't phone numbers. */
  mentions?: { jid: string; label: string }[];
  reactions?: { emoji: string; sender: string }[];
  raw: unknown;
}
