import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createEmptyChat } from "../types/index.js";
import { ensureChatDir, listChatJids, loadAllChats, loadChat, saveChat } from "./chatStore.js";
import { chatFile, mediaDir, setActiveAccount } from "./paths.js";

let tmpDir: string;
let originalDataDir: string | undefined;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "wa-chat-store-"));
  originalDataDir = process.env.WA_CHAT_DATA_DIR;
  process.env.WA_CHAT_DATA_DIR = tmpDir;
  setActiveAccount("test-account@s.whatsapp.net");
});

afterEach(async () => {
  if (originalDataDir === undefined) delete process.env.WA_CHAT_DATA_DIR;
  else process.env.WA_CHAT_DATA_DIR = originalDataDir;
  setActiveAccount(null);
  await fs.rm(tmpDir, { recursive: true, force: true });
});

const JID = "123456789@s.whatsapp.net";

describe("chatStore", () => {
  it("round-trips a chat losslessly, including raw", async () => {
    const chat = createEmptyChat(JID, "individual");
    chat.displayName = "Alice";
    chat.lastActivity = 1000;
    chat.messages.push({
      id: "msg-1",
      senderJid: JID,
      senderName: "Alice",
      direction: "inbound",
      timestamp: 1000,
      type: "text",
      text: "hello",
      media: null,
      quoted: null,
      deliveryStatus: null,
      deleted: false,
      deletedAt: null,
      raw: { weird: ["nested", { data: 1 }], n: null },
    });

    await saveChat(chat);
    const loaded = await loadChat(JID);
    expect(loaded).toEqual(chat);
  });

  it("returns null for a missing chat", async () => {
    expect(await loadChat("nope@s.whatsapp.net")).toBeNull();
  });

  it("lists saved chat jids", async () => {
    await saveChat(createEmptyChat(JID, "individual"));
    await saveChat(createEmptyChat("group-1@g.us", "group"));

    const jids = await listChatJids();
    expect(jids.sort()).toEqual([JID, "group-1@g.us"].sort());
  });

  it("loadAllChats loads every persisted chat", async () => {
    await saveChat(createEmptyChat(JID, "individual"));
    await saveChat(createEmptyChat("group-1@g.us", "group"));

    const chats = await loadAllChats();
    expect(chats.map((c) => c.jid).sort()).toEqual([JID, "group-1@g.us"].sort());
  });

  it("ensureChatDir creates chat and media directories", async () => {
    await ensureChatDir(JID);
    const stat = await fs.stat(mediaDir(JID));
    expect(stat.isDirectory()).toBe(true);
  });

  it("an interrupted/overwritten write does not corrupt the final file", async () => {
    const chat = createEmptyChat(JID, "individual");
    chat.displayName = "First";
    await saveChat(chat);

    chat.displayName = "Second";
    await saveChat(chat);

    const raw = await fs.readFile(chatFile(JID), "utf8");
    expect(() => JSON.parse(raw)).not.toThrow();
    const loaded = await loadChat(JID);
    expect(loaded?.displayName).toBe("Second");

    // no leftover temp file
    const files = await fs.readdir(path.dirname(chatFile(JID)));
    expect(files).not.toContain("chats.json.tmp");
  });

  it("backs up and discards a corrupt chats.json", async () => {
    await ensureChatDir(JID);
    await fs.writeFile(chatFile(JID), "{not valid json", "utf8");

    const loaded = await loadChat(JID);
    expect(loaded).toBeNull();

    const files = await fs.readdir(path.dirname(chatFile(JID)));
    expect(files.some((f) => f.startsWith("chats.json.bak-"))).toBe(true);
  });
});
