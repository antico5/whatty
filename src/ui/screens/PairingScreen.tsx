import { useMemo } from "react";
import qrcodeTerminal from "qrcode-terminal";
import { useConnection } from "../../store/StoreContext.js";
import { theme } from "../theme.js";

/** Render the QR via `qrcode-terminal` into a string instead of letting it write to stdout directly. */
function renderQrAscii(qr: string): string {
  let ascii = "";
  qrcodeTerminal.generate(qr, { small: true }, (output) => {
    ascii = output;
  });
  return ascii;
}

export function PairingScreen() {
  const { connectionState, qr } = useConnection();
  const qrAscii = useMemo(() => (qr ? renderQrAscii(qr) : null), [qr]);

  return (
    <box style={{ flexGrow: 1, flexDirection: "column", alignItems: "center", justifyContent: "center" }}>
      <text {...theme.accent}>wa-chat — Link a device</text>
      <text {...theme.meta}>Phone → WhatsApp → Linked devices → Link a device, then scan.</text>
      <box style={{ marginTop: 1, alignItems: "center" }}>
        {qrAscii ? (
          <text>{qrAscii}</text>
        ) : (
          <text {...theme.meta}>{connectionState === "connecting" ? "Connecting…" : "Waiting for QR…"}</text>
        )}
      </box>
    </box>
  );
}
