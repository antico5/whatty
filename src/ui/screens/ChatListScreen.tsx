import { useKeyboard, useTerminalDimensions } from "@opentui/react";
import { useEffect, useMemo, useState } from "react";
import { useAppStore, useChats, useReadReceipts } from "../../store/StoreContext.js";
import { useNavigation } from "../App.js";
import { ChatListItem } from "../components/ChatListItem.js";
import { ConfirmModal } from "../components/ConfirmModal.js";
import { HelpModal } from "../components/HelpModal.js";
import { layoutWidth } from "../layout.js";
import { theme } from "../theme.js";
import { chatSubtitle, chatTitle } from "../util/format.js";

const ROWS_PER_ENTRY = 2;
/**
 * Fixed rows below the scrollable list, measured against the full terminal height:
 * App's `<StatusBar/>` (1) + the read-receipts/help hint row (1) + the blank line
 * above it (that row's `marginTop: 1`) = 3. The `flexGrow` spacer is the flexible
 * filler and is not counted. Undercounting this makes `visibleCount` render one item
 * too many; the column then overflows by a row and — because opentui boxes default to
 * `flexShrink: 1` — Yoga silently collapses a chat row to one line instead of clipping,
 * desyncing the render from `ROWS_PER_ENTRY`. (`ChatListItem`'s root also pins
 * `flexShrink: 0` as a backstop.)
 *
 * The search bar, when visible, occupies one more fixed row — see `footerRows` below,
 * which adds it so the scroll math stays in sync with what's rendered.
 */
const FOOTER_ROWS = 3;

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
  // Search: `writingSearchQuery` = the search box owns the keyboard; `query` = its text.
  // Everything else is derived — the bar shows while writing or whenever a query is set,
  // and a non-empty (trimmed) query filters the list. Both reset together on cancel.
  const [writingSearchQuery, setWritingSearchQuery] = useState(false);
  const [query, setQuery] = useState("");

  useEffect(() => {
    if (selectedJid === null && chats.length > 0) {
      setSelectedJid(chats[0].jid);
    }
  }, [chats, selectedJid]);

  // Filter by chat name and (for individuals) phone number — case-insensitive partial
  // match against the same labels `ChatListItem` renders. Empty query = no filter.
  const searchBarVisible = writingSearchQuery || query !== "";
  const filteredChats = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (q === "") return chats;
    return chats.filter(
      (chat) =>
        chatTitle(chat).toLowerCase().includes(q) ||
        (chatSubtitle(chat) ?? "").toLowerCase().includes(q),
    );
  }, [chats, query]);

  // Selection is resolved against the filtered list so the highlight is always a visible
  // row: when the query narrows past the current selection, the first match highlights.
  const selectedIndex = useMemo(() => {
    const index = filteredChats.findIndex((chat) => chat.jid === selectedJid);
    return index === -1 ? 0 : index;
  }, [filteredChats, selectedJid]);
  const effectiveJid = filteredChats[selectedIndex]?.jid ?? null;

  // List navigation — suppressed while any modal is open.
  useKeyboard((key) => {
    if (confirmingExit) return;
    if (showHelp) return;

    // While the search box is focused it owns the keyboard: printable keys append to the
    // query (so R/H type literally instead of firing) and ↑/↓ are gated until Enter.
    if (writingSearchQuery) {
      if (key.name === "escape") {
        // Cancel: drop the query and the box together, back to the unfiltered list.
        setWritingSearchQuery(false);
        setQuery("");
        return;
      }
      if (key.name === "return") {
        // Commit: keep the query/filter but hand the keyboard back to the list.
        setWritingSearchQuery(false);
        return;
      }
      if (key.name === "backspace" || key.name === "delete") {
        setQuery((current) => current.slice(0, -1));
        return;
      }
      // Navigation keys and modified combos aren't typed (Ctrl+C/D stay global, in App).
      if (key.ctrl || key.meta || key.name === "up" || key.name === "down") return;
      const sequence = key.sequence;
      if (sequence && sequence.charCodeAt(0) >= 0x20) {
        setQuery((current) => current + sequence);
      }
      return;
    }

    // Ctrl+F opens the search box, keeping any committed query for re-editing.
    if (key.ctrl && key.name === "f") {
      if (chats.length > 0) setWritingSearchQuery(true);
      return;
    }
    if (key.name === "escape") {
      // Esc clears outward one level: an active filter first, then the back dialog.
      if (query !== "") {
        setQuery("");
        return;
      }
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
    if (filteredChats.length === 0) return;
    if (key.name === "up") {
      setSelectedJid(filteredChats[Math.max(0, selectedIndex - 1)].jid);
    } else if (key.name === "down") {
      setSelectedJid(filteredChats[Math.min(filteredChats.length - 1, selectedIndex + 1)].jid);
    } else if (key.name === "return") {
      navigation.openChat(filteredChats[selectedIndex].jid);
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

  const footerRows = FOOTER_ROWS + (searchBarVisible ? 1 : 0);
  const visibleCount = Math.max(
    1,
    Math.floor((height - footerRows) / ROWS_PER_ENTRY),
  );
  const startIndex =
    filteredChats.length <= visibleCount
      ? 0
      : Math.min(
          Math.max(0, selectedIndex - Math.floor(visibleCount / 2)),
          filteredChats.length - visibleCount,
        );
  const visibleChats = filteredChats.slice(startIndex, startIndex + visibleCount);

  return (
    <box style={{ flexGrow: 1, flexDirection: "column" }}>
      {filteredChats.length === 0
        ? searchBarVisible && (
            <text {...theme.meta}>No chats match your search</text>
          )
        : visibleChats.map((chat) => (
            <ChatListItem
              key={chat.jid}
              chat={chat}
              selected={chat.jid === effectiveJid}
              width={width}
            />
          ))}
      <box style={{ flexGrow: 1 }} />
      {searchBarVisible && (
        <box id="chatListSearchBar" style={{ flexDirection: "row", marginTop: 1 }}>
          <text {...(writingSearchQuery ? theme.accent : theme.meta)}>{"Search: "}</text>
          <text>{query}</text>
          {writingSearchQuery ? <text {...theme.accent}>{"_"}</text> : null}
        </box>
      )}
      <box id="chatListScreenStatusBar" style={{ flexDirection: "row", justifyContent: "space-between", marginTop: searchBarVisible ? 0 : 1 }}>
        <text {...theme.hint}>{`Read (R)eceipts: ${readReceipts ? "ON" : "OFF"}`}</text>
        <text id="helpText" {...theme.hint}>
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
