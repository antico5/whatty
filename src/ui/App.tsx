import { useKeyboard, useRenderer } from "@opentui/react";
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import type { AppStore } from "../store/appStore.js";
import { StoreProvider, useAppStore, useConnection, usePhase } from "../store/StoreContext.js";
import { StatusBar } from "./components/StatusBar.js";
import { LAYOUT_MAX_WIDTH } from "./layout.js";
import { AccountSelectScreen } from "./screens/AccountSelectScreen.js";
import { ChatListScreen } from "./screens/ChatListScreen.js";
import { ChatViewScreen } from "./screens/ChatViewScreen.js";
import { ConnectingScreen } from "./screens/ConnectingScreen.js";
import { PairingScreen } from "./screens/PairingScreen.js";

export interface NavigationApi {
  openChat(jid: string): void;
  back(): void;
}

const NavigationContext = createContext<NavigationApi | null>(null);

export function useNavigation(): NavigationApi {
  const nav = useContext(NavigationContext);
  if (!nav) throw new Error("useNavigation must be used within <App>");
  return nav;
}

function Router(): ReactNode {
  const phase = usePhase();
  const { connectionState, qr } = useConnection();
  // The cached chat list is only honest once we've actually connected — a stale
  // session that can't reach `open` (e.g. the phone unlinked us) must never look
  // like a live one. `hasOpened` latches on the first `open` so transient drops
  // don't yank the user off the list; leaving the session (dead session falls
  // back to the account selector) resets it for whichever account comes next.
  const [hasOpened, setHasOpened] = useState(connectionState === "open");
  const [activeJid, setActiveJid] = useState<string | null>(null);
  const [lastSelectedJid, setLastSelectedJid] = useState<string | null>(null);

  useEffect(() => {
    if (phase !== "session" || connectionState === "logged-out") {
      setHasOpened(false);
      setActiveJid(null);
      setLastSelectedJid(null);
    } else if (connectionState === "open") {
      setHasOpened(true);
    }
  }, [phase, connectionState]);

  const store = useAppStore();
  const navigation = useMemo<NavigationApi>(
    () => ({
      openChat: (jid: string) => {
        setActiveJid(jid);
        store.refreshGroupIfNeeded(jid);
        store.markChatRead(jid);
      },
      back: () => {
        setLastSelectedJid(activeJid);
        setActiveJid(null);
      },
    }),
    [store, activeJid],
  );

  let body: ReactNode;
  if (phase === "select") {
    body = <AccountSelectScreen />;
  } else if (phase === "session" && hasOpened && connectionState !== "logged-out") {
    // The chat screens live in a centered container capped at LAYOUT_MAX_WIDTH columns.
    // Pairing/connecting stay full-screen: the ASCII QR can exceed the cap, and clipping
    // it would make it unscannable. Screens must clamp their character math through
    // `layoutWidth` so it agrees with this container (see layout.ts).
    body = (
      <box style={{ flexGrow: 1, flexDirection: "row", justifyContent: "center" }}>
        <box style={{ flexGrow: 1, maxWidth: LAYOUT_MAX_WIDTH, flexDirection: "column" }}>
          {activeJid !== null ? <ChatViewScreen jid={activeJid} /> : <ChatListScreen initialSelectedJid={lastSelectedJid} />}
          <StatusBar />
        </box>
      </box>
    );
  } else if (qr !== null) {
    body = <PairingScreen />;
  } else {
    // Covers link mode before the first QR arrives, a session connecting, and
    // the brief teardown after a dead session before the selector returns.
    body = <ConnectingScreen />;
  }

  return <NavigationContext.Provider value={navigation}>{body}</NavigationContext.Provider>;
}

export interface AppProps {
  store: AppStore;
  /** Graceful-shutdown sequence (flush saves, stop socket, destroy renderer, exit) — shared with `SIGINT`/`SIGTERM`. */
  onQuit: () => void;
}

export function App({ store, onQuit }: AppProps) {
  const renderer = useRenderer();
  useKeyboard((key) => {
    // Ctrl+D is the app's quit key (Ctrl+C is reserved for copy, below).
    if (key.ctrl && key.name === "d") onQuit();
    // Ctrl+C copies the current in-app selection to the system clipboard (via
    // OSC 52). Because we capture the mouse, drag-selection is opentui's own —
    // the terminal/clipboard knows nothing about it unless we push it here.
    if (key.ctrl && key.name === "c") {
      const text = renderer.getSelection()?.getSelectedText();
      if (text) renderer.copyToClipboardOSC52(text);
    }
  });

  return (
    <StoreProvider store={store}>
      <Router />
    </StoreProvider>
  );
}
