import { spawn } from "node:child_process";

/**
 * Copy text to the system clipboard by piping it to a platform clipboard tool.
 *
 * We deliberately do *not* use OSC 52 escape sequences: VTE-based terminals
 * (tilix, gnome-terminal) don't implement OSC 52 clipboard writes, so that path
 * is a silent no-op there. Shelling out to the native helper works regardless of
 * terminal support. Best-effort — failures (no helper installed, no display) are
 * swallowed; the caller has no useful fallback.
 */
export function copyToClipboard(text: string): void {
  const cmd = clipboardCommand();
  if (!cmd) return;
  try {
    const child = spawn(cmd[0], cmd.slice(1), { stdio: ["pipe", "ignore", "ignore"] });
    child.on("error", () => {});
    child.stdin.on("error", () => {});
    child.stdin.end(text);
  } catch {
    // ignore — clipboard is a nicety, never worth crashing the UI for
  }
}

/** Pick the clipboard helper for the current platform/session, or null if none fits. */
function clipboardCommand(): string[] | null {
  if (process.platform === "darwin") return ["pbcopy"];
  if (process.platform === "win32") return ["clip"];
  // Linux/BSD: prefer Wayland, fall back to X11 (xclip, then xsel).
  if (process.env.WAYLAND_DISPLAY) return ["wl-copy"];
  return ["xclip", "-selection", "clipboard"];
}
