import { jidNormalizedUser } from "baileys";
import fs from "node:fs/promises";
import path from "node:path";
import { getLogger } from "../logger.js";
import { importAuthDir, readCredsMeFromDb, wipeAuth } from "../whatsapp/authState.js";
import { accountDbExists, openAccountDb } from "./db.js";
import { accountsRootDir } from "./paths.js";

/**
 * Account lifecycle. Creds live in the account database (`auth_kv` in
 * chats.db); pending pairings use a multi-file dir (no identity → no
 * account DB yet) and are imported on finalization. The one invariant
 * everything here obeys: chat history and media are NEVER deleted.
 * "Removing" an account only wipes its creds, which hides it from the
 * boot-time selector; re-linking the same phone resolves to the same account
 * id and picks the dormant data back up.
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

/** Read the paired identity out of a pending multi-file auth dir. */
async function readCredsMeFromDir(authDir: string): Promise<CredsMe | null> {
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

/** Paired identity of an account, from its DB creds. */
async function readAccountCredsMe(accountId: string): Promise<CredsMe | null> {
  if (!accountDbExists(accountId)) return null;
  const db = await openAccountDb(accountId);
  try {
    return readCredsMeFromDb(db);
  } finally {
    db.close();
  }
}

/** Map a creds `me.id` (possibly device-suffixed, e.g. `…:9@s.whatsapp.net`) to an account id. */
export function accountIdFromMeId(meId: string): string {
  return jidNormalizedUser(meId);
}

/**
 * Accounts shown in the boot-time selector: those with paired creds in their
 * DB. Account dirs whose creds were removed (or never finished pairing) are
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
    const me = await readAccountCredsMe(entry.name);
    if (me) accounts.push({ id: entry.name, name: me.name });
  }
  return accounts.sort((a, b) => (a.name ?? a.id).localeCompare(b.name ?? b.id));
}

/**
 * "Remove" an account: wipe its creds so it disappears from the selector.
 * Chat history and media are deliberately left in place — if the same phone
 * links again it resumes this account with its history intact.
 */
export async function removeAccountCreds(accountId: string): Promise<void> {
  if (!accountDbExists(accountId)) return;
  const db = await openAccountDb(accountId);
  try {
    wipeAuth(db);
  } finally {
    db.close();
  }
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
 * A pending pairing succeeded: its creds now say who we are. Import them into
 * the account's database — replacing any stale creds from a previous link of
 * the same phone — and leave existing chat data untouched so a re-linked
 * account resumes its history.
 */
export async function finalizePendingAccount(pendingAuthDir: string): Promise<AccountInfo> {
  const me = await readCredsMeFromDir(pendingAuthDir);
  if (!me) throw new Error(`pending auth dir has no paired creds: ${pendingAuthDir}`);
  const id = accountIdFromMeId(me.id);

  const db = await openAccountDb(id);
  try {
    wipeAuth(db);
    await importAuthDir(db, pendingAuthDir);
    if (!readCredsMeFromDb(db)) {
      throw new Error(`pending auth import produced no readable creds for ${id}`);
    }
  } finally {
    db.close();
  }
  await fs.rm(pendingAuthDir, { recursive: true, force: true });
  return { id, name: me.name };
}
