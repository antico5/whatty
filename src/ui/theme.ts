/** A small subset of `TextOptions` that components can spread directly onto `<text>`. */
export interface TextStyle {
  fg?: string;
  attributes?: number;
}

/**
 * Mirrors `TextAttributes` bitflags from `@opentui/core` (stable powers of two).
 * Defined locally so this module stays free of `@opentui/core`, which pulls in
 * `bun:ffi` and cannot be loaded outside the Bun runtime (e.g. in vitest).
 */
export const BOLD = 1 << 0;
const ITALIC = 1 << 2;
const UNDERLINE = 1 << 3;
export const INVERSE = 1 << 5;

/**
 * Role → ANSI-16 color map per spec ("Theme & colors (neutral terminal)").
 * Named colors only — never hex — so the UI inherits the terminal's own
 * palette and background.
 */
export const theme = {
  /** Headers, selection bar, focus. */
  accent: { fg: "cyan" } satisfies TextStyle,
  /** Outbound direction indicator / sent ticks. */
  outbound: { fg: "green" } satisfies TextStyle,
  /** Read ticks — distinct from delivered. */
  read: { fg: "brightCyan" } satisfies TextStyle,
  /** Inbound direction / message text — terminal's default foreground. */
  inbound: {} satisfies TextStyle,
  /** Timestamps, phone numbers, last-seen, delivered ticks. */
  meta: { fg: "brightBlack" } satisfies TextStyle,
  /** `file://` media links. */
  mediaLink: { fg: "cyan", attributes: UNDERLINE } satisfies TextStyle,
  /** "This message was deleted" marker. */
  deleted: { fg: "red", attributes: ITALIC } satisfies TextStyle,
  /** Failed-send indicator. */
  failed: { fg: "red" } satisfies TextStyle,
  /** Contextual hints / help prompts. */
  hint: { fg: "yellow" } satisfies TextStyle,
} as const;

/**
 * Palette for group-chat sender names — deliberately excludes roles already carrying
 * meaning elsewhere (cyan=accent, green=outbound, red=failed/deleted, gray=meta) so
 * sender colors never collide with semantic UI colors.
 */
const SENDER_PALETTE = [
  "yellow",
  "magenta",
  "blue",
  "brightYellow",
  "brightMagenta",
  "brightBlue",
  "brightGreen",
  "brightRed",
] as const;

/** Deterministic color per sender id, so the same person always renders in the same color. */
export function senderColor(id: string): TextStyle {
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = (Math.imul(hash, 31) + id.charCodeAt(i)) >>> 0;
  return { fg: SENDER_PALETTE[hash % SENDER_PALETTE.length] };
}
