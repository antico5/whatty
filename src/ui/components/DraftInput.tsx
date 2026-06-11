import { useKeyboard } from "@opentui/react";
import { useState } from "react";
import { theme } from "../theme.js";

export interface DraftInputProps {
  onSubmit: (text: string) => void;
  readonly?: boolean;
}

const PLACEHOLDER = "Type a message…";
const READONLY_PLACEHOLDER = "read-only mode";

/**
 * Built by hand (not OpenTUI's native `<input>`/`<textarea>`) because `↑`/`↓` must always
 * scroll the message history, even while the draft is being edited — a native input would
 * swallow arrow keys for cursor movement instead. No newline support, draft isn't persisted.
 */
export function DraftInput({ onSubmit, readonly = false }: DraftInputProps) {
  const [draft, setDraft] = useState("");

  useKeyboard((key) => {
    if (readonly) return;
    if (key.name === "return") {
      const trimmed = draft.trim();
      if (trimmed) {
        onSubmit(trimmed);
        setDraft("");
      }
      return;
    }
    if (key.name === "backspace" || key.name === "delete") {
      setDraft((current) => current.slice(0, -1));
      return;
    }
    // Navigation keys (↑/↓/Esc) and modified combos are handled by the screen — never typed.
    if (key.ctrl || key.meta || key.name === "up" || key.name === "down" || key.name === "escape") {
      return;
    }
    const sequence = key.sequence;
    if (sequence && sequence.charCodeAt(0) >= 0x20) {
      setDraft((current) => current + sequence);
    }
  });

  if (readonly) {
    return (
      <box style={{ flexDirection: "row" }}>
        <text fg="cyan">{READONLY_PLACEHOLDER}</text>
      </box>
    );
  }

  return (
    <box style={{ flexDirection: "row" }}>
      <text {...theme.accent}>{"> "}</text>
      {draft ? <text>{draft}</text> : <text {...theme.meta}>{PLACEHOLDER}</text>}
    </box>
  );
}
