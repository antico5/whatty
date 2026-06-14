import { useKeyboard, useTerminalDimensions } from "@opentui/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useAppStore, useChat, useReadonly } from "../../store/StoreContext.js";
import type { Chat, Message } from "../../types/index.js";
import { isPersistedEditEnvelope } from "../../whatsapp/edits.js";
import { useNavigation } from "../App.js";
import { ChatHeader } from "../components/ChatHeader.js";
import { DraftInput } from "../components/DraftInput.js";
import { MEDIA_MESSAGE_TYPES, MessageItem, messageRowCount } from "../components/MessageItem.js";
import { layoutWidth } from "../layout.js";
import { theme } from "../theme.js";
import { formatMessageTime } from "../util/format.js";

export interface ChatViewScreenProps {
  jid: string;
}

interface MessageWindow {
  startIndex: number;
  endIndex: number;
}

/** Greedily fill `maxHeight` rows working backwards from `bottomIndex`, always showing ≥1 message. */
function computeWindow(messages: Message[], bottomIndex: number, maxHeight: number, chat: Chat, width: number): MessageWindow {
  if (messages.length === 0) return { startIndex: 0, endIndex: -1 };
  const end = Math.min(bottomIndex, messages.length - 1);
  let total = messageRowCount(messages[end], chat, width);
  let start = end;
  for (let i = end - 1; i >= 0; i--) {
    const rows = messageRowCount(messages[i], chat, width);
    if (total + rows > maxHeight) break;
    total += rows;
    start = i;
  }
  return { startIndex: start, endIndex: end };
}

/**
 * Bottom index that lands `selIndex` roughly mid-screen: fill ~half the area below it with
 * following messages (clamped at the end), so `computeWindow` then fills the rest above —
 * used to scroll to a chosen search result with context on both sides.
 */
function centeredBottom(messages: Message[], selIndex: number, areaHeight: number, chat: Chat, width: number): number {
  const half = Math.floor(areaHeight / 2);
  let used = messageRowCount(messages[selIndex], chat, width);
  let bottom = selIndex;
  for (let i = selIndex + 1; i < messages.length; i++) {
    const rows = messageRowCount(messages[i], chat, width);
    if (used + rows > half) break;
    used += rows;
    bottom = i;
  }
  return bottom;
}

