import path from "node:path";

/**
 * On-disk layout (multi-account):
 *
 *   data/
 *     accounts/
 *       <accountId>/        ← normalized own JID, e.g. `5491100000000@s.whatsapp.net`
 *         auth/             ← Baileys creds; deleting this "removes" the account
 *         chats/<jid>/      ← history + media; NEVER deleted (see accounts.ts)
 *       .pending-<ts>/      ← auth dir for an in-progress "Link new device" pairing
 *
 * JIDs look like `1234567890@s.whatsapp.net`, `123456-78901@g.us`, or
 * `1234567890:12@s.whatsapp.net` (device-suffixed). Every character WhatsApp
 * uses in a JID (`@ . : -` plus alphanumerics) is a valid Linux filename
 * character, so we use the raw JID as the directory name — no encoding
 * needed, and the mapping stays trivially reversible (dir name === jid).
 *
 * Exactly one account is active per process at a time, so instead of
 * threading an account id through every chatStore/mediaStore call site, the
 * chat-path helpers resolve against a module-level active account set once
 * when the user picks (or finishes linking) an account.
 */

let activeAccountId: string | null = null;

export function setActiveAccount(id: string | null): void {
  activeAccountId = id;
}

export function getActiveAccount(): string | null {
  return activeAccountId;
}

export function dataDir(): string {
  return process.env.WA_CHAT_DATA_DIR ?? path.resolve(process.cwd(), "data");
}

export function accountsRootDir(): string {
  return path.join(dataDir(), "accounts");
}

export function accountDir(accountId: string): string {
  return path.join(accountsRootDir(), accountId);
}

export function accountAuthDir(accountId: string): string {
  return path.join(accountDir(accountId), "auth");
}

export function accountChatsDir(accountId: string): string {
  return path.join(accountDir(accountId), "chats");
}

/** Pre-multi-account locations, only read by the one-time migration in accounts.ts. */
export function legacyAuthDir(): string {
  return path.join(dataDir(), "auth");
}

export function legacyChatsDir(): string {
  return path.join(dataDir(), "chats");
}

export function chatsRootDir(): string {
  if (activeAccountId === null) {
    throw new Error("no active account — call setActiveAccount() before touching chat data");
  }
  return accountChatsDir(activeAccountId);
}

export function chatDir(jid: string): string {
  return path.join(chatsRootDir(), jid);
}

export function chatFile(jid: string): string {
  return path.join(chatDir(jid), "chats.json");
}

export function mediaDir(jid: string): string {
  return path.join(chatDir(jid), "media");
}
