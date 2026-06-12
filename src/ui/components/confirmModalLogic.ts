/**
 * Pure keyboard-event handler for the ConfirmModal.
 *
 * Extracted into a separate module (no @opentui/react dependency) so it can
 * be unit-tested in the Node/vitest environment.
 */

/** Minimal key shape passed to the keyboard handler (subset of @opentui Key). */
export interface KeyInput {
  name: string;
  ctrl?: boolean;
  shift?: boolean;
}

/**
 * Handle a single key press for the ConfirmModal.
 *
 * Returns the new selection state (0=No, 1=Yes) after the key press, and
 * calls `onConfirm` / `onCancel` when the user makes a final decision.
 */
export function handleConfirmKey(
  key: KeyInput,
  selected: 0 | 1,
  callbacks: { onConfirm: () => void; onCancel: () => void },
): 0 | 1 {
  if (key.name === "escape" || key.name === "n") {
    callbacks.onCancel();
    return selected;
  } else if (key.name === "y") {
    callbacks.onConfirm();
    return selected;
  } else if (key.name === "left" || key.name === "h") {
    return 0;
  } else if (key.name === "right" || key.name === "l") {
    return 1;
  } else if (key.name === "return") {
    if (selected === 1) {
      callbacks.onConfirm();
    } else {
      callbacks.onCancel();
    }
    return selected;
  }
  return selected;
}
