import { useKeyboard } from "@opentui/react";
import { useEffect, useState } from "react";
import {
  getStorageSummary,
  type StorageSummary,
} from "../../persistence/diskUsage.js";
import {
  clearAllDataDestructive,
  clearAllMediaDestructive,
  clearLogsDestructive,
} from "../../persistence/storageActions.js";
import { useAccounts, useAppStore } from "../../store/StoreContext.js";
import { checkForUpdate } from "../../updateCheck.js";
import { getLogger } from "../../whatsapp/logger.js";
import { ConfirmModal } from "../components/ConfirmModal.js";
import { theme } from "../theme.js";
import { formatBytes } from "../util/format.js";

const caretStyle = { fg: "yellow" } as const;

/** Strip the JID server suffix for display: `5491100000000@s.whatsapp.net` → `+5491100000000`. */
function phoneOf(accountId: string): string {
  const user = accountId.split("@")[0] ?? accountId;
  return `+${user}`;
}

// ---------------------------------------------------------------------------
// Sub-menu types
// ---------------------------------------------------------------------------

type Menu = "accounts" | "config" | "storage";

// ---------------------------------------------------------------------------
// Config screen (Storage / Back)
// ---------------------------------------------------------------------------

const CONFIG_ENTRIES = ["Storage", "Back"] as const;
type ConfigEntry = (typeof CONFIG_ENTRIES)[number];

interface ConfigScreenProps {
  onSelect: (entry: ConfigEntry) => void;
}

