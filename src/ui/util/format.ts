import type { Chat, DeliveryStatus, MessageDirection, MessageType } from "../../types/index.js";
import { theme, type TextStyle } from "../theme.js";

/**
 * Derive a `+<number>` string from a JID user part. Works for `@s.whatsapp.net`
 * JIDs (e.g. `5491100000000@s.whatsapp.net` → `+5491100000000`). Returns null
 * for JIDs that don't carry a real phone number (e.g. `@lid`, `@g.us`).
 *
 * Extracted from `AccountSelectScreen.tsx` so it can be reused by the sender
 * label resolver without introducing a UI→persistence import cycle.
 */
export function phoneFromJid(jid: string): string | null {
  if (!jid) return null;
  // Only @s.whatsapp.net JIDs carry a real phone number.
  if (!jid.endsWith("@s.whatsapp.net")) return null;
  const user = jid.split("@")[0];
  if (!user) return null;
  return `+${user}`;
}

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

/** Returns true if `date` falls on the same calendar day as `now`. */
export function isToday(date: Date, now: Date): boolean {
  return (
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate()
  );
}

/**
 * `HH:MM` for timestamps from today, `yyyy-mm-dd HH:MM` otherwise — per chat-list spec.
 * Accepts an optional `now` for testability.
 */
export function formatListTimestamp(ts: number, now: Date = new Date()): string {
  const date = new Date(ts);
  const hhmm = `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
  if (isToday(date, now)) return hhmm;
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${hhmm}`;
}

/**
 * `HH:MM` for today's messages, `yyyy-mm-dd HH:MM` for older messages — message meta-line timestamp.
 * Accepts an optional `now` for testability.
 */
export function formatMessageTime(ts: number, now: Date = new Date()): string {
  const date = new Date(ts);
  const hhmm = `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
  if (isToday(date, now)) return hhmm;
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${hhmm}`;
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

/**
 * Aggregate a reactions array into a compact display string, e.g. `👍2 ❤️`.
 * - Deduplicates by sender (last entry wins, matching WhatsApp's replace semantics).
 * - Entries with empty emoji are skipped (retracted reactions).
 * - Emoji with count=1 are rendered without the count.
 * - The result is truncated so it fits within `maxColumns` terminal columns,
 *   budgeting 2 columns per emoji (most terminals render emoji as double-width)
 *   plus 1 per digit and 1 per separating space.
 * Returns an empty string when there are no reactions.
 */
export function aggregateReactions(
  reactions: { emoji: string; sender: string }[] | undefined,
  maxColumns: number,
): string {
  if (!reactions || reactions.length === 0) return "";

  // Deduplicate: last reaction per sender wins (matches replace semantics).
  const bySender = new Map<string, string>();
  for (const r of reactions) {
    bySender.set(r.sender, r.emoji);
  }

  // Count per emoji, preserving insertion order of first occurrence.
  const counts = new Map<string, number>();
  for (const emoji of bySender.values()) {
    if (!emoji) continue; // skip retractions
    counts.set(emoji, (counts.get(emoji) ?? 0) + 1);
  }

  if (counts.size === 0) return "";

  // Build all segments first, then fit as many as possible into maxColumns.
  // Each emoji costs 2 terminal columns (double-width); count costs its digit count;
  // separator space before each segment after the first costs 1.
  const segments: string[] = [];
  for (const [emoji, count] of counts) {
    segments.push(count > 1 ? `${emoji}${count}` : emoji);
  }

  // Cost of a segment in terminal columns (with its leading space if not first).
  // Segments have the form `<emoji>[<digits>]`. The emoji always costs 2 terminal columns
  // regardless of how many UTF-16 code units it occupies; each digit costs 1 column.
  function segCost(seg: string, isFirst: boolean): number {
    const digits = seg.match(/\d+$/)?.[0]?.length ?? 0;
    return 2 + digits + (isFirst ? 0 : 1);
  }

  const result: string[] = [];
  let usedCols = 0;
  const ELLIPSIS = "…";

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i]!;
    const isFirst = result.length === 0;
    const cost = segCost(seg, isFirst);
    const remaining = segments.length - i - 1;

    if (usedCols + cost > maxColumns) {
      // This segment doesn't fit. Add ellipsis if there's room (and we have something already).
      if (result.length > 0) {
        const ellipsisCost = 1 + ELLIPSIS.length; // space + "…"
        if (usedCols + ellipsisCost <= maxColumns) {
          result.push(ELLIPSIS);
        }
      }
      break;
    }

    // Segment fits, but check: if there are more segments after this, will we need to
    // leave room for "…"? Only reserve room for "…" if the next segment won't fit.
    if (remaining > 0) {
      const next = segments[i + 1]!;
      const nextCost = segCost(next, false);
      const ellipsisCost = 1 + ELLIPSIS.length;
      if (usedCols + cost + nextCost > maxColumns) {
        // Next won't fit — add this segment then an ellipsis if there's room after.
        usedCols += cost;
        result.push(seg);
        if (usedCols + ellipsisCost <= maxColumns) {
          result.push(ELLIPSIS);
        }
        break;
      }
    }

    usedCols += cost;
    result.push(seg);
  }

  return result.join(" ");
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

const BYTE_UNITS = ["B", "KB", "MB", "GB", "TB"] as const;

/**
 * Format a byte count as a human-readable string with one decimal place,
 * e.g. `formatBytes(12_400_000)` → `"11.8 MB"`.
 */
export function formatBytes(bytes: number): string {
  if (bytes < 0) bytes = 0;
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < BYTE_UNITS.length - 1) {
    value /= 1024;
    unitIndex++;
  }
  if (unitIndex === 0) return `${bytes} B`;
  return `${value.toFixed(1)} ${BYTE_UNITS[unitIndex]}`;
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
