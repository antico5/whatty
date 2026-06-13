import { useKeyboard, useTerminalDimensions } from "@opentui/react";
import { useEffect, useRef, useState } from "react";
import { useAppStore, useChat, useReadonly } from "../../store/StoreContext.js";
import type { Chat, Message } from "../../types/index.js";
import { isPersistedEditEnvelope } from "../../whatsapp/edits.js";
import { useNavigation } from "../App.js";
import { ChatHeader } from "../components/ChatHeader.js";
import { DraftInput } from "../components/DraftInput.js";
import { MEDIA_MESSAGE_TYPES, MessageItem, messageRowCount } from "../components/MessageItem.js";
import { layoutWidth } from "../layout.js";
import { theme } from "../theme.js";

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

  useKeyboard((key) => {
    if (key.name === "escape") {
      navigation.back();
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

  // Header: title row + optional "last seen" row + separator rule.
  const headerRows = chat && chat.lastActivity > 0 ? 3 : 2;
  const indicatorRows = hasNewMessages ? 1 : 0;
  const messageAreaHeight = Math.max(1, height - headerRows - indicatorRows - 1 /* spacer */ - 1 /* draft input */);

  const { startIndex, endIndex } = chat
    ? computeWindow(messages, bottomIndex, messageAreaHeight, chat, width)
    : { startIndex: 0, endIndex: -1 };
  const visibleMessages = endIndex >= startIndex ? messages.slice(startIndex, endIndex + 1) : [];

  // Auto-download media for messages scrolled into view but not yet fetched
  // (e.g. older than the eager 7-day window). Keyed on the set of still-missing
  // media ids, so the effect fires only when that set changes and stops
  // re-firing for each id once its download lands and clears `media` on reload.
  const pendingMediaIds = visibleMessages
    .filter((m) => m.media == null && MEDIA_MESSAGE_TYPES.has(m.type))
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
        {visibleMessages.length === 0 ? (
          <box style={{ flexGrow: 1, alignItems: "center", justifyContent: "center" }}>
            <text {...theme.meta}>No messages yet</text>
          </box>
        ) : (
          visibleMessages.map((message) => (
            <MessageItem key={message.id} message={message} chat={chat} width={width} />
          ))
        )}
      </box>
      {hasNewMessages ? (
        <box style={{ flexDirection: "row", justifyContent: "center" }}>
          <text {...theme.accent}>New Messages</text>
        </box>
      ) : null}
      <text>{" "}</text>
      <DraftInput onSubmit={handleSend} readonly={readonly} />
    </box>
  );
}