function ConfigScreen({ onSelect }: ConfigScreenProps) {
  const [selectedIndex, setSelectedIndex] = useState(0);

  useKeyboard((key) => {
    if (key.name === "up") {
      setSelectedIndex(Math.max(0, selectedIndex - 1));
    } else if (key.name === "down") {
      setSelectedIndex(Math.min(CONFIG_ENTRIES.length - 1, selectedIndex + 1));
    } else if (key.name === "return") {
      onSelect(CONFIG_ENTRIES[selectedIndex]!);
    } else if (key.name === "escape") {
      onSelect("Back");
    }
  });

  return (
    <box
      style={{
        flexGrow: 1,
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <text {...theme.accent}>Config</text>
      <box style={{ marginTop: 1, flexDirection: "column" }}>
        {CONFIG_ENTRIES.map((entry, index) => {
          const selected = index === selectedIndex;
          return (
            <box key={entry} style={{ flexDirection: "row" }}>
              <text {...(selected ? caretStyle : {})}>
                {selected ? "› " : "  "}
              </text>
              <text>{entry}</text>
            </box>
          );
        })}
      </box>
      <box style={{ marginTop: 1 }}>
        <text {...theme.meta}>↑/↓ to choose, Enter to open, Esc = Back</text>
      </box>
    </box>
  );
}

// ---------------------------------------------------------------------------
// Storage screen
// ---------------------------------------------------------------------------

type StorageAction = "clear-logs" | "clear-media" | "clear-all-data";

const STORAGE_ACTIONS: { key: StorageAction; label: string }[] = [
  { key: "clear-logs", label: "Clear logs" },
  { key: "clear-media", label: "Clear all media" },
  { key: "clear-all-data", label: "Clear all data" },
  // "Back" is appended separately so we can detect it by index
];

const CONFIRM_MESSAGES: Record<StorageAction, string> = {
  "clear-logs":
    "Truncate the log file for ALL accounts? (Logs will keep growing after this.)",
  "clear-media":
    "Delete ALL media files for ALL accounts? Chat history is kept,\nbut media attachments will show as broken links.",
  "clear-all-data":
    "DELETE ALL DATA for ALL accounts? This removes every chat database,\nall media, all logs, and all account directories.\nAll accounts will need to be re-paired.",
};

interface StorageScreenProps {
  onBack: () => void;
}

function StorageScreen({ onBack }: StorageScreenProps) {
  const [summary, setSummary] = useState<StorageSummary | null>(null);
  const [loading, setLoading] = useState(true);
  // selectable entries: STORAGE_ACTIONS + Back
  const entryCount = STORAGE_ACTIONS.length + 1;
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [pendingAction, setPendingAction] = useState<StorageAction | null>(
    null,
  );
  const [busy, setBusy] = useState(false);

  // Load sizes on mount (and after each action)
  useEffect(() => {
    setLoading(true);
    getStorageSummary()
      .then((s) => {
        setSummary(s);
        setLoading(false);
      })
      .catch((err) => {
        getLogger().error({ err }, "failed to load storage summary");
        setLoading(false);
      });
  }, [busy]); // re-run after an action completes (busy transitions false→true→false)

  useKeyboard((key) => {
    if (pendingAction !== null || busy) return; // modal or action in progress
    if (key.name === "up") {
      setSelectedIndex(Math.max(0, selectedIndex - 1));
    } else if (key.name === "down") {
      setSelectedIndex(Math.min(entryCount - 1, selectedIndex + 1));
    } else if (key.name === "return") {
      if (selectedIndex === STORAGE_ACTIONS.length) {
        onBack();
      } else {
        setPendingAction(STORAGE_ACTIONS[selectedIndex]!.key);
      }
    } else if (key.name === "escape") {
      onBack();
    }
  });

  async function runAction(action: StorageAction): Promise<void> {
    setBusy(true);
    try {
      switch (action) {
        case "clear-logs":
          await clearLogsDestructive();
          break;
        case "clear-media":
          await clearAllMediaDestructive();
          break;
        case "clear-all-data":
          await clearAllDataDestructive();
          break;
      }
    } catch (err) {
      getLogger().error({ err, action }, "storage action failed");
    } finally {
      setBusy(false);
    }
  }

  const bd = summary?.mediaBreakdown;

  return (
    <box
      style={{
        flexGrow: 1,
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      {pendingAction !== null && (
        <ConfirmModal
          message={CONFIRM_MESSAGES[pendingAction]}
          onConfirm={() => {
            const action = pendingAction;
            setPendingAction(null);
            void runAction(action);
          }}
          onCancel={() => setPendingAction(null)}
        />
      )}

      <text {...theme.accent}>Storage (all accounts)</text>

      <box style={{ marginTop: 1, flexDirection: "column" }}>
        {loading ? (
          <text {...theme.meta}>Loading…</text>
        ) : summary !== null ? (
          <>
            <box style={{ flexDirection: "row" }}>
              <text>{"Database   "}</text>
              <text {...theme.meta}>{formatBytes(summary.db)}</text>
            </box>
            <box style={{ flexDirection: "row" }}>
              <text>{"Logfile    "}</text>
              <text {...theme.meta}>{formatBytes(summary.log)}</text>
            </box>
            <box style={{ flexDirection: "row" }}>
              <text>{"Media      "}</text>
              <text {...theme.meta}>{formatBytes(summary.mediaTotal)}</text>
            </box>
            {bd && (
              <>
                <box style={{ flexDirection: "row" }}>
                  <text>{"  images   "}</text>
                  <text {...theme.meta}>{formatBytes(bd.images)}</text>
                </box>
                <box style={{ flexDirection: "row" }}>
                  <text>{"  videos   "}</text>
                  <text {...theme.meta}>{formatBytes(bd.videos)}</text>
                </box>
                <box style={{ flexDirection: "row" }}>
                  <text>{"  audio    "}</text>
                  <text {...theme.meta}>{formatBytes(bd.audio)}</text>
                </box>
                <box style={{ flexDirection: "row" }}>
                  <text>{"  stickers "}</text>
                  <text {...theme.meta}>{formatBytes(bd.stickers)}</text>
                </box>
                <box style={{ flexDirection: "row" }}>
                  <text>{"  docs     "}</text>
                  <text {...theme.meta}>{formatBytes(bd.documents)}</text>
                </box>
                <box style={{ flexDirection: "row" }}>
                  <text>{"  other    "}</text>
                  <text {...theme.meta}>{formatBytes(bd.other)}</text>
                </box>
              </>
            )}
          </>
        ) : (
          <text {...theme.meta}>—</text>
        )}
      </box>

      <box style={{ marginTop: 1, flexDirection: "column" }}>
        {STORAGE_ACTIONS.map(({ key, label }, index) => {
          const selected = index === selectedIndex;
          return (
            <box key={key} style={{ flexDirection: "row" }}>
              <text {...(selected ? caretStyle : {})}>
                {selected ? "› " : "  "}
              </text>
              <text {...theme.failed}>{label}</text>
            </box>
          );
        })}
        <box style={{ flexDirection: "row" }}>
          <text
            {...(selectedIndex === STORAGE_ACTIONS.length ? caretStyle : {})}
          >
            {selectedIndex === STORAGE_ACTIONS.length ? "› " : "  "}
          </text>
          <text>Back</text>
        </box>
        {busy && (
          <box style={{ marginTop: 1 }}>
            <text {...theme.meta}>Working…</text>
          </box>
        )}
      </box>

      <box style={{ marginTop: 1 }}>
        <text {...theme.meta}>↑/↓ to choose, Enter to act, Esc = Back</text>
      </box>
    </box>
  );
}

// ---------------------------------------------------------------------------
// Main AccountSelectScreen
// ---------------------------------------------------------------------------

/**
 * Boot-time account picker, shown when at least one linked account exists.
 * The last entry is always "Link new device"; below a separator comes "Config".
 * Config navigates to the Storage screen (and back).
 */
export function AccountSelectScreen() {
  const store = useAppStore();
  const accounts = useAccounts();
  const [menu, setMenu] = useState<Menu>("accounts");
  const [selectedIndex, setSelectedIndex] = useState(0);
  // Latest whatty version on npm, when an upgrade is available. Checked once on
  // mount; resolves to null while in flight, offline, or already up to date, so
  // the selector renders immediately and the notice just appears if/when found.
  const [updateVersion, setUpdateVersion] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void checkForUpdate().then((latest) => {
      if (active) setUpdateVersion(latest);
    });
    return () => {
      active = false;
    };
  }, []);

  // Entries: accounts…, "Link new device", separator (non-selectable), "Config"
  // Selectable indices: 0..accounts.length (Link new device) + 1 (Config)
  // Separator is at accounts.length+1 in display but skipped in navigation.
  const selectableCount = accounts.length + 1 /* Link */ + 1; /* Config */

  const clampedIndex = Math.min(selectedIndex, selectableCount - 1);

  useKeyboard((key) => {
    if (menu !== "accounts") return;
    if (key.name === "up") {
      let next = clampedIndex - 1;
      // skip separator slot (index == accounts.length + 1 in terms of display);
      // the separator is between "Link new device" (accounts.length) and "Config"
      // (accounts.length + 1). Since those are direct neighbours in selectable
      // space, no skip needed — separator is non-selectable display-only.
      setSelectedIndex(Math.max(0, next));
    } else if (key.name === "down") {
      setSelectedIndex(Math.min(selectableCount - 1, clampedIndex + 1));
    } else if (key.name === "return") {
      if (clampedIndex < accounts.length) {
        store
          .selectAccount(accounts[clampedIndex]!.id)
          .catch((err) =>
            getLogger().error({ err }, "failed to select account"),
          );
      } else if (clampedIndex === accounts.length) {
        store
          .linkNewDevice()
          .catch((err) =>
            getLogger().error({ err }, "failed to link new device"),
          );
      } else {
        // Config
        setMenu("config");
      }
    }
  });

  if (menu === "config") {
    return (
      <ConfigScreen
        onSelect={(entry) => {
          if (entry === "Storage") {
            setMenu("storage");
          } else {
            setMenu("accounts");
          }
        }}
      />
    );
  }

  if (menu === "storage") {
    return <StorageScreen onBack={() => setMenu("config")} />;
  }

  // --- accounts menu ---
  const configIndex = accounts.length + 1; // selectable index of "Config"

  return (
    <box
      style={{
        flexGrow: 1,
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <text {...theme.accent}>whatty — Choose an account</text>
      <box style={{ marginTop: 1, flexDirection: "column" }}>
        {accounts.map((account, index) => {
          const selected = index === clampedIndex;
          const label = account.name
            ? `${account.name}  ${phoneOf(account.id)}`
            : phoneOf(account.id);
          return (
            <box key={account.id} style={{ flexDirection: "row" }}>
              <text {...(selected ? caretStyle : {})}>
                {selected ? "› " : "  "}
              </text>
              <text>{label}</text>
            </box>
          );
        })}
        {/* Link new device */}
        <box style={{ flexDirection: "row" }}>
          <text {...(clampedIndex === accounts.length ? caretStyle : {})}>
            {clampedIndex === accounts.length ? "› " : "  "}
          </text>
          <text {...theme.meta}>Link new device</text>
        </box>
        {/* Separator (non-selectable) */}
        <box style={{ flexDirection: "row" }}>
          <text>{"  "}</text>
          <text {...theme.meta}>{"───────────────"}</text>
        </box>
        {/* Config */}
        <box style={{ flexDirection: "row" }}>
          <text {...(clampedIndex === configIndex ? caretStyle : {})}>
            {clampedIndex === configIndex ? "› " : "  "}
          </text>
          <text>Config</text>
        </box>
      </box>
      <box style={{ marginTop: 1 }}>
        <text {...theme.meta}>↑/↓ to choose, Enter to open</text>
      </box>
      {updateVersion && (
        <box style={{ marginTop: 1 }}>
          <text {...theme.hint}>
            {`↑ whatty v${updateVersion} available — update: npm i -g whatty@latest`}
          </text>
        </box>
      )}
    </box>
  );
}
