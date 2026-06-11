import { useKeyboard, useTerminalDimensions } from "@opentui/react";
import { useEffect, useMemo, useState } from "react";
import { useChats, useReadonly } from "../../store/StoreContext.js";
import { getBaileysVersion } from "../../whatsapp/version.js";
import { useNavigation } from "../App.js";
import { ChatListItem } from "../components/ChatListItem.js";
import { layoutWidth } from "../layout.js";
import { theme } from "../theme.js";

const ROWS_PER_ENTRY = 2;
/** One row at the bottom is reserved for the version footer. */
const FOOTER_ROWS = 1;

function VersionFooter() {
  const readonly = useReadonly();
  return (
    <box style={{ flexDirection: "row" }}>
      <text {...theme.meta}>baileys v{getBaileysVersion()}</text>
      {readonly ? <text fg="cyan">{"  read-only"}</text> : null}
    </box>
  );
}

export function ChatListScreen() {
  const chats = useChats();
  const navigation = useNavigation();
  const { width: terminalWidth, height } = useTerminalDimensions();
  // Rows render inside the centered layout container, not the full terminal (see App.tsx).
  const width = layoutWidth(terminalWidth);

  // Tracked by jid (not index) so the highlighted row follows the same chat across re-sorts.
  const [selectedJid, setSelectedJid] = useState<string | null>(null);

  useEffect(() => {
    if (selectedJid === null && chats.length > 0) {
      setSelectedJid(chats[0].jid);
    }
  }, [chats, selectedJid]);

  const effectiveJid = selectedJid ?? chats[0]?.jid ?? null;
  const selectedIndex = useMemo(() => {
    const index = chats.findIndex((chat) => chat.jid === effectiveJid);
    return index === -1 ? 0 : index;
  }, [chats, effectiveJid]);

  useKeyboard((key) => {
    if (chats.length === 0) return;
    if (key.name === "up") {
      setSelectedJid(chats[Math.max(0, selectedIndex - 1)].jid);
    } else if (key.name === "down") {
      setSelectedJid(chats[Math.min(chats.length - 1, selectedIndex + 1)].jid);
    } else if (key.name === "return") {
      navigation.openChat(chats[selectedIndex].jid);
    }
  });

  if (chats.length === 0) {
    return (
      <box style={{ flexGrow: 1, flexDirection: "column" }}>
        <box style={{ flexGrow: 1, alignItems: "center", justifyContent: "center" }}>
          <text {...theme.meta}>No chats yet — still syncing…</text>
        </box>
        <VersionFooter />
      </box>
    );
  }

  const visibleCount = Math.max(1, Math.floor((height - FOOTER_ROWS) / ROWS_PER_ENTRY));
  const startIndex =
    chats.length <= visibleCount
      ? 0
      : Math.min(Math.max(0, selectedIndex - Math.floor(visibleCount / 2)), chats.length - visibleCount);
  const visibleChats = chats.slice(startIndex, startIndex + visibleCount);

  return (
    <box style={{ flexGrow: 1, flexDirection: "column" }}>
      <box style={{ flexGrow: 1, flexDirection: "column" }}>
        {visibleChats.map((chat) => (
          <ChatListItem key={chat.jid} chat={chat} selected={chat.jid === effectiveJid} width={width} />
        ))}
      </box>
      <VersionFooter />
    </box>
  );
}
