import { useKeyboard } from "@opentui/react";
import { useState } from "react";
import { useAccounts, useAppStore } from "../../store/StoreContext.js";
import { getLogger } from "../../whatsapp/logger.js";
import { theme } from "../theme.js";

const caretStyle = { fg: "yellow" } as const;

/** Strip the JID server suffix for display: `5491100000000@s.whatsapp.net` → `+5491100000000`. */
function phoneOf(accountId: string): string {
  const user = accountId.split("@")[0] ?? accountId;
  return `+${user}`;
}

/**
 * Boot-time account picker, shown when at least one linked account exists.
 * The last entry is always "Link new device", which moves to the QR pairing
 * flow; a successful pairing lands in that account's session directly.
 */
export function AccountSelectScreen() {
  const store = useAppStore();
  const accounts = useAccounts();
  const [selectedIndex, setSelectedIndex] = useState(0);
  // Entries: one per account + trailing "Link new device".
  const entryCount = accounts.length + 1;
  const clampedIndex = Math.min(selectedIndex, entryCount - 1);

  useKeyboard((key) => {
    if (key.name === "up") {
      setSelectedIndex(Math.max(0, clampedIndex - 1));
    } else if (key.name === "down") {
      setSelectedIndex(Math.min(entryCount - 1, clampedIndex + 1));
    } else if (key.name === "return") {
      const action =
        clampedIndex < accounts.length
          ? store.selectAccount(accounts[clampedIndex].id)
          : store.linkNewDevice();
      action.catch((err) => getLogger().error({ err }, "failed to act on account selection"));
    }
  });

  return (
    <box style={{ flexGrow: 1, flexDirection: "column", alignItems: "center", justifyContent: "center" }}>
      <text {...theme.accent}>whatsapp-terminal — Choose an account</text>
      <box style={{ marginTop: 1, flexDirection: "column" }}>
        {accounts.map((account, index) => {
          const selected = index === clampedIndex;
          const label = account.name ? `${account.name}  ${phoneOf(account.id)}` : phoneOf(account.id);
          return (
            <box key={account.id} style={{ flexDirection: "row" }}>
              <text {...(selected ? caretStyle : {})}>{selected ? "› " : "  "}</text>
              <text>{label}</text>
            </box>
          );
        })}
        <box style={{ flexDirection: "row" }}>
          <text {...(clampedIndex === accounts.length ? caretStyle : {})}>{clampedIndex === accounts.length ? "› " : "  "}</text>
          <text {...theme.meta}>Link new device</text>
        </box>
      </box>
      <box style={{ marginTop: 1 }}>
        <text {...theme.meta}>↑/↓ to choose, Enter to open</text>
      </box>
    </box>
  );
}
