import { useKeyboard } from "@opentui/react";
import { useState } from "react";
import { handleConfirmKey } from "./confirmModalLogic.js";
import { theme } from "../theme.js";

export type { KeyInput } from "./confirmModalLogic.js";
export { handleConfirmKey } from "./confirmModalLogic.js";

export interface ConfirmModalProps {
  /** The question/warning text to display. */
  message: string;
  /** Called when the user confirms (Yes). */
  onConfirm: () => void;
  /** Called when the user cancels (No or Escape). */
  onCancel: () => void;
}

/**
 * A yes/no confirmation overlay.
 *
 * Controls:
 *   ←/→ or h/l — move selection between No and Yes
 *   y           — immediately confirm (shortcut for "yes")
 *   n / Escape  — immediately cancel
 *   Enter       — confirm the currently highlighted choice
 *
 * Default selection is "No" so accidental Enter presses are safe.
 *
 * Reused by plan 13 and any other destructive action that needs a guard.
 */
export function ConfirmModal({ message, onConfirm, onCancel }: ConfirmModalProps) {
  // 0 = No (safe default), 1 = Yes
  const [selected, setSelected] = useState<0 | 1>(0);

  useKeyboard((key) => {
    const next = handleConfirmKey(key, selected, { onConfirm, onCancel });
    if (next !== selected) setSelected(next);
  });

  const noStyle = selected === 0 ? { fg: "yellow" } : {};
  const yesStyle = selected === 1 ? { fg: "yellow" } : {};

  return (
    <box
      backgroundColor="black"
      border={true}
      borderStyle="single"
      borderColor="cyan"
      style={{
        position: "absolute",
        top: "25%",
        left: "10%",
        width: "80%",
        flexDirection: "column",
        alignItems: "center",
        padding: 2,
      }}
    >
      <box style={{ flexDirection: "column", alignItems: "center", padding: 1 }}>
        <text {...theme.failed}>{message}</text>
        <box style={{ marginTop: 1, flexDirection: "row" }}>
          <text {...noStyle}>{selected === 0 ? "[ No ]" : "  No  "}</text>
          <text>{"   "}</text>
          <text {...yesStyle}>{selected === 1 ? "[ Yes ]" : "  Yes  "}</text>
        </box>
        <box style={{ marginTop: 1 }}>
          <text {...theme.meta}>←/→ to choose, Enter to confirm, Esc = No</text>
        </box>
      </box>
    </box>
  );
}
