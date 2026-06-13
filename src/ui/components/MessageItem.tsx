import type { ReactNode } from "react";
import { absoluteMediaPath } from "../../persistence/mediaStore.js";
import type { Chat, Message } from "../../types/index.js";
import { BOLD, senderColor, theme, type TextStyle } from "../theme.js";
import {
  aggregateReactions,
  formatMessageTime,
  mediaTypeLabel,
  messageTicks,
  resolveMentions,
  truncate,
  wrapText,
  type MessageTicks,
} from "../util/format.js";
import { ensureTmpLink } from "../util/tmpMediaLink.js";

/**
 * Message types that carry downloadable media — the ones that render a file
 * link when `media` is set, or a "not downloaded" hint when it isn't. Shared
 * with the chat view, which uses it to trigger on-demand downloads as these
 * messages scroll into view.
 */
export const MEDIA_MESSAGE_TYPES: ReadonlySet<Message["type"]> = new Set([
  "image",
  "video",
  "audio",
  "document",
  "sticker",
  "viewOnce",
]);

export interface MessageItemProps {
  message: Message;
  chat: Chat;
  /** Total row width (terminal columns) — used to size and wrap the message bubble. */
  width: number;
}

type LineData =
  | { kind: "sender"; text: string; style: TextStyle }
  | { kind: "quoted"; text: string }
  /** file:// URL of the tmp symlink, chunked to maxWidth so row counting is exact. */
  | { kind: "media"; text: string }
  | { kind: "text"; text: string }
  | { kind: "meta"; time: string; deleted: boolean; edited: boolean; ticks: MessageTicks | null; reactions: string };

/**
 * One source of truth for a message's rendered line layout — shared by `render` (for JSX)
 * and `messageRowCount` (for windowed-scroll height math), so they can never drift apart.
 */
function layoutLines(message: Message, chat: Chat, maxWidth: number): LineData[] {
  const lines: LineData[] = [];

  if (chat.type === "group" && message.direction === "inbound") {
    const senderId = message.senderJid ?? message.id;
    const label = message.senderName ?? message.senderJid ?? "Unknown";
    lines.push({ kind: "sender", text: truncate(label, maxWidth), style: senderColor(senderId) });
  }

  if (message.quoted) {
    lines.push({ kind: "quoted", text: truncate(`‹${message.quoted.sender ?? "Unknown"}›: ${message.quoted.snippet}`, maxWidth) });
  }

  const resolvedText =
    chat.type === "group" && message.text
      ? resolveMentions(message.text, message.mentions, chat.participants)
      : message.text;

  if (message.media) {
    const absPath = absoluteMediaPath(message.media);
    const typeLabel = mediaTypeLabel(message.type);
    // Plain-text file:// URL pointing at a short tmp symlink (created lazily here,
    // i.e. only for messages that actually scroll into view). The label text is a
    // pure function of absPath, so row counting stays deterministic either way.
    const media = `${typeLabel} file://${ensureTmpLink(absPath)}`;
    for (let i = 0; i < media.length; i += maxWidth) {
      lines.push({ kind: "media", text: media.slice(i, i + maxWidth) });
    }
    if (resolvedText) {
      for (const line of wrapText(resolvedText, maxWidth)) lines.push({ kind: "text", text: line });
    }
  } else {
    // No downloaded media — show the type label as a hint when the message type
    // indicates there should be media (e.g. skipped by the 7-day auto-download gate,
    // or not yet fetched; the chat view kicks off a download as it scrolls into view).
    if (MEDIA_MESSAGE_TYPES.has(message.type)) {
      const typeLabel = mediaTypeLabel(message.type);
      // View-once bytes are never delivered to a passive client, so "not
      // downloaded" would mislead — the bare `[view once]` label is the truth.
      const hint = message.type === "viewOnce" ? typeLabel : `${typeLabel} not downloaded`;
      lines.push({ kind: "text", text: truncate(hint, maxWidth) });
    }
    if (resolvedText) {
      for (const line of wrapText(resolvedText, maxWidth)) lines.push({ kind: "text", text: line });
    }
  }

  const ticks = message.direction === "outbound" ? messageTicks(message.deliveryStatus) : null;

  // Budget the reaction string so the meta row never wraps.
  // Plan 07 will widen the timestamp to `yyyy-mm-dd HH:MM` (16 chars) for non-today messages.
  // We pre-budget against that worst case so the row stays single-line after plan 07 lands.
  // Worst-case fixed costs on the meta line:
  //   timestamp: 16  |  " (deleted)": 9  |  " ✓✓": 3  →  28 chars
  // The reactions string is prefixed with a single space, so available columns = maxWidth - 29.
  const FIXED_META_COLS = 28; // timestamp(16) + deleted(9) + ticks(3)
  const reactionsAvailable = Math.max(0, maxWidth - FIXED_META_COLS - 1);
  const reactions = aggregateReactions(message.reactions, reactionsAvailable);

  lines.push({
    kind: "meta",
    time: formatMessageTime(message.timestamp),
    deleted: message.deleted,
    edited: message.edited === true,
    ticks,
    reactions,
  });

  return lines;
}

