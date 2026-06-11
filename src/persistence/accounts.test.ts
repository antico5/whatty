import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  cleanupPendingAuthDirs,
  createPendingAuthDir,
  finalizePendingAccount,
  listLinkedAccounts,
  removeAccountCreds,
  type AccountInfo,
} from "./accounts.js";
import { openAccountDb } from "./db.js";
import { accountDbFile, accountDir, accountsRootDir } from "./paths.js";

let tmpDir: string;
let originalDataDir: string | undefined;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "whatsapp-terminal-accounts-"));
  originalDataDir = process.env.WHATSAPP_TERMINAL_DATA_DIR;
  process.env.WHATSAPP_TERMINAL_DATA_DIR = tmpDir;
});

afterEach(async () => {
  if (originalDataDir === undefined) delete process.env.WHATSAPP_TERMINAL_DATA_DIR;
  else process.env.WHATSAPP_TERMINAL_DATA_DIR = originalDataDir;
  await fs.rm(tmpDir, { recursive: true, force: true });
});

const ACCOUNT_ID = "5491100000000@s.whatsapp.net";

async function writeCreds(authDir: string, me: { id: string; name?: string } | null): Promise<void> {
  await fs.mkdir(authDir, { recursive: true });
  await fs.writeFile(path.join(authDir, "creds.json"), JSON.stringify(me ? { me } : {}), "utf8");
}

/** Run the real pairing flow: pending dir with paired creds → finalized account DB. */
async function linkAccount(meId: string, name: string): Promise<AccountInfo> {
  const pending = await createPendingAuthDir();
  await writeCreds(pending, { id: meId, name });
  return finalizePendingAccount(pending);
}

async function insertChatRow(accountId: string, jid: string): Promise<void> {
  const db = await openAccountDb(accountId);
  try {
    db.sql.prepare("INSERT INTO chats (jid, type) VALUES (?, 'individual')").run(jid);
  } finally {
    db.close();
  }
}

async function countChatRows(accountId: string): Promise<number> {
  const db = await openAccountDb(accountId);
  try {
    return (db.sql.prepare("SELECT COUNT(*) AS n FROM chats").get() as { n: number }).n;
  } finally {
    db.close();
  }
}

async function exists(p: string): Promise<boolean> {
  return fs.stat(p).then(() => true).catch(() => false);
}

describe("listLinkedAccounts", () => {
  it("lists only accounts with paired DB creds, skipping pending and creds-less dirs", async () => {
    await linkAccount("5491100000000:7@s.whatsapp.net", "Main");
    // removed account: DB with wiped creds remains, chats stay dormant
    await linkAccount("5491100000001:2@s.whatsapp.net", "Gone");
    await removeAccountCreds("5491100000001@s.whatsapp.net");
    // account dir without a DB (e.g. only media left behind)
    await fs.mkdir(path.join(accountDir("nodb@s.whatsapp.net"), "media"), { recursive: true });
    // in-progress pairing
    await fs.mkdir(path.join(accountsRootDir(), ".pending-123"), { recursive: true });

    expect(await listLinkedAccounts()).toEqual([{ id: ACCOUNT_ID, name: "Main" }]);
  });

  it("returns empty when the accounts dir does not exist", async () => {
    expect(await listLinkedAccounts()).toEqual([]);
  });
});

describe("removeAccountCreds", () => {
  it("wipes only the creds, never the chat data", async () => {
    await linkAccount("5491100000000:7@s.whatsapp.net", "Main");
    await insertChatRow(ACCOUNT_ID, "123@s.whatsapp.net");

    await removeAccountCreds(ACCOUNT_ID);

    expect(await listLinkedAccounts()).toEqual([]);
    expect(await exists(accountDbFile(ACCOUNT_ID))).toBe(true);
    expect(await countChatRows(ACCOUNT_ID)).toBe(1);
  });

  it("is a no-op for an account without a DB", async () => {
    await removeAccountCreds(ACCOUNT_ID);
    expect(await exists(accountDbFile(ACCOUNT_ID))).toBe(false);
  });
});

describe("finalizePendingAccount", () => {
  it("imports pending creds into the DB of the account derived from the normalized me.id", async () => {
    const pending = await createPendingAuthDir();
    await writeCreds(pending, { id: "5491100000000:7@s.whatsapp.net", name: "Main" });

    const account = await finalizePendingAccount(pending);

    expect(account).toEqual({ id: ACCOUNT_ID, name: "Main" });
    expect(await exists(accountDbFile(ACCOUNT_ID))).toBe(true);
    expect(await exists(pending)).toBe(false);
    expect(await listLinkedAccounts()).toEqual([{ id: ACCOUNT_ID, name: "Main" }]);
  });

  it("re-linking resumes the existing chat data and replaces stale creds", async () => {
    await linkAccount("5491100000000:7@s.whatsapp.net", "Old");
    await insertChatRow(ACCOUNT_ID, "123@s.whatsapp.net");

    const account = await linkAccount(`${ACCOUNT_ID.split("@")[0]}:9@s.whatsapp.net`, "Back");

    expect(account.id).toBe(ACCOUNT_ID);
    expect(await countChatRows(ACCOUNT_ID)).toBe(1);
    // the fresh creds win over the stale ones
    expect(await listLinkedAccounts()).toEqual([{ id: ACCOUNT_ID, name: "Back" }]);
  });

  it("rejects a pending dir without paired creds", async () => {
    const pending = await createPendingAuthDir();
    await expect(finalizePendingAccount(pending)).rejects.toThrow(/no paired creds/);
  });
});

describe("cleanupPendingAuthDirs", () => {
  it("removes only pending dirs", async () => {
    await linkAccount("5491100000000:7@s.whatsapp.net", "Main");
    const pending = await createPendingAuthDir();

    await cleanupPendingAuthDirs();

    expect(await exists(pending)).toBe(false);
    expect(await listLinkedAccounts()).toEqual([{ id: ACCOUNT_ID, name: "Main" }]);
  });
});
