import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  cleanupPendingAuthDirs,
  createPendingAuthDir,
  finalizePendingAccount,
  listLinkedAccounts,
  migrateLegacyLayout,
  removeAccountCreds,
} from "./accounts.js";
import {
  accountAuthDir,
  accountChatsDir,
  accountsRootDir,
  legacyAuthDir,
  legacyChatsDir,
} from "./paths.js";

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

async function exists(p: string): Promise<boolean> {
  return fs.stat(p).then(() => true).catch(() => false);
}

describe("listLinkedAccounts", () => {
  it("lists only account dirs with paired creds, skipping pending and creds-less dirs", async () => {
    await writeCreds(accountAuthDir(ACCOUNT_ID), { id: "5491100000000:7@s.whatsapp.net", name: "Main" });
    // removed account: chats remain, creds gone
    await fs.mkdir(accountChatsDir("removed@s.whatsapp.net"), { recursive: true });
    // unpaired creds (no `me`)
    await writeCreds(accountAuthDir("unpaired@s.whatsapp.net"), null);
    // in-progress pairing
    await fs.mkdir(path.join(accountsRootDir(), ".pending-123"), { recursive: true });

    expect(await listLinkedAccounts()).toEqual([{ id: ACCOUNT_ID, name: "Main" }]);
  });

  it("returns empty when the accounts dir does not exist", async () => {
    expect(await listLinkedAccounts()).toEqual([]);
  });
});

describe("removeAccountCreds", () => {
  it("deletes only the auth dir, never the chats", async () => {
    await writeCreds(accountAuthDir(ACCOUNT_ID), { id: ACCOUNT_ID });
    const chatDir = path.join(accountChatsDir(ACCOUNT_ID), "123@s.whatsapp.net");
    await fs.mkdir(chatDir, { recursive: true });

    await removeAccountCreds(ACCOUNT_ID);

    expect(await exists(accountAuthDir(ACCOUNT_ID))).toBe(false);
    expect(await exists(chatDir)).toBe(true);
    expect(await listLinkedAccounts()).toEqual([]);
  });
});

describe("finalizePendingAccount", () => {
  it("moves pending creds into the account dir derived from the normalized me.id", async () => {
    const pending = await createPendingAuthDir();
    await writeCreds(pending, { id: "5491100000000:7@s.whatsapp.net", name: "Main" });

    const account = await finalizePendingAccount(pending);

    expect(account).toEqual({ id: ACCOUNT_ID, name: "Main" });
    expect(await exists(path.join(accountAuthDir(ACCOUNT_ID), "creds.json"))).toBe(true);
    expect(await exists(pending)).toBe(false);
  });

  it("re-linking resumes the existing chat data and replaces stale creds", async () => {
    const chatDir = path.join(accountChatsDir(ACCOUNT_ID), "123@s.whatsapp.net");
    await fs.mkdir(chatDir, { recursive: true });
    await writeCreds(accountAuthDir(ACCOUNT_ID), { id: "stale" });

    const pending = await createPendingAuthDir();
    await writeCreds(pending, { id: `${ACCOUNT_ID.split("@")[0]}:9@s.whatsapp.net`, name: "Back" });
    const account = await finalizePendingAccount(pending);

    expect(account.id).toBe(ACCOUNT_ID);
    expect(await exists(chatDir)).toBe(true);
    const creds = JSON.parse(
      await fs.readFile(path.join(accountAuthDir(ACCOUNT_ID), "creds.json"), "utf8"),
    ) as { me: { name: string } };
    expect(creds.me.name).toBe("Back");
  });

  it("rejects a pending dir without paired creds", async () => {
    const pending = await createPendingAuthDir();
    await expect(finalizePendingAccount(pending)).rejects.toThrow(/no paired creds/);
  });
});

describe("cleanupPendingAuthDirs", () => {
  it("removes only pending dirs", async () => {
    await writeCreds(accountAuthDir(ACCOUNT_ID), { id: ACCOUNT_ID });
    const pending = await createPendingAuthDir();

    await cleanupPendingAuthDirs();

    expect(await exists(pending)).toBe(false);
    expect(await exists(accountAuthDir(ACCOUNT_ID))).toBe(true);
  });
});

describe("migrateLegacyLayout", () => {
  it("moves legacy auth and chats under the account dir named by the creds identity", async () => {
    await writeCreds(legacyAuthDir(), { id: "5491100000000:7@s.whatsapp.net", name: "Main" });
    const legacyChat = path.join(legacyChatsDir(), "123@s.whatsapp.net");
    await fs.mkdir(legacyChat, { recursive: true });
    await fs.writeFile(path.join(legacyChat, "chats.json"), "{}", "utf8");

    await migrateLegacyLayout();

    expect(await exists(legacyAuthDir())).toBe(false);
    expect(await exists(legacyChatsDir())).toBe(false);
    expect(await exists(path.join(accountAuthDir(ACCOUNT_ID), "creds.json"))).toBe(true);
    expect(await exists(path.join(accountChatsDir(ACCOUNT_ID), "123@s.whatsapp.net", "chats.json"))).toBe(true);
    expect(await listLinkedAccounts()).toEqual([{ id: ACCOUNT_ID, name: "Main" }]);
  });

  it("is a no-op without legacy data, and leaves unattributable legacy data in place", async () => {
    await migrateLegacyLayout(); // nothing to do

    // legacy chats but creds without identity → cannot attribute, must not touch
    await writeCreds(legacyAuthDir(), null);
    const legacyChat = path.join(legacyChatsDir(), "123@s.whatsapp.net");
    await fs.mkdir(legacyChat, { recursive: true });

    await migrateLegacyLayout();

    expect(await exists(legacyChat)).toBe(true);
    expect(await exists(path.join(legacyAuthDir(), "creds.json"))).toBe(true);
  });

  it("does not overwrite an already-populated account dir", async () => {
    await writeCreds(legacyAuthDir(), { id: ACCOUNT_ID });
    await writeCreds(accountAuthDir(ACCOUNT_ID), { id: ACCOUNT_ID, name: "Existing" });

    await migrateLegacyLayout();

    expect(await exists(legacyAuthDir())).toBe(true);
    const creds = JSON.parse(
      await fs.readFile(path.join(accountAuthDir(ACCOUNT_ID), "creds.json"), "utf8"),
    ) as { me: { name?: string } };
    expect(creds.me.name).toBe("Existing");
  });
});
