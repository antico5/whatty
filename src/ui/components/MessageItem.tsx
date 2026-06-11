import type { ReactNode } from "react";
import { absoluteMediaPath, fileUrl } from "../../persistence/mediaStore.js";
import type { Chat, Message } from "../../types/index.js";
import { BOLD, senderColor, theme, type TextStyle } from "../theme.js";
import {
  formatMessageTime,
  mediaTypeLabel,
  messageTicks,
  truncate,
  wrapText,
  type MessageTicks,
} from "../util/format.js";

export interface MessageItemProps {
  message: Message;
  chat: Chat;
  /** Total row width (terminal columns) — used to size and wrap the message bubble. */
  width: number;
}

type LineData =
  | { kind: "sender"; text: string; style: TextStyle }
  | { kind: "quoted"; text: string }
  | { kind: "media"; text: string }
  | { kind: "text"; text: string }
  | { kind: "meta"; time: string; deleted: boolean; edited: boolean; ticks: MessageTicks | null };

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

  if (message.media) {
    const link = fileUrl(absoluteMediaPath(chat.jid, message.media));
    // The file:// link is one long unbroken "word" that exceeds maxWidth — pre-chunk it at the
    // exact column limit (mirroring the renderer's character wrap) so the counted rows always
    // equal the rendered rows. Counting it as one line makes computeWindow overfill the message
    // area, which then overflows out the top of the flex-end box and overdraws the header.
    const media = `${mediaTypeLabel(message.type)} ${link}`;
    for (let i = 0; i < media.length; i += maxWidth) {
      lines.push({ kind: "media", text: media.slice(i, i + maxWidth) });
    }
    if (message.text) {
      for (const line of wrapText(message.text, maxWidth)) lines.push({ kind: "text", text: line });
    }
  } else if (message.text) {
    for (const line of wrapText(message.text, maxWidth)) lines.push({ kind: "text", text: line });
  }

  const ticks = message.direction === "outbound" ? messageTicks(message.deliveryStatus) : null;
  lines.push({
    kind: "meta",
    time: formatMessageTime(message.timestamp),
    deleted: message.deleted,
    edited: message.edited === true,
    ticks,
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
