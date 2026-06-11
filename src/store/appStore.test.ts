import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { WAMessage } from "baileys";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AccountInfo } from "../persistence/accounts.js";
import { saveChat } from "../persistence/chatStore.js";
import { accountChatsDir, setActiveAccount } from "../persistence/paths.js";
import { createEmptyChat } from "../types/index.js";
import type { Connection } from "../whatsapp/connection.js";
import { createAppStore, type AppStoreDeps } from "./appStore.js";

let tmpDir: string;
let originalDataDir: string | undefined;

const ACCOUNT_ID = "999999999@s.whatsapp.net";

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "whatsapp-terminal-store-"));
  originalDataDir = process.env.WHATSAPP_TERMINAL_DATA_DIR;
  process.env.WHATSAPP_TERMINAL_DATA_DIR = tmpDir;
  setActiveAccount(null);
});

afterEach(async () => {
  if (originalDataDir === undefined) delete process.env.WHATSAPP_TERMINAL_DATA_DIR;
  else process.env.WHATSAPP_TERMINAL_DATA_DIR = originalDataDir;
  setActiveAccount(null);
  await fs.rm(tmpDir, { recursive: true, force: true });
});

const JID_A = "111111111@s.whatsapp.net";
const JID_B = "222222222@s.whatsapp.net";

function fakeConnection(): Connection & EventEmitter {
  const emitter = new EventEmitter() as Connection & EventEmitter;
  emitter.start = async () => {};
  emitter.stop = async () => {};
  emitter.sendText = (() => Promise.resolve(undefined)) as Connection["sendText"];
  emitter.getSocket = () => null;
  return emitter;
}

interface FakeAccountsWorld {
  deps: Partial<AppStoreDeps>;
  connections: (Connection & EventEmitter)[];
  removedCreds: string[];
  accounts: AccountInfo[];
}

/** In-memory account registry + connection factory wired into the store's deps. */
function fakeWorld(initialAccounts: AccountInfo[]): FakeAccountsWorld {
  const world: FakeAccountsWorld = {
    connections: [],
    removedCreds: [],
    accounts: [...initialAccounts],
    deps: {},
  };
  world.deps = {
    createConnection: () => {
      const conn = fakeConnection();
      world.connections.push(conn);
      return conn;
    },
    listLinkedAccounts: async () => world.accounts.filter((a) => !world.removedCreds.includes(a.id)),
    migrateLegacyLayout: async () => {},
    cleanupPendingAuthDirs: async () => {},
    createPendingAuthDir: async () => path.join(tmpDir, "accounts", ".pending-test"),
    finalizePendingAccount: async () => {
      const account = { id: ACCOUNT_ID, name: "Linked" };
      if (!world.accounts.some((a) => a.id === account.id)) world.accounts.push(account);
      return account;
    },
    removeAccountCreds: async (id: string) => {
      world.removedCreds.push(id);
    },
  };
  return world;
}

/** Persist a chat into a specific account's data dir (mimics what ingest does live). */
async function seedChat(accountId: string, jid: string, displayName: string, lastActivity: number): Promise<void> {
  setActiveAccount(accountId);
  await saveChat({ ...createEmptyChat(jid, "individual"), displayName, lastActivity });
  setActiveAccount(null);
}

/** Wait for the store's per-jid reload queue (chained promises) to drain. */
async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 20));
}