function renderLine(line: LineData, key: string): ReactNode {
  switch (line.kind) {
    case "sender":
      return (
        <text key={key} {...line.style} attributes={BOLD}>
          {line.text}
        </text>
      );
    case "quoted":
      return (
        <text key={key} {...theme.meta}>
          {line.text}
        </text>
      );
    case "media":
      return (
        <text key={key} {...theme.mediaLink}>
          {line.text}
        </text>
      );
    case "text":
      return <text key={key}>{line.text}</text>;
    case "meta":
      return (
        <box key={key} style={{ flexDirection: "row" }}>
          <text {...theme.meta}>{line.time}</text>
          {line.deleted ? <text {...theme.deleted}>{" (deleted)"}</text> : null}
          {line.edited ? <text {...theme.meta}>{" (edited)"}</text> : null}
          {line.ticks ? <text {...line.ticks.style}>{` ${line.ticks.symbol}`}</text> : null}
          {line.reactions ? <text {...theme.meta}>{` ${line.reactions}`}</text> : null}
        </box>
      );
  }
}

/** Cap message bubbles at ~70% of the row so they never span the full terminal width. */
export function maxMessageContentWidth(width: number): number {
  return Math.max(20, Math.min(width - 4, Math.floor(width * 0.7)));
}

/** Total rendered rows for one message (content lines + the gutter-spanning gap below it). */
export function messageRowCount(message: Message, chat: Chat, width: number): number {
  return layoutLines(message, chat, maxMessageContentWidth(width)).length + 1;
}

/**
 * Direction is conveyed by alignment plus a colored gutter bar (no backgrounds/borders, per spec):
 * inbound = left-aligned with a cyan/default `│` on the left; outbound = right-aligned with a
 * green `│` on the right.
 */
export function MessageItem({ message, chat, width }: MessageItemProps) {
  const outbound = message.direction === "outbound";
  const maxContentWidth = maxMessageContentWidth(width);
  const lines = layoutLines(message, chat, maxContentWidth);

  const gutterStyle: TextStyle = outbound ? theme.outbound : theme.accent;
  const gutter = (
    <box style={{ flexDirection: "column" }}>
      {lines.map((_, i) => (
        <text key={`gutter-${i}`} {...gutterStyle}>
          │
        </text>
      ))}
    </box>
  );
  const content = (
    <box
      style={{
        flexDirection: "column",
        maxWidth: maxContentWidth,
        alignItems: outbound ? "flex-end" : "flex-start",
      }}
    >
      {lines.map((line, i) => (
        <box key={`content-${i}`} style={{ flexDirection: "row" }}>
          {renderLine(line, `line-${i}`)}
        </box>
      ))}
    </box>
  );

  return (
    <box style={{ flexDirection: "row", justifyContent: outbound ? "flex-end" : "flex-start", marginBottom: 1 }}>
      {outbound ? content : gutter}
      {outbound ? gutter : content}
    </box>
  );
}

/**
 * Exported for unit-testing only — exposes the internal layout computation
 * without going through the React render path.
 *
 * @internal
 */
export { layoutLines as layoutLinesForTest, type LineData };
