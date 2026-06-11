import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createEmptyChat, type Chat, type Message } from "../types/index.js";
import { listChatJids, loadChat } from "./chatStore.js";
import { closeActiveDb, getActiveDb } from "./db.js";
import { prepareActiveAccount } from "./importer.js";
import { accountAuthDir, accountChatsDir, accountMediaDir, setActiveAccount } from "./paths.js";

const ACCOUNT_ID = "5491100000000@s.whatsapp.net";
const PHONE_JID = "5491100000001@s.whatsapp.net";
const LID_JID = "200000000000001@lid";

let tmpDir: string;
let originalDataDir: string | undefined;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "whatsapp-terminal-importer-"));
  originalDataDir = process.env.WHATSAPP_TERMINAL_DATA_DIR;
  process.env.WHATSAPP_TERMINAL_DATA_DIR = tmpDir;
  setActiveAccount(ACCOUNT_ID);
});

afterEach(async () => {
  closeActiveDb();
  if (originalDataDir === undefined) delete process.env.WHATSAPP_TERMINAL_DATA_DIR;
  else process.env.WHATSAPP_TERMINAL_DATA_DIR = originalDataDir;
  setActiveAccount(null);
  await fs.rm(tmpDir, { recursive: true, force: true });
});

function message(id: string, overrides: Partial<Message> = {}): Message {
  return {
    id,
    senderJid: PHONE_JID,
    senderName: "Flor",
    direction: "inbound",
    timestamp: 1000,
    type: "text",
    text: `text of ${id}`,
    media: null,
    quoted: null,
    deliveryStatus: null,
    deleted: false,
    deletedAt: null,
    raw: { key: { id } },
    ...overrides,
  };
}

async function writeLegacyChat(jid: string, chat: Chat, media: Record<string, string> = {}): Promise<void> {
  const dir = path.join(accountChatsDir(ACCOUNT_ID), jid);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "chats.json"), JSON.stringify(chat), "utf8");
  for (const [name, contents] of Object.entries(media)) {
    await fs.mkdir(path.join(dir, "media"), { recursive: true });
    await fs.writeFile(path.join(dir, "media", name), contents, "utf8");
  }
}

async function writeLegacyAuth(): Promise<void> {
  const dir = accountAuthDir(ACCOUNT_ID);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, "creds.json"),
    JSON.stringify({ me: { id: "5491100000000:7@s.whatsapp.net", name: "Main" } }),
    "utf8",
  );
  await fs.writeFile(path.join(dir, "pre-key-1.json"), JSON.stringify({ private: "x", public: "y" }), "utf8");
  // signal lid↔pn pair for LID_JID
  await fs.writeFile(path.join(dir, "lid-mapping-200000000000001_reverse.json"), '"5491100000001"', "utf8");
  await fs.writeFile(path.join(dir, "lid-mapping-5491100000001.json"), '"200000000000001"', "utf8");
}

async function exists(p: string): Promise<boolean> {
  return fs.stat(p).then(() => true).catch(() => false);
}

describe("prepareActiveAccount (legacy import)", () => {
  it("imports auth files into auth_kv and deletes the auth dir", async () => {
    await writeLegacyAuth();
    await prepareActiveAccount();

    expect(await exists(accountAuthDir(ACCOUNT_ID))).toBe(false);
    const db = await getActiveDb();
    const creds = db.sql.prepare("SELECT value FROM auth_kv WHERE key = 'creds'").get() as { value: string };
    expect((JSON.parse(creds.value) as { me: { name: string } }).me.name).toBe("Main");
    expect(db.sql.prepare("SELECT COUNT(*) AS n FROM auth_kv").get()).toEqual({ n: 4 });
  });

  it("imports chats, folds lid folders into the canonical phone chat, and drops status@broadcast", async () => {
    await writeLegacyAuth();

    const phoneChat = createEmptyChat(PHONE_JID, "individual");
    phoneChat.displayName = "Flor ❤️";
    phoneChat.phoneNumber = "+5491100000001";
    phoneChat.lastActivity = 2000;
    phoneChat.messages = [
      message("p1"),
      message("p2", {
        timestamp: 2000,
        media: { relativePath: "media/p2.jpg", mimeType: "image/jpeg", fileName: null },
      }),
    ];

    const lidChat = createEmptyChat(LID_JID, "individual");
    lidChat.phoneNumber = "+5491100000001";
    lidChat.lastActivity = 3000;
    lidChat.messages = [message("l1", { timestamp: 3000, senderJid: LID_JID })];

    const statusChat = createEmptyChat("status@broadcast", "individual");
    statusChat.displayName = "Viandas El Sembrador";
    statusChat.messages = [message("s1")];

    await writeLegacyChat(PHONE_JID, phoneChat, { "p2.jpg": "jpeg bytes" });
    await writeLegacyChat(LID_JID, lidChat);
    await writeLegacyChat("status@broadcast", statusChat);

    await prepareActiveAccount();

    // one canonical chat; lid + status folders never became chats
    expect(await listChatJids()).toEqual([PHONE_JID]);

    const chat = await loadChat(PHONE_JID);
    expect(chat?.displayName).toBe("Flor ❤️");
    expect(chat?.messages.map((m) => m.id)).toEqual(["p1", "p2", "l1"]);
    expect(chat?.lastActivity).toBe(3000);

    // the lid jid resolves to the same chat through the alias table
    expect((await loadChat(LID_JID))?.jid).toBe(PHONE_JID);

    // media moved to the flat account dir and the ref was rewritten
    const movedName = `${PHONE_JID.replace(/[^a-zA-Z0-9._-]/g, "_")}__p2.jpg`;
    const p2 = chat?.messages.find((m) => m.id === "p2");
    expect(p2?.media?.relativePath).toBe(`media/${movedName}`);
    expect(await fs.readFile(path.join(accountMediaDir(ACCOUNT_ID), movedName), "utf8")).toBe("jpeg bytes");

    // verified folders are gone, including the legacy root
    expect(await exists(accountChatsDir(ACCOUNT_ID))).toBe(false);
  });

  it("is idempotent: a second run with nothing left to import changes nothing", async () => {
    await writeLegacyAuth();
    const phoneChat = createEmptyChat(PHONE_JID, "individual");
    phoneChat.messages = [message("p1")];
    await writeLegacyChat(PHONE_JID, phoneChat);

    await prepareActiveAccount();
    await prepareActiveAccount();

    expect(await listChatJids()).toEqual([PHONE_JID]);
    expect((await loadChat(PHONE_JID))?.messages).toHaveLength(1);
  });

  it("keeps an unparseable chat folder on disk instead of losing it", async () => {
    const dir = path.join(accountChatsDir(ACCOUNT_ID), PHONE_JID);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "chats.json"), "{corrupt", "utf8");

    await prepareActiveAccount();

    expect(await exists(path.join(dir, "chats.json"))).toBe(true);
    expect(await listChatJids()).toEqual([]);
  });
});