export function ChatViewScreen({ jid }: ChatViewScreenProps) {
  const chat = useChat(jid);
  const store = useAppStore();
  const navigation = useNavigation();
  const readonly = useReadonly();
  const { width: terminalWidth, height } = useTerminalDimensions();
  // Single clamp feeding both computeWindow and MessageItem, so the scroll-window
  // row math and the rendered wrap points can't drift (see layout.ts).
  const width = layoutWidth(terminalWidth);
  const messages = (chat?.messages ?? []).filter((message) => !isPersistedEditEnvelope(message));

  // Index of the bottom-most visible message. Tracks the latest message while "pinned to bottom"
  // (the default); scrolling up with ↑ detaches it so new arrivals don't yank the view around.
  const [bottomIndex, setBottomIndex] = useState(() => Math.max(0, messages.length - 1));
  const [hasNewMessages, setHasNewMessages] = useState(false);
  const prevLengthRef = useRef(messages.length);

  // In-chat search: `searching` = the search box owns the keyboard; `searchQuery` = its text;
  // `selectedMsgIndex` = the chosen match (index into `messages`); -1 = "default to last match".
  const [searching, setSearching] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedMsgIndex, setSelectedMsgIndex] = useState(-1);

  useEffect(() => {
    const prevLength = prevLengthRef.current;
    if (messages.length > prevLength) {
      const wasPinnedToBottom = bottomIndex >= prevLength - 1;
      if (wasPinnedToBottom) {
        setBottomIndex(messages.length - 1);
      } else {
        setHasNewMessages(true);
      }
    }
    prevLengthRef.current = messages.length;
    // Reacts only to new messages arriving — bottomIndex changes are driven by the user, not this effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages.length]);

  // Matching indices into `messages`: case-insensitive partial match on the message text, the
  // displayed timestamp, and (group inbound only) the sender label — the values MessageItem
  // renders. Empty query matches all. Recomputed only while searching.
  const isGroup = chat?.type === "group";
  const matchIndices = useMemo(() => {
    if (!searching) return [];
    const q = searchQuery.trim().toLowerCase();
    const result: number[] = [];
    for (let i = 0; i < messages.length; i++) {
      if (q === "") {
        result.push(i);
        continue;
      }
      const m = messages[i];
      const sender = isGroup && m.direction === "inbound" ? (m.senderName ?? m.senderJid ?? "") : "";
      const haystack = `${m.text ?? ""} ${formatMessageTime(m.timestamp)} ${sender}`.toLowerCase();
      if (haystack.includes(q)) result.push(i);
    }
    return result;
  }, [searching, searchQuery, messages, isGroup]);

  // The chosen match falls back to the most recent match whenever the query changes the set.
  const effectiveIdx = matchIndices.includes(selectedMsgIndex)
    ? selectedMsgIndex
    : matchIndices.length > 0
      ? matchIndices[matchIndices.length - 1]
      : -1;

  // Header: title row + optional "last seen" row + separator rule.
  const headerRows = chat && chat.lastActivity > 0 ? 3 : 2;
  const indicatorRows = hasNewMessages && !searching ? 1 : 0;
  const searchRows = searching ? 1 : 0;
  const messageAreaHeight = Math.max(
    1,
    height - headerRows - indicatorRows - 1 /* spacer */ - 1 /* draft input */ - searchRows,
  );

  useKeyboard((key) => {
    // While the search box is focused it owns the keyboard: printable keys append to the
    // query, ↑/↓ step through matches (without leaving the typing state).
    if (searching) {
      if (key.name === "escape") {
        // Back to the initial chat view: drop the search and pin to the latest message.
        setSearching(false);
        setSearchQuery("");
        setSelectedMsgIndex(-1);
        setBottomIndex(Math.max(0, messages.length - 1));
        setHasNewMessages(false);
        return;
      }
      if (key.name === "return") {
        // Clear the search but scroll the (now unfiltered) timeline to centre the match.
        if (chat && effectiveIdx >= 0) {
          setBottomIndex(centeredBottom(messages, effectiveIdx, messageAreaHeight, chat, width));
          setHasNewMessages(false);
        }
        setSearching(false);
        setSearchQuery("");
        setSelectedMsgIndex(-1);
        return;
      }
      if (key.name === "backspace" || key.name === "delete") {
        setSearchQuery((current) => current.slice(0, -1));
        return;
      }
      if (key.name === "up" || key.name === "down") {
        if (matchIndices.length > 0) {
          const pos = matchIndices.indexOf(effectiveIdx);
          const basePos = pos === -1 ? matchIndices.length - 1 : pos;
          const nextPos = key.name === "up" ? Math.max(0, basePos - 1) : Math.min(matchIndices.length - 1, basePos + 1);
          setSelectedMsgIndex(matchIndices[nextPos]);
        }
        return;
      }
      if (key.ctrl || key.meta) return;
      const sequence = key.sequence;
      if (sequence && sequence.charCodeAt(0) >= 0x20) {
        setSearchQuery((current) => current + sequence);
      }
      return;
    }

    // Ctrl+F opens the search box.
    if (key.ctrl && key.name === "f") {
      if (messages.length > 0) {
        setSearching(true);
        setSearchQuery("");
        setSelectedMsgIndex(-1);
      }
      return;
    }
    if (key.name === "escape") {
      navigation.back();
      return;
    }
    if (key.name === "end") {
      setBottomIndex(Math.max(0, messages.length - 1));
      setHasNewMessages(false);
      return;
    }
    if (messages.length === 0) return;
    if (key.name === "up") {
      setBottomIndex((index) => Math.max(0, index - 1));
    } else if (key.name === "down") {
      setBottomIndex((index) => {
        const next = Math.min(messages.length - 1, index + 1);
        if (next === messages.length - 1) setHasNewMessages(false);
        return next;
      });
    }
  });

  // The visible rows: while searching, a window over the matching messages centred on the
  // selected match (highlighted); otherwise the normal window anchored at `bottomIndex`.
  const renderRows: { message: Message; key: string; selected: boolean }[] = [];
  if (chat) {
    if (searching) {
      const filtered = matchIndices.map((i) => messages[i]);
      if (filtered.length > 0) {
        const anchorPos = effectiveIdx >= 0 ? matchIndices.indexOf(effectiveIdx) : filtered.length - 1;
        const bottom = centeredBottom(filtered, anchorPos, messageAreaHeight, chat, width);
        const { startIndex, endIndex } = computeWindow(filtered, bottom, messageAreaHeight, chat, width);
        for (let p = startIndex; p <= endIndex; p++) {
          const gi = matchIndices[p];
          renderRows.push({ message: messages[gi], key: String(gi), selected: gi === effectiveIdx });
        }
      }
    } else {
      const { startIndex, endIndex } = computeWindow(messages, bottomIndex, messageAreaHeight, chat, width);
      for (let i = startIndex; i <= endIndex; i++) {
        renderRows.push({ message: messages[i], key: messages[i].id, selected: false });
      }
    }
  }
  const visibleMessages = renderRows.map((row) => row.message);

  // Auto-download media for messages scrolled into view but not yet fetched
  // (e.g. older than the eager 7-day window). Keyed on the set of still-missing
  // media ids, so the effect fires only when that set changes and stops
  // re-firing for each id once its download lands and clears `media` on reload.
  const pendingMediaIds = visibleMessages
    .filter((m) => m.media == null && !m.mediaUnavailable && MEDIA_MESSAGE_TYPES.has(m.type))
    .map((m) => m.id);
  const pendingMediaKey = pendingMediaIds.join(",");
  useEffect(() => {
    for (const id of pendingMediaIds) store.downloadMediaIfNeeded(jid, id);
    // pendingMediaIds is derived from pendingMediaKey; jid and store are stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jid, pendingMediaKey]);

  if (chat === null) {
    return (
      <box style={{ flexGrow: 1, alignItems: "center", justifyContent: "center" }}>
        <text {...theme.meta}>Loading chat…</text>
      </box>
    );
  }

  async function handleSend(text: string): Promise<void> {
    setBottomIndex(Math.max(0, messages.length - 1));
    setHasNewMessages(false);
    await store.sendText(jid, text);
  }

  return (
    <box style={{ flexGrow: 1, flexDirection: "column" }}>
      <ChatHeader chat={chat} width={width} />
      <box style={{ flexGrow: 1, flexDirection: "column", justifyContent: "flex-end" }}>
        {renderRows.length === 0 ? (
          <box style={{ flexGrow: 1, alignItems: "center", justifyContent: "center" }}>
            <text {...theme.meta}>{searching && searchQuery.trim() !== "" ? "No matches" : "No messages yet"}</text>
          </box>
        ) : (
          renderRows.map((row) => (
            <MessageItem key={row.key} message={row.message} chat={chat} width={width} selected={row.selected} />
          ))
        )}
      </box>
      {hasNewMessages && !searching ? (
        <box style={{ flexDirection: "row", justifyContent: "center" }}>
          <text {...theme.accent}>New Messages</text>
        </box>
      ) : null}
      {searching ? (
        <box style={{ flexDirection: "row" }}>
          <text {...theme.accent}>{"Search: "}</text>
          <text>{searchQuery}</text>
          <text {...theme.accent}>{"_"}</text>
        </box>
      ) : null}
      <text>{" "}</text>
      <DraftInput onSubmit={handleSend} readonly={readonly} paused={searching} />
    </box>
  );
}
