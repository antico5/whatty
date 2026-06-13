import { useKeyboard, useTerminalDimensions } from "@opentui/react";
import { useEffect, useMemo, useState } from "react";
import { useAppStore, useChats, useReadReceipts } from "../../store/StoreContext.js";
import { useNavigation } from "../App.js";
import { ChatListItem } from "../components/ChatListItem.js";
import { ConfirmModal } from "../components/ConfirmModal.js";
import { HelpModal } from "../components/HelpModal.js";
import { layoutWidth } from "../layout.js";
import { theme } from "../theme.js";

const ROWS_PER_ENTRY = 2;
/** Status bar (App.tsx) + hint bar = 2 fixed footer rows. */
const FOOTER_ROWS = 2;

export function ChatListScreen({
  initialSelectedJid,
}: {
  initialSelectedJid?: string | null;
}) {
  const chats = useChats();
  const navigation = useNavigation();
  const store = useAppStore();
  const readReceipts = useReadReceipts();
  const { width: terminalWidth, height } = useTerminalDimensions();
  // Rows render inside the centered layout container, not the full terminal (see App.tsx).
  const width = layoutWidth(terminalWidth);

  // Tracked by jid (not index) so the highlighted row follows the same chat across re-sorts.
  const [selectedJid, setSelectedJid] = useState<string | null>(
    initialSelectedJid ?? null,
  );
  // When true the ConfirmModal is shown and the list keyboard is suppressed.
  const [confirmingExit, setConfirmingExit] = useState(false);
  const [showHelp, setShowHelp] = useState(false);

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

  // List navigation — suppressed while any modal is open.
  useKeyboard((key) => {
    if (confirmingExit) return;
    if (showHelp) return;
    if (key.name === "escape") {
      setConfirmingExit(true);
      return;
    }
    if (key.name === "h" && !key.ctrl && !key.meta) {
      setShowHelp(true);
      return;
    }
    if (key.name === "r" && !key.ctrl && !key.meta) {
      store.toggleReadReceipts();
      return;
    }
    if (chats.length === 0) return;
    if (key.name === "up") {
      setSelectedJid(chats[Math.max(0, selectedIndex - 1)].jid);
    } else if (key.name === "down") {
      setSelectedJid(chats[Math.min(chats.length - 1, selectedIndex + 1)].jid);
    } else if (key.name === "return") {
      navigation.openChat(chats[selectedIndex].jid);
    }
  });

  if (chats.length === 0 && !confirmingExit) {
    return (
      <box style={{ flexGrow: 1, flexDirection: "column" }}>
        <box
          style={{
            flexGrow: 1,
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <text {...theme.meta}>No chats yet — still syncing…</text>
        </box>
      </box>
    );
  }

  const visibleCount = Math.max(
    1,
    Math.floor((height - FOOTER_ROWS) / ROWS_PER_ENTRY),
  );
  const startIndex =
    chats.length <= visibleCount
      ? 0
      : Math.min(
          Math.max(0, selectedIndex - Math.floor(visibleCount / 2)),
          chats.length - visibleCount,
        );
  const visibleChats = chats.slice(startIndex, startIndex + visibleCount);

  return (
    <box style={{ flexGrow: 1, flexDirection: "column" }}>
      {visibleChats.map((chat) => (
        <ChatListItem
          key={chat.jid}
          chat={chat}
          selected={chat.jid === effectiveJid}
          width={width}
        />
      ))}
      <box style={{ flexGrow: 1 }} />
      <box id="chatListScreenStatusBar" style={{ flexDirection: "row" }}>
        <text {...theme.hint}>{`Read (R)eceipts: ${readReceipts ? "ON" : "OFF"}`}</text>
        <text id="helpText" style={{ marginLeft: "auto" }} {...theme.hint}>
          {"Press H for help"}
        </text>
      </box>
      {confirmingExit && (
        <ConfirmModal
          message="Go back to account selection?"
          onConfirm={() => {
            setConfirmingExit(false);
            void store.leaveSession();
          }}
          onCancel={() => setConfirmingExit(false)}
        />
      )}
      {showHelp && <HelpModal onClose={() => setShowHelp(false)} />}
    </box>
  );
}
