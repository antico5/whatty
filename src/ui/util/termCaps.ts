/**
 * Terminal capability detection for OSC 8 hyperlinks.
 *
 * Detection is env-based (no runtime query possible without async round-trip):
 *   - `WA_CHAT_HYPERLINKS=1` → force on
 *   - `WA_CHAT_HYPERLINKS=0` → force off
 *   - Otherwise: sniff well-known terminal env vars.
 *
 * Default is **off** for unknown terminals — the absolute-path fallback is
 * harmless, whereas garbled escape sequences would be very visible.
 *
 * Note: @opentui's native Zig renderer performs its own OSC 8 capability
 * detection and conditionally wraps `<a href>` links with the actual escape
 * sequence. Our flag is used at the *layout* level to choose between a
 * short clickable label (1 line) and a chunked absolute path (fallback).
 */

/** Returns true when the running terminal is known to support OSC 8 hyperlinks. */
export function supportsHyperlinks(env: NodeJS.ProcessEnv = process.env): boolean {
  const override = env["WA_CHAT_HYPERLINKS"];
  if (override === "1") return true;
  if (override === "0") return false;

  // TERM_PROGRAM — the most reliable single var.
  const termProgram = env["TERM_PROGRAM"] ?? "";
  if (
    termProgram === "iTerm.app" ||
    termProgram === "WezTerm" ||
    termProgram === "ghostty" ||
    termProgram === "vscode" ||
    termProgram === "Hyper" ||
    termProgram === "kitty"
  ) {
    return true;
  }

  // VTE-based terminals (GNOME Terminal, Tilix, etc.) expose VTE_VERSION.
  // OSC 8 was added in VTE 0.50.0 == 5000 (version encoding is major*10000+minor*100+micro).
  const vteVersion = parseInt(env["VTE_VERSION"] ?? "", 10);
  if (!isNaN(vteVersion) && vteVersion >= 5000) return true;

  // Konsole
  if (env["KONSOLE_VERSION"] !== undefined) return true;

  // Windows Terminal
  if (env["WT_SESSION"] !== undefined) return true;

  // Alacritty (modern versions support OSC 8)
  if (env["ALACRITTY_SOCKET"] !== undefined || env["ALACRITTY_LOG"] !== undefined) return true;

  return false;
}
