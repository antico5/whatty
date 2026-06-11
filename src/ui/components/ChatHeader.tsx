import type { Chat } from "../../types/index.js";
import { BOLD, theme } from "../theme.js";
import { chatSubtitle, chatTitle, formatListTimestamp, truncate } from "../util/format.js";

export interface ChatHeaderProps {
  chat: Chat;
  /** Total row width (terminal columns) — used to draw the separator rule and size the title. */
  width: number;
}

/** Header bar: name (bold) · number/subject (gray) · "last seen …" (gray) · separator rule. */
export function ChatHeader({ chat, width }: ChatHeaderProps) {
  const rawName = chatTitle(chat);
  const subtitle = chatSubtitle(chat);
  const lastSeen = chat.lastActivity > 0 ? `last seen ${formatListTimestamp(chat.lastActivity)}` : null;

  // Reserve slack (see ChatListItem) so a fully-packed title row never wraps and corrupts the rule below it.
  // Phone numbers/subjects-as-subtitles are always short, so only the name needs truncation.
  const available = Math.max(1, width - 1);
  const subtitleText = subtitle ? ` ${subtitle}` : "";
  const name = truncate(rawName, Math.max(1, available - subtitleText.length));

  return (
    <box style={{ flexDirection: "column" }}>
      <box style={{ flexDirection: "row" }}>
        <text attributes={BOLD}>{name}</text>
        {subtitleText ? <text {...theme.meta}>{subtitleText}</text> : null}
      </box>
      {lastSeen ? <text {...theme.meta}>{lastSeen}</text> : null}
      {/* -1 slack: an exact-width row wraps and corrupts the row below it (see ChatListItem). */}
      <text {...theme.meta}>{"─".repeat(Math.max(1, width - 1))}</text>
    </box>
  );
}
