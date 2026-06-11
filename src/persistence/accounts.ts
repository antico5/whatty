import { jidNormalizedUser } from "baileys";
import fs from "node:fs/promises";
import path from "node:path";
import { getLogger } from "../logger.js";
import {
  accountAuthDir,
  accountChatsDir,
  accountDir,
  accountsRootDir,
  legacyAuthDir,
  legacyChatsDir,
} from "./paths.js";

/**
 * Account lifecycle on disk (layout in paths.ts). The one invariant everything
 * here obeys: chat history and media are NEVER deleted. "Removing" an account
 * only deletes its `auth/` creds, which hides it from the boot-time selector;
 * re-linking the same phone resolves to the same account id and picks the
 * dormant `chats/` tree back up.
 */

export interface AccountInfo {
  /** Normalized own JID, also the directory name under `data/accounts/`. */
  id: string;
  /** Profile name from creds, for the selector — may lag if changed on the phone. */
  name: string | null;
}

const PENDING_PREFIX = ".pending-";

interface CredsMe {
  id: string;
  name: string | null;
}

/** Read the paired identity out of a Baileys auth dir, or null if absent/unpaired/corrupt. */
async function readCredsMe(authDir: string): Promise<CredsMe | null> {
  let raw: string;
  try {
    raw = await fs.readFile(path.join(authDir, "creds.json"), "utf8");
  } catch {
    return null;
  }
  try {
    const creds = JSON.parse(raw) as { me?: { id?: string; name?: string } };
    if (!creds.me?.id) return null;
    return { id: creds.me.id, name: creds.me.name ?? null };
  } catch (err) {
    getLogger().warn({ err, authDir }, "unparseable creds.json — treating account as unlinked");
    return null;
  }
}

/** Map a creds `me.id` (possibly device-suffixed, e.g. `…:9@s.whatsapp.net`) to an account id. */
export function accountIdFromMeId(meId: string): string {
  return jidNormalizedUser(meId);
}

/**
 * Accounts shown in the boot-time selector: those with paired creds on disk.
 * Account dirs whose creds were removed (or never finished pairing) are
 * silently skipped — their chat data stays dormant until the phone re-links.
 */
export async function listLinkedAccounts(): Promise<AccountInfo[]> {
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(accountsRootDir(), { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }

  const accounts: AccountInfo[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const me = await readCredsMe(accountAuthDir(entry.name));
    if (me) accounts.push({ id: entry.name, name: me.name });
  }
  return accounts.sort((a, b) => (a.name ?? a.id).localeCompare(b.name ?? b.id));
}

/**
 * "Remove" an account: delete its creds so it disappears from the selector.
 * Chat history and media are deliberately left in place — if the same phone
 * links again it resumes this directory with its history intact.
 */
export async function removeAccountCreds(accountId: string): Promise<void> {
  await fs.rm(accountAuthDir(accountId), { recursive: true, force: true });
}

/** Fresh auth dir for a "Link new device" pairing whose identity isn't known yet. */
export async function createPendingAuthDir(): Promise<string> {
  const dir = path.join(accountsRootDir(), `${PENDING_PREFIX}${Date.now()}`);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

/** Drop leftover pairing dirs from runs that quit mid-link. Creds only — never chat data. */
export async function cleanupPendingAuthDirs(): Promise<void> {
  let entries: string[];
  try {
    entries = await fs.readdir(accountsRootDir());
  } catch {
    return;
  }
  for (const name of entries) {
    if (!name.startsWith(PENDING_PREFIX)) continue;
    await fs.rm(path.join(accountsRootDir(), name), { recursive: true, force: true });
  }
}

/**
 * A pending pairing succeeded: its creds now say who we are. Move them into
 * the account's permanent auth dir — replacing any stale creds from a previous
 * link of the same phone — and leave any existing chats/ untouched so a
 * re-linked account resumes its history.
 */
export async function finalizePendingAccount(pendingAuthDir: string): Promise<AccountInfo> {
  const me = await readCredsMe(pendingAuthDir);
  if (!me) throw new Error(`pending auth dir has no paired creds: ${pendingAuthDir}`);
  const id = accountIdFromMeId(me.id);

  await fs.mkdir(accountChatsDir(id), { recursive: true });
  await fs.rm(accountAuthDir(id), { recursive: true, force: true });
  await fs.rename(pendingAuthDir, accountAuthDir(id));
  return { id, name: me.name };
}

/**
 * One-time migration from the single-account layout (`data/auth` +
 * `data/chats`) into `data/accounts/<id>/{auth,chats}`. The owning account id
 * comes from the legacy creds. Legacy data we can't attribute (creds missing
 * or unpaired) is left exactly where it is — never deleted — and just won't
 * appear in the selector.
 */
export async function migrateLegacyLayout(): Promise<void> {
  const log = getLogger().child({ module: "accounts" });
  const legacyAuth = legacyAuthDir();
  const legacyChats = legacyChatsDir();

  const hasLegacyAuth = await fs.stat(legacyAuth).then(() => true).catch(() => false);
  const hasLegacyChats = await fs.stat(legacyChats).then(() => true).catch(() => false);
  if (!hasLegacyAuth && !hasLegacyChats) return;

  const me = hasLegacyAuth ? await readCredsMe(legacyAuth) : null;
  if (!me) {
    log.warn(
      { legacyAuth, legacyChats },
      "legacy data present but creds have no identity — leaving it in place, unmigrated",
    );
    return;
  }

  const id = accountIdFromMeId(me.id);
  await fs.mkdir(accountDir(id), { recursive: true });

  const authTarget = accountAuthDir(id);
  const chatsTarget = accountChatsDir(id);
  const authTaken = await fs.stat(authTarget).then(() => true).catch(() => false);
  const chatsTaken = await fs.stat(chatsTarget).then(() => true).catch(() => false);
  if (authTaken || chatsTaken) {
    log.warn({ id }, "account dir already populated — leaving legacy data in place, unmigrated");
    return;
  }

  await fs.rename(legacyAuth, authTarget);
  if (hasLegacyChats) await fs.rename(legacyChats, chatsTarget);
  log.info({ id }, "migrated legacy single-account data into accounts layout");
}
