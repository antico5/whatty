import os from "node:os";
import path from "node:path";

/**
 * On-disk layout (multi-account):
 *
 *   <dataDir>/
 *     accounts/
 *       <accountId>/        ← normalized own JID, e.g. `5491100000000@s.whatsapp.net`
 *         chats.db          ← SQLite: chats, messages, aliases, auth_kv, events
 *         media/            ← message attachments (flat; filenames embed chat + message id)
 *       .pending-<ts>/      ← auth dir for an in-progress "Link new device" pairing
 *
 * JIDs look like `1234567890@s.whatsapp.net`, `123456-78901@g.us`, or
 * `1234567890:12@s.whatsapp.net` (device-suffixed). Every character WhatsApp
 * uses in a JID (`@ . : -` plus alphanumerics) is a valid Linux filename
 * character, so account dirs use the raw JID as the directory name.
 *
 * Exactly one account is active per process at a time, so instead of
 * threading an account id through every store call site, the path helpers
 * resolve against a module-level active account set once when the user picks
 * (or finishes linking) an account.
 */

/** App name used as the data-directory leaf on every platform. */
const APP_DIR_NAME = "whatsapp-terminal";

/**
 * Platform-native data directory for the app (inlined from the env-paths
 * convention — no extra dependency needed):
 *
 * | OS      | Path                                                              |
 * |---------|-------------------------------------------------------------------|
 * | Linux   | `$XDG_DATA_HOME/whatsapp-terminal` → `~/.local/share/whatsapp-terminal` |
 * | macOS   | `~/Library/Application Support/whatsapp-terminal`                 |
 * | Windows | `%LOCALAPPDATA%\whatsapp-terminal\Data`                           |
 */
export function defaultDataDir(): string {
  const home = os.homedir();
  switch (process.platform) {
    case "darwin":
      return path.join(home, "Library", "Application Support", APP_DIR_NAME);
    case "win32": {
      const localAppData = process.env.LOCALAPPDATA ?? path.join(home, "AppData", "Local");
      return path.join(localAppData, APP_DIR_NAME, "Data");
    }
    default:
      // Linux and all other POSIX platforms: honour XDG_DATA_HOME
      return path.join(process.env.XDG_DATA_HOME ?? path.join(home, ".local", "share"), APP_DIR_NAME);
  }
}

let activeAccountId: string | null = null;

export function setActiveAccount(id: string | null): void {
  activeAccountId = id;
}

export function getActiveAccount(): string | null {
  return activeAccountId;
}

export function dataDir(): string {
  return process.env.WHATSAPP_TERMINAL_DATA_DIR ?? defaultDataDir();
}

export function accountsRootDir(): string {
  return path.join(dataDir(), "accounts");
}

export function accountDir(accountId: string): string {
  return path.join(accountsRootDir(), accountId);
}

export function accountDbFile(accountId: string): string {
  return path.join(accountDir(accountId), "chats.db");
}

export function accountMediaDir(accountId: string): string {
  return path.join(accountDir(accountId), "media");
}

function requireActiveAccount(): string {
  if (activeAccountId === null) {
    throw new Error("no active account — call setActiveAccount() before touching account data");
  }
  return activeAccountId;
}

/** Flat media directory of the active account. */
export function mediaDir(): string {
  return accountMediaDir(requireActiveAccount());
}

/** Path to the app-wide log file. */
export function logFilePath(): string {
  return path.join(dataDir(), "whatsapp-terminal.log");
}
