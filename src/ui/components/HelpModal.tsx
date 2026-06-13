import { useKeyboard } from "@opentui/react";
import { BOLD, theme } from "../theme.js";

interface HelpModalProps {
  onClose: () => void;
}

const BINDINGS: [string, string][] = [
  ["↑ / ↓", "navigate chat list"],
  ["Enter", "open selected chat"],
  ["H", "show / hide this help"],
  ["Esc", "back to account selection"],
  ["↑ / ↓ (chat)", "scroll messages"],
  ["Esc (chat)", "close chat, back to list"],
  ["Ctrl-C", "quit"],
];

const KEY_COL = 16;

export function HelpModal({ onClose }: HelpModalProps) {
  useKeyboard((key) => {
    if (key.name === "escape" || (key.name === "h" && !key.ctrl && !key.meta)) onClose();
  });

  return (
    <box
      style={{
        position: "absolute",
        top: 0,
        left: 0,
        width: "100%",
        height: "100%",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <box
        backgroundColor="black"
        border={true}
        borderStyle="single"
        borderColor="cyan"
        style={{ flexDirection: "column", padding: 2 }}
      >
        <text {...theme.accent} attributes={BOLD}>Keyboard shortcuts</text>
        {BINDINGS.map(([key, action]) => (
          <box key={key} style={{ flexDirection: "row", marginTop: 1 }}>
            <text {...theme.hint}>{key.padEnd(KEY_COL)}</text>
            <text>{action}</text>
          </box>
        ))}
        <box style={{ marginTop: 1 }}>
          <text {...theme.meta}>H or Esc to close</text>
        </box>
      </box>
    </box>
  );
}
