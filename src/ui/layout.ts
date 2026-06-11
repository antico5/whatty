/**
 * The chat screens render inside a centered container capped at this many columns
 * (see `Router` in App.tsx). Every manual character-math consumer (padding,
 * truncation, wrap points, row counts) must clamp through `layoutWidth` so the
 * Yoga container and the hand-rolled math can never disagree about row width.
 */
export const LAYOUT_MAX_WIDTH = 80;

/** Effective row width inside the layout container for a given terminal width. */
export function layoutWidth(terminalWidth: number): number {
  return Math.min(terminalWidth, LAYOUT_MAX_WIDTH);
}