describe("appStore", () => {
  it("boots into the selector when accounts exist, and into link mode when none do", async () => {
    const withAccounts = fakeWorld([{ id: ACCOUNT_ID, name: "Main" }]);
    const store = createAppStore(withAccounts.deps);
    await store.init();
    expect(store.getPhase()).toBe("select");
    expect(store.getAccounts()).toEqual([{ id: ACCOUNT_ID, name: "Main" }]);
    expect(withAccounts.connections).toHaveLength(0);

    const empty = fakeWorld([]);
    const store2 = createAppStore(empty.deps);
    await store2.init();
    expect(store2.getPhase()).toBe("link");
    expect(empty.connections).toHaveLength(1);
  });

  it("selecting an account loads its persisted chats sorted by lastActivity desc", async () => {
    await seedChat(ACCOUNT_ID, JID_A, "Alice", 1000);
    await seedChat(ACCOUNT_ID, JID_B, "Bob", 2000);

    const world = fakeWorld([{ id: ACCOUNT_ID, name: "Main" }]);
    const store = createAppStore(world.deps);
    await store.init();
    await store.selectAccount(ACCOUNT_ID);

    expect(store.getPhase()).toBe("session");
    expect(store.getChats().map((c) => c.jid)).toEqual([JID_B, JID_A]);
    expect(store.getChat(JID_A)?.displayName).toBe("Alice");
    expect(store.getChat("nonexistent@s.whatsapp.net")).toBeNull();
  });

  it("keeps accounts' chats separate", async () => {
    const otherAccount = "888888888@s.whatsapp.net";
    await seedChat(ACCOUNT_ID, JID_A, "Alice", 1000);
    await seedChat(otherAccount, JID_B, "Bob", 2000);

    const world = fakeWorld([
      { id: ACCOUNT_ID, name: "Main" },
      { id: otherAccount, name: "Work" },
    ]);
    const store = createAppStore(world.deps);
    await store.init();
    await store.selectAccount(otherAccount);

    expect(store.getChats().map((c) => c.jid)).toEqual([JID_B]);
  });

  it("reflects qr and status events from the connection, clearing qr on open", async () => {
    const world = fakeWorld([{ id: ACCOUNT_ID, name: "Main" }]);
    const store = createAppStore(world.deps);
    let notifications = 0;
    const unsubscribe = store.subscribe(() => {
      notifications += 1;
    });

    await store.init();
    await store.selectAccount(ACCOUNT_ID);
    const conn = world.connections[0];

    conn.emit("qr", "qr-code-data");
    expect(store.getConnection()).toEqual({ connectionState: "connecting", qr: "qr-code-data" });

    conn.emit("status", "open");
    expect(store.getConnection()).toEqual({ connectionState: "open", qr: null });

    expect(notifications).toBeGreaterThan(0);
    unsubscribe();
  });

  it("reloads and re-sorts the chat list on chat-updated", async () => {
    await seedChat(ACCOUNT_ID, JID_A, "Alice", 1000);

    const world = fakeWorld([{ id: ACCOUNT_ID, name: "Main" }]);
    const store = createAppStore(world.deps);
    await store.init();
    await store.selectAccount(ACCOUNT_ID);
    const conn = world.connections[0];

    expect(store.getChats().map((c) => c.jid)).toEqual([JID_A]);

    // A fresh inbound message for a brand-new chat, run through the real
    // ingestor (wired up by the session), persisted to the temp data dir, and
    // surfaced to the store via "chat-updated".
    conn.emit("messages", {
      messages: [
        {
          key: { remoteJid: JID_B, fromMe: false, id: "m1" },
          messageTimestamp: 5000,
          pushName: "Bob",
          message: { conversation: "hi there" },
        } as unknown as WAMessage,
      ],
      type: "notify",
    });

    await flush();
    await flush();

    expect(store.getChats().map((c) => c.jid)).toEqual([JID_B, JID_A]);
    expect(store.getChat(JID_B)?.messages[0]?.text).toBe("hi there");
  });

  it("on logged-out: removes only the creds, keeps chat data, and returns to the selector", async () => {
    const otherAccount = "888888888@s.whatsapp.net";
    await seedChat(ACCOUNT_ID, JID_A, "Alice", 1000);

    const world = fakeWorld([
      { id: ACCOUNT_ID, name: "Main" },
      { id: otherAccount, name: "Work" },
    ]);
    const store = createAppStore(world.deps);
    await store.init();
    await store.selectAccount(ACCOUNT_ID);
    expect(store.getChats()).toHaveLength(1);

    world.connections[0].emit("status", "logged-out");
    await flush();

    expect(world.removedCreds).toEqual([ACCOUNT_ID]);
    expect(store.getPhase()).toBe("select");
    expect(store.getAccounts()).toEqual([{ id: otherAccount, name: "Work" }]);
    expect(store.getChats()).toEqual([]);
    // chat data survives the "removal" — only creds are gone
    const chatsOnDisk = await fs.readdir(accountChatsDir(ACCOUNT_ID));
    expect(chatsOnDisk).toContain(JID_A);
  });

  it("on logged-out with no other account, falls through to link mode", async () => {
    const world = fakeWorld([{ id: ACCOUNT_ID, name: "Main" }]);
    const store = createAppStore(world.deps);
    await store.init();
    await store.selectAccount(ACCOUNT_ID);

    world.connections[0].emit("status", "logged-out");
    await flush();

    expect(store.getPhase()).toBe("link");
    // a second (link-mode) connection was started
    expect(world.connections).toHaveLength(2);
  });

  it("pairing in link mode finalizes the account and starts its session", async () => {
    const world = fakeWorld([]);
    const store = createAppStore(world.deps);
    await store.init();
    expect(store.getPhase()).toBe("link");

    world.connections[0].emit("paired", ACCOUNT_ID);
    await flush();

    expect(store.getPhase()).toBe("session");
    expect(store.getAccounts().map((a) => a.id)).toEqual([ACCOUNT_ID]);
    // link connection + session connection
    expect(world.connections).toHaveLength(2);
  });
});
