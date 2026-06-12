import type { Chat, MessageDirection } from "../../types/index.js";
import { isPersistedEditEnvelope } from "../../whatsapp/edits.js";
import { BOLD, INVERSE, theme, type TextStyle } from "../theme.js";
import {
  chatSubtitle,
  chatTitle,
  directionIndicator,
  formatListTimestamp,
  mediaTypeLabel,
  truncate,
} from "../util/format.js";

export interface ChatListItemProps {
  chat: Chat;
  selected: boolean;
  /** Total row width (terminal columns) — used to right-align the timestamp and truncate the preview. */
  width: number;
}

interface LastMessagePreview {
  direction: MessageDirection;
  text: string;
}

/** Latest message's text/caption, or a `[type]` hint for media-only messages. */
function lastMessagePreview(chat: Chat): LastMessagePreview | null {
  let last = null;
  for (let i = chat.messages.length - 1; i >= 0; i -= 1) {
    const candidate = chat.messages[i]!;
    if (!isPersistedEditEnvelope(candidate)) {
      last = candidate;
      break;
    }
  }
  if (!last) return null;
  if (last.text) return { direction: last.direction, text: last.text };
  if (last.media) return { direction: last.direction, text: mediaTypeLabel(last.type) };
  const MEDIA_TYPES = new Set<string>(["image", "video", "audio", "document", "sticker", "viewOnce"]);
  if (MEDIA_TYPES.has(last.type)) return { direction: last.direction, text: mediaTypeLabel(last.type) };
  return { direction: last.direction, text: "" };
}

/**
 * Selection is rendered as terminal reverse video (per spec: "highlighted background
 * (terminal highlight/reverse)") rather than a hardcoded fill color, so the highlight
 * adapts to whatever palette the user's terminal has.
 */
function rowStyle(style: TextStyle, selected: boolean): TextStyle {
  return selected ? { ...style, attributes: (style.attributes ?? 0) | INVERSE } : style;
}

const NAME_STYLE: TextStyle = { attributes: BOLD };

export function ChatListItem({ chat, selected, width }: ChatListItemProps) {
  const name = chatTitle(chat);
  const subtitle = chatSubtitle(chat);
  const timestamp = formatListTimestamp(chat.lastActivity);
  const archivedMarker = chat.archived ? " ⊟ archived" : "";

  // -1 for the accent-bar column, -1 of slack so a fully-packed row never sits
  // flush against the terminal's right edge (which otherwise wraps and leaves
  // a stray blank line behind).
  const contentWidth = Math.max(1, width - 2);
  const headerLeft = `${name}${subtitle ? ` ${subtitle}` : ""}${archivedMarker}`;
  const headerGap = " ".repeat(Math.max(1, contentWidth - headerLeft.length - timestamp.length));

  const preview = lastMessagePreview(chat);
  const indicator = preview ? directionIndicator(preview.direction) : null;
  const indicatorWidth = indicator ? 2 : 0;
  const previewText = preview ? truncate(preview.text, Math.max(1, contentWidth - indicatorWidth)) : "No messages yet";
  const detailPad = " ".repeat(Math.max(0, contentWidth - indicatorWidth - previewText.length));

  const barStyle: TextStyle = selected ? { ...theme.accent, attributes: INVERSE } : {};
  const bar = selected ? "┃" : " ";

  return (
    <box style={{ flexDirection: "row" }}>
      <box style={{ flexDirection: "column" }}>
        <text {...barStyle}>{bar}</text>
        <text {...barStyle}>{bar}</text>
      </box>
      <box style={{ flexDirection: "column", flexGrow: 1 }}>
        <box style={{ flexDirection: "row" }}>
          <text {...rowStyle(NAME_STYLE, selected)}>{name}</text>
          {subtitle ? <text {...rowStyle(theme.meta, selected)}>{` ${subtitle}`}</text> : null}
          {archivedMarker ? <text {...rowStyle(theme.meta, selected)}>{archivedMarker}</text> : null}
          <text {...rowStyle(theme.meta, selected)}>{headerGap}</text>
          <text {...rowStyle(theme.meta, selected)}>{timestamp}</text>
        </box>
        <box style={{ flexDirection: "row" }}>
          {indicator ? <text {...rowStyle(indicator.style, selected)}>{`${indicator.symbol} `}</text> : null}
          <text {...rowStyle(theme.meta, selected)}>{previewText}</text>
          <text {...rowStyle(theme.meta, selected)}>{detailPad}</text>
        </box>
      </box>
    </box>
  );
}
