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
  sender: string | null;
  snippet: string;
}

export interface Message {
  id: string;
  senderJid: string | null;
  senderName: string | null;
  direction: MessageDirection;
  timestamp: number;
  type: MessageType;
  text: string | null;
  media: MediaRef | null;
  quoted: QuotedRef | null;
  deliveryStatus: DeliveryStatus | null;
  deleted: boolean;
  deletedAt: number | null;
  /** Text was replaced by a later MESSAGE_EDIT — rendered as "(edited)". Optional so pre-existing persisted messages need no migration. */
  edited?: boolean;
  reactions?: { emoji: string; sender: string }[];
  raw: unknown;
}
