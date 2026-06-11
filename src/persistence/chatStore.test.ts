import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createEmptyChat, type Message } from "../types/index.js";
import { chatOps, listChatJids, loadAllChats, loadChat, saveChat } from "./chatStore.js";
import { closeActiveDb } from "./db.js";
import { setActiveAccount } from "./paths.js";

let tmpDir: string;
let originalDataDir: string | undefined;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "whatsapp-terminal-store-"));
  originalDataDir = process.env.WHATSAPP_TERMINAL_DATA_DIR;
  process.env.WHATSAPP_TERMINAL_DATA_DIR = tmpDir;
  setActiveAccount("test-account@s.whatsapp.net");
});

afterEach(async () => {
  closeActiveDb();
  if (originalDataDir === undefined) delete process.env.WHATSAPP_TERMINAL_DATA_DIR;
  else process.env.WHATSAPP_TERMINAL_DATA_DIR = originalDataDir;
  setActiveAccount(null);
  await fs.rm(tmpDir, { recursive: true, force: true });
});

const JID = "123456789@s.whatsapp.net";
const LID = "100000000000001@lid";

function textMessage(id: string, overrides: Partial<Message> = {}): Message {
  return {
    id,
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
    ...overrides,
  };
}

describe("chatStore (whole-chat tier)", () => {
  it("round-trips a chat losslessly, including raw, quoted, media and reactions", async () => {
    const chat = createEmptyChat(JID, "individual");
    chat.displayName = "Alice";
    chat.phoneNumber = "+123456789";
    chat.lastActivity = 1000;
    chat.messages.push(
      textMessage("msg-1", {
        media: { relativePath: "media/x.jpg", mimeType: "image/jpeg", fileName: null },
        quoted: { messageId: "q1", sender: JID, snippet: "earlier" },
        reactions: [{ emoji: "👍", sender: JID }],
      }),
    );

    await saveChat(chat);
    const loaded = await loadChat(JID);
    expect(loaded).toEqual(chat);
  });

  it("round-trips a group with participants", async () => {
    const chat = createEmptyChat("g1@g.us", "group");
    chat.groupSubject = "The Group";
    chat.participants = [
      { jid: JID, displayName: "Alice", isAdmin: true },
      { jid: "999@s.whatsapp.net", displayName: null },
    ];
    await saveChat(chat);
    expect(await loadChat("g1@g.us")).toEqual(chat);
  });

  it("returns null for a missing chat", async () => {
    expect(await loadChat("nope@s.whatsapp.net")).toBeNull();
  });

  it("lists saved chat jids and loads all chats", async () => {
    await saveChat(createEmptyChat(JID, "individual"));
    await saveChat(createEmptyChat("group-1@g.us", "group"));

    expect((await listChatJids()).sort()).toEqual([JID, "group-1@g.us"].sort());
    expect((await loadAllChats()).map((c) => c.jid).sort()).toEqual([JID, "group-1@g.us"].sort());
  });

  it("saveChat fully replaces: a message removed from the aggregate is removed from rows", async () => {
    const chat = createEmptyChat(JID, "individual");
    chat.messages = [textMessage("m1"), textMessage("m2", { timestamp: 2000 })];
    await saveChat(chat);

    chat.messages = [textMessage("m2", { timestamp: 2000 })];
    await saveChat(chat);

    const loaded = await loadChat(JID);
    expect(loaded?.messages.map((m) => m.id)).toEqual(["m2"]);
  });

  it("orders messages by timestamp then id", async () => {
    const chat = createEmptyChat(JID, "individual");
    chat.messages = [
      textMessage("b", { timestamp: 2000 }),
      textMessage("z", { timestamp: 1000 }),
      textMessage("a", { timestamp: 2000 }),
    ];
    await saveChat(chat);
    expect((await loadChat(JID))?.messages.map((m) => m.id)).toEqual(["z", "a", "b"]);
  });
});

