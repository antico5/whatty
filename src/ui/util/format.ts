import type { Chat, DeliveryStatus, MessageDirection, MessageType } from "../../types/index.js";
import { theme, type TextStyle } from "../theme.js";

/** Display name per spec: group subject or saved-contact name; non-contacts render as "Not Contact". */
export function chatTitle(chat: Chat): string {
  return (chat.type === "group" ? chat.groupSubject : chat.displayName) ?? "Not Contact";
}

/** Secondary title text: the phone number for individual chats, nothing for groups. */
export function chatSubtitle(chat: Chat): string | null {
  return chat.type === "individual" ? chat.phoneNumber : null;
}

function pad2(n: number): string {
  return n.toString().padStart(2, "0");
}

/** `HH:MM` for timestamps from today, `yyyy-mm-dd` otherwise — per chat-list spec. */
export function formatListTimestamp(ts: number): string {
  const date = new Date(ts);
  const now = new Date();
  const isToday =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();
  if (isToday) return `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

/** `HH:MM` — message meta-line timestamp, per chat-view spec (always time-of-day, never a date). */
export function formatMessageTime(ts: number): string {
  const date = new Date(ts);
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

const MEDIA_TYPE_LABELS: Partial<Record<MessageType, string>> = {
  image: "image",
  video: "video",
  audio: "audio",
  document: "document",
  sticker: "sticker",
  viewOnce: "view once",
};

/** Bracketed type hint for media messages, e.g. `[image]`, `[view once]`, `[media]` for anything else. */
export function mediaTypeLabel(type: MessageType): string {
  return `[${MEDIA_TYPE_LABELS[type] ?? "media"}]`;
}

/** Collapse to a single line and cut to at most `width` characters, marking cuts with `…`. */
export function truncate(text: string, width: number): string {
  const singleLine = text.replace(/\s+/g, " ").trim();
  if (singleLine.length <= width) return singleLine;
  if (width <= 1) return "…";
  return `${singleLine.slice(0, width - 1)}…`;
}

export interface DirectionIndicator {
  symbol: string;
  style: TextStyle;
}

/** `→` (green) for outbound messages, `←` (default fg) for inbound. */
export function directionIndicator(direction: MessageDirection): DirectionIndicator {
  return direction === "outbound"
    ? { symbol: "→", style: theme.outbound }
    : { symbol: "←", style: theme.inbound };
}

export interface MessageTicks {
  symbol: string;
  style: TextStyle;
}

/**
 * Outbound delivery-status ticks per chat-view spec: `✓` sent, `✓✓` delivered (gray),
 * `✓✓` read (bright-cyan), `✗` failed (red). `null` for inbound / not-yet-sent messages —
 * the spec defines no glyph for the transient "pending" state.
 */
export function messageTicks(status: DeliveryStatus | null): MessageTicks | null {
  switch (status) {
    case "sent":
      return { symbol: "✓", style: theme.meta };
    case "delivered":
      return { symbol: "✓✓", style: theme.meta };
    case "read":
      return { symbol: "✓✓", style: theme.read };
    case "failed":
      return { symbol: "✗", style: theme.failed };
    default:
      return null;
  }
}

/** Greedy word-wrap to at most `width` columns per line; hard-breaks words longer than `width`. */
export function wrapText(text: string, width: number): string[] {
  const w = Math.max(1, width);
  const lines: string[] = [];
  for (const paragraph of text.split("\n")) {
    let remaining = paragraph.trimEnd();
    if (remaining.length === 0) {
      lines.push("");
      continue;
    }
    while (remaining.length > w) {
      let breakAt = remaining.lastIndexOf(" ", w);
      if (breakAt <= 0) breakAt = w;
      lines.push(remaining.slice(0, breakAt).trimEnd());
      remaining = remaining.slice(breakAt).trimStart();
    }
    lines.push(remaining);
  }
  return lines;
}
