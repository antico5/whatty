import { theme } from "../theme.js";

/**
 * Shown on startup while we resume a stored session, before the connection has
 * reached `open`. We deliberately don't render the cached chat list yet — that
 * would look identical to being connected even when the phone has unlinked us.
 */
export function ConnectingScreen() {
  return (
    <box style={{ flexGrow: 1, flexDirection: "column", alignItems: "center", justifyContent: "center" }}>
      <text {...theme.accent}>wa-chat</text>
      <text {...theme.meta}>Connecting to WhatsApp…</text>
    </box>
  );
}