describe("chatOps (targeted tier)", () => {
  async function seed(): Promise<void> {
    const chat = createEmptyChat(JID, "individual");
    chat.messages = [
      textMessage("in1"),
      textMessage("out1", { direction: "outbound", senderJid: null, deliveryStatus: "sent", timestamp: 2000 }),
    ];
    await saveChat(chat);
  }

  it("applyDeliveryReceipt advances forward-only and ignores inbound targets", async () => {
    await seed();
    expect(await chatOps.applyDeliveryReceipt(JID, "out1", "delivered")).toBe(true);
    expect(await chatOps.applyDeliveryReceipt(JID, "out1", "sent")).toBe(false); // no downgrade
    expect(await chatOps.applyDeliveryReceipt(JID, "in1", "read")).toBe(false); // inbound ignored
    const chat = await loadChat(JID);
    expect(chat?.messages.find((m) => m.id === "out1")?.deliveryStatus).toBe("delivered");
    expect(chat?.messages.find((m) => m.id === "in1")?.deliveryStatus).toBeNull();
  });

  it("applyReaction replaces per sender and removes on empty emoji", async () => {
    await seed();
    await chatOps.applyReaction(JID, "in1", { emoji: "👍", sender: "x@s.whatsapp.net" });
    await chatOps.applyReaction(JID, "in1", { emoji: "❤️", sender: "x@s.whatsapp.net" });
    let msg = (await loadChat(JID))?.messages.find((m) => m.id === "in1");
    expect(msg?.reactions).toEqual([{ emoji: "❤️", sender: "x@s.whatsapp.net" }]);

    await chatOps.applyReaction(JID, "in1", { emoji: "", sender: "x@s.whatsapp.net" });
    msg = (await loadChat(JID))?.messages.find((m) => m.id === "in1");
    expect(msg?.reactions).toBeUndefined();
  });

  it("applyMessageEdit rewrites text in place and flags edited; unknown ids no-op", async () => {
    await seed();
    expect(await chatOps.applyMessageEdit(JID, "in1", "edited!")).toBe(true);
    expect(await chatOps.applyMessageEdit(JID, "ghost", "x")).toBe(false);
    const msg = (await loadChat(JID))?.messages.find((m) => m.id === "in1");
    expect(msg).toMatchObject({ text: "edited!", edited: true, timestamp: 1000 });
  });

  it("applyMessageDeletion keeps content, and tombstones unknown ids (creating the chat)", async () => {
    await seed();
    expect(await chatOps.applyMessageDeletion(JID, "in1", 5000)).toBe(true);
    const msg = (await loadChat(JID))?.messages.find((m) => m.id === "in1");
    expect(msg).toMatchObject({ deleted: true, deletedAt: 5000, text: "hello" });

    expect(await chatOps.applyMessageDeletion("new@s.whatsapp.net", "ghost", 6000)).toBe(true);
    const tomb = (await loadChat("new@s.whatsapp.net"))?.messages[0];
    expect(tomb).toMatchObject({ id: "ghost", deleted: true, deletedAt: 6000 });
  });

  it("upsertChatMessages merges per message id without discarding local fields", async () => {
    await seed();
    await chatOps.upsertChatMessages(JID, { jid: JID, displayName: "Alice" }, [
      textMessage("in1", { senderName: null, text: "hello" }), // sparser resync of the same id
      textMessage("m3", { timestamp: 3000, text: "third" }),
    ]);
    const chat = await loadChat(JID);
    expect(chat?.displayName).toBe("Alice");
    expect(chat?.messages.map((m) => m.id)).toEqual(["in1", "out1", "m3"]);
    expect(chat?.messages.find((m) => m.id === "in1")?.senderName).toBe("Alice"); // not nulled
    expect(chat?.lastActivity).toBe(3000);
  });

  it("fillDisplayNameIfMissing only fills a missing name", async () => {
    await chatOps.upsertChatMessages(LID, { jid: LID, type: "individual" }, [textMessage("b1")], "Biz Name");
    expect((await loadChat(LID))?.displayName).toBe("Biz Name");

    await chatOps.mergeChatMeta(LID, { displayName: "Saved Contact" }, false);
    await chatOps.upsertChatMessages(LID, { jid: LID, type: "individual" }, [textMessage("b2")], "Biz Name");
    expect((await loadChat(LID))?.displayName).toBe("Saved Contact");
  });

  it("addAlias folds a lid-keyed chat into the canonical and redirects every op", async () => {
    // a stray chat accumulated under the lid
    const stray = createEmptyChat(LID, "individual");
    stray.messages = [textMessage("lid-m1", { timestamp: 4000, text: "via lid" })];
    await saveChat(stray);
    await seed(); // canonical chat under the phone jid

    await chatOps.addAlias(LID, JID);

    // lid chat is gone as a standalone; its message moved into the canonical
    expect((await listChatJids()).sort()).toEqual([JID].sort());
    const chat = await loadChat(JID);
    expect(chat?.messages.map((m) => m.id)).toEqual(["in1", "out1", "lid-m1"]);

    // loads + ops through the lid resolve to the canonical chat
    expect((await loadChat(LID))?.jid).toBe(JID);
    expect(await chatOps.applyMessageEdit(LID, "lid-m1", "edited via lid")).toBe(true);
    expect((await loadChat(JID))?.messages.find((m) => m.id === "lid-m1")?.text).toBe("edited via lid");

    // first write wins: re-pointing is ignored
    await chatOps.addAlias(LID, "other@s.whatsapp.net");
    expect((await loadChat(LID))?.jid).toBe(JID);
  });

  it("setMessageMedia attaches once and never overwrites", async () => {
    await seed();
    const ref = { relativePath: "media/a.jpg", mimeType: "image/jpeg", fileName: null };
    expect(await chatOps.setMessageMedia(JID, "in1", ref)).toBe(true);
    expect(await chatOps.setMessageMedia(JID, "in1", { ...ref, relativePath: "media/b.jpg" })).toBe(false);
    expect((await loadChat(JID))?.messages.find((m) => m.id === "in1")?.media).toEqual(ref);
  });

  it("findMessageById locates a message across chats", async () => {
    await seed();
    const found = await chatOps.findMessageById("out1");
    expect(found?.chatJid).toBe(JID);
    expect(found?.message.direction).toBe("outbound");
    expect(await chatOps.findMessageById("ghost")).toBeNull();
  });
});
