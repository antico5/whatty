import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { WAMessage } from "baileys";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setActiveAccount } from "../persistence/paths.js";
import { loadChat } from "../persistence/chatStore.js";
import type { Connection } from "./connection.js";
import { createIngestor } from "./ingest.js";

let tmpDir: string;
let originalDataDir: string | undefined;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "wa-chat-ingest-"));
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

function fakeConnection(): Connection & EventEmitter {
  const emitter = new EventEmitter() as Connection & EventEmitter;
  emitter.start = async () => {};
  emitter.stop = async () => {};
  emitter.sendText = (() => Promise.resolve(undefined)) as Connection["sendText"];
  emitter.getSocket = () => null;
  return emitter;
}

function textMessage(id: string, text: string, timestamp: number): WAMessage {
  return {
    key: { remoteJid: JID, fromMe: false, id },
    messageTimestamp: timestamp,
    pushName: "Alice",
    message: { conversation: text },
  } as unknown as WAMessage;
}

/** Wait for the ingestor's per-jid write queue to drain (tasks are chained promises). */
async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 20));
}

describe("ingest (reconcile + persist integration)", () => {
  it("persists two history syncs and a delete additively to disk", async () => {
    const conn = fakeConnection();
    const ingestor = createIngestor(conn, { downloadAndStore: async () => null });
    const updates: string[] = [];
    ingestor.on("chat-updated", (jid: string) => updates.push(jid));

    conn.emit("history", {
      chats: [{ id: JID, name: "Alice", conversationTimestamp: 1000 }],
      contacts: [{ id: JID, name: "Alice" }],
      messages: [textMessage("m1", "hello", 1000), textMessage("m2", "world", 1001)],
    });
    await flush();

    let chat = await loadChat(JID);
    expect(chat?.messages.map((m) => m.id)).toEqual(["m1", "m2"]);
    expect(chat?.displayName).toBe("Alice");

    // second, sparser sync: no `name` anywhere and an overlapping + a new message
    conn.emit("history", {
      chats: [{ id: JID, conversationTimestamp: 2000 }],
      contacts: [],
      messages: [textMessage("m2", "world", 1001), textMessage("m3", "third", 2000)],
    });
    await flush();

    chat = await loadChat(JID);
    expect(chat?.messages.map((m) => m.id)).toEqual(["m1", "m2", "m3"]);
    // displayName must survive the sparser second sync, which carries no name at all
    expect(chat?.displayName).toBe("Alice");

    // delete m1 — content must be retained, only the deleted flag set
    conn.emit("message-update", [
      { key: { remoteJid: JID, fromMe: false, id: "m1" }, update: { messageStubType: 1, messageTimestamp: 3000 } },
    ]);
    await flush();

    chat = await loadChat(JID);
    const deleted = chat?.messages.find((m) => m.id === "m1");
    expect(deleted?.deleted).toBe(true);
    expect(deleted?.text).toBe("hello");
    expect(chat?.messages).toHaveLength(3);

    expect(updates).toContain(JID);
  });

  it("does not persist encrypted edit envelopes as empty messages", async () => {
    const conn = fakeConnection();
    createIngestor(conn, { downloadAndStore: async () => null });

    conn.emit("messages", {
      messages: [
        textMessage("original", "Yoo", 1000),
        {
          key: { remoteJid: JID, fromMe: true, id: "edit-envelope" },
          messageTimestamp: 1001,
          message: {
            secretEncryptedMessage: {
              targetMessageKey: { remoteJid: JID, fromMe: true, id: "original" },
              encPayload: Buffer.alloc(32),
              encIv: Buffer.alloc(12),
              secretEncType: "MESSAGE_EDIT",
            },
          },
        } as unknown as WAMessage,
      ],
      type: "notify",
    });
    await flush();

    const chat = await loadChat(JID);
    expect(chat?.messages.map((message) => message.id)).toEqual(["original"]);
    expect(chat?.messages[0]?.text).toBe("Yoo");
  });

  it("re-requests history for pending encrypted edits after a reconnect", async () => {
    const conn = fakeConnection();
    const fetchMessageHistory = vi.fn().mockResolvedValue("request-id");
    conn.getSocket = () =>
      ({
        user: { id: "999@s.whatsapp.net" },
        fetchMessageHistory,
      }) as unknown as ReturnType<Connection["getSocket"]>;
    createIngestor(conn, { downloadAndStore: async () => null });

    // Outbound message sent from the phone: no messageSecret, so the encrypted
    // edit can't be decrypted locally and history must be fetched.
    conn.emit("messages", {
      messages: [
        {
          key: { remoteJid: JID, fromMe: true, id: "original" },
          messageTimestamp: 1000,
          message: { conversation: "Cinco" },
        } as unknown as WAMessage,
      ],
      type: "notify",
    });
    await flush();
    conn.emit("messages", {
      messages: [
        {
          key: { remoteJid: JID, fromMe: true, id: "edit-envelope" },
          messageTimestamp: 1001,
          message: {
            secretEncryptedMessage: {
              targetMessageKey: { remoteJid: JID, fromMe: true, id: "original" },
              encPayload: Buffer.alloc(32),
              encIv: Buffer.alloc(12),
              secretEncType: "MESSAGE_EDIT",
            },
          },
        } as unknown as WAMessage,
      ],
      type: "notify",
    });
    await flush();
    const requestsBeforeReconnect = fetchMessageHistory.mock.calls.length;
    expect(requestsBeforeReconnect).toBeGreaterThan(0);

    // The connection drops before the history response arrives, then reopens.
    conn.emit("status", "close");
    conn.emit("status", "open");
    await flush();
    expect(fetchMessageHistory.mock.calls.length).toBeGreaterThan(requestsBeforeReconnect);

    // The re-requested history delivers the edit in plain form; it must apply.
    conn.emit("history", {
      chats: [],
      contacts: [],
      messages: [
        {
          key: { remoteJid: JID, fromMe: true, id: "edit-envelope-plain" },
          messageTimestamp: 1001,
          message: {
            protocolMessage: {
              type: 14, // MESSAGE_EDIT
              key: { remoteJid: JID, fromMe: true, id: "original" },
              editedMessage: { conversation: "Seis" },
            },
          },
        } as unknown as WAMessage,
      ],
    });
    await flush();

    const chat = await loadChat(JID);
    const edited = chat?.messages.find((m) => m.id === "original");
    expect(edited?.text).toBe("Seis");
    expect(edited?.edited).toBe(true);
  });

  it("applies an editedMessage wrapper received through messages.upsert", async () => {
    const conn = fakeConnection();
    createIngestor(conn, { downloadAndStore: async () => null });

    conn.emit("messages", {
      messages: [textMessage("original", "Original text", 1000)],
      type: "notify",
    });
    await flush();
    conn.emit("messages", {
      messages: [
        {
          key: { remoteJid: JID, fromMe: true, id: "original" },
          messageTimestamp: 1001,
          message: { editedMessage: { message: { conversation: "Edited text" } } },
        } as unknown as WAMessage,
      ],
      type: "notify",
    });
    await flush();

    const chat = await loadChat(JID);
    expect(chat?.messages).toHaveLength(1);
    expect(chat?.messages[0]).toMatchObject({ id: "original", text: "Edited text", edited: true });
  });

  it("applies a protocol MESSAGE_EDIT received through messages.upsert", async () => {
    const conn = fakeConnection();
    createIngestor(conn, { downloadAndStore: async () => null });

    conn.emit("messages", {
      messages: [textMessage("original", "Original text", 1000)],
      type: "notify",
    });
    await flush();
    conn.emit("messages", {
      messages: [
        {
          key: { remoteJid: JID, fromMe: true, id: "edit-envelope" },
          messageTimestamp: 1001,
          message: {
            protocolMessage: {
              key: { remoteJid: JID, fromMe: true, id: "original" },
              type: 14,
              editedMessage: { conversation: "Edited text" },
            },
          },
        } as unknown as WAMessage,
      ],
      type: "notify",
    });
    await flush();

    const chat = await loadChat(JID);
    expect(chat?.messages).toHaveLength(1);
    expect(chat?.messages[0]).toMatchObject({ id: "original", text: "Edited text", edited: true });
  });

  it("resolves a @lid chat's name from a contact, regardless of event order", async () => {
    // Mirrors the LID-addressed world: the chat is keyed by an @lid jid, while
    // the saved name arrives on a separate contact carrying the lid<->phone
    // pairing. History sync also emits a bland chat-derived contact
    // ({ id: <lid>, name: undefined }) that must not clobber the real name.
    for (const order of ["contact-first", "history-first"] as const) {
      // distinct jids per ordering so the two runs stay isolated on disk
      const LID = order === "contact-first" ? "100000000000001@lid" : "100000000000002@lid";
      const phone = order === "contact-first" ? "5491100000001" : "5491100000002";
      const contact = {
        id: `${phone}@s.whatsapp.net`,
        lid: LID,
        phoneNumber: `${phone}@s.whatsapp.net`,
        name: "Alice Santos",
      };
      const history = {
        chats: [{ id: LID }],
        contacts: [{ id: LID, name: undefined }],
        messages: [
          { key: { remoteJid: LID, fromMe: false, id: "x1" }, messageTimestamp: 1000, message: { conversation: "hi" } } as unknown as WAMessage,
        ],
      };

      const conn = fakeConnection();
      createIngestor(conn, { downloadAndStore: async () => null });
      if (order === "contact-first") {
        conn.emit("contacts", [contact]);
        await flush();
        conn.emit("history", history);
      } else {
        conn.emit("history", history);
        await flush();
        conn.emit("contacts", [contact]);
      }
      await flush();

      const chat = await loadChat(LID);
      expect(chat?.displayName, order).toBe("Alice Santos");
      expect(chat?.phoneNumber, order).toBe(`+${phone}`);
    }
  });

  it("resolves a @lid chat's number from the signal lid-mapping store when keys lack an alt-jid", async () => {
    // History-synced message keys carry no remoteJidAlt/senderPn.
    const LID = "100000000000003@lid";
    const conn = fakeConnection();
    conn.getSocket = () =>
      ({
        signalRepository: {
          lidMapping: { getPNForLID: async () => "5491100000003@s.whatsapp.net" },
        },
      }) as unknown as ReturnType<Connection["getSocket"]>;
    createIngestor(conn, { downloadAndStore: async () => null });

    conn.emit("history", {
      chats: [{ id: LID }],
      contacts: [],
      messages: [
        {
          key: { remoteJid: LID, fromMe: false, id: "h1" },
          messageTimestamp: 1000,
          message: { conversation: "Hello there" },
        } as unknown as WAMessage,
      ],
    });
    await flush();

    const chat = await loadChat(LID);
    expect(chat?.phoneNumber).toBe("+5491100000003");
  });

  it("names a business chat from its verified business name, without clobbering a saved name", async () => {
    const LID = "100000000000004@lid";
    const conn = fakeConnection();
    createIngestor(conn, { downloadAndStore: async () => null });

    conn.emit("messages", {
      messages: [
        {
          key: { remoteJid: LID, fromMe: false, id: "b1" },
          messageTimestamp: 1000,
          pushName: "WhatsApp",
          verifiedBizName: "WhatsApp Business",
          message: { conversation: "hola" },
        } as unknown as WAMessage,
      ],
      type: "notify",
    });
    await flush();

    let chat = await loadChat(LID);
    expect(chat?.displayName).toBe("WhatsApp Business");

    // a saved-contact name arrives later and wins; subsequent biz messages must not undo it
    conn.emit("contacts", [{ id: LID, name: "Mi Banco" }]);
    await flush();
    conn.emit("messages", {
      messages: [
        {
          key: { remoteJid: LID, fromMe: false, id: "b2" },
          messageTimestamp: 2000,
          verifiedBizName: "WhatsApp Business",
          message: { conversation: "chau" },
        } as unknown as WAMessage,
      ],
      type: "notify",
    });
    await flush();

    chat = await loadChat(LID);
    expect(chat?.displayName).toBe("Mi Banco");
  });

  it("keeps a non-contact nameless (no push name) and harvests their number from senderPn", async () => {
    // The bug this guards against: a stranger messages in, and their self-set
    // profile name (push name / `notify`) replaced "Not Contact" in the UI,
    // while their number never showed because the chat is keyed by @lid.
    const LID = "100000000000003@lid";
    const conn = fakeConnection();
    createIngestor(conn, { downloadAndStore: async () => null });

    conn.emit("history", {
      chats: [{ id: LID, name: "👆🥳" }], // chat.name carries the push name for non-contacts
      contacts: [{ id: LID, notify: "👆🥳" }],
      messages: [],
    });
    await flush();

    conn.emit("messages", {
      messages: [
        {
          key: { remoteJid: LID, fromMe: false, id: "in1", senderPn: "5491100000003@s.whatsapp.net" },
          messageTimestamp: 1000,
          pushName: "👆🥳",
          message: { conversation: "Hello?" },
        } as unknown as WAMessage,
      ],
      type: "notify",
    });
    await flush();

    const chat = await loadChat(LID);
    expect(chat?.displayName).toBeNull(); // UI renders "Not Contact"
    expect(chat?.phoneNumber).toBe("+5491100000003");
  });

  it("flush() resolves only once every queued write has been persisted (graceful shutdown)", async () => {
    const conn = fakeConnection();
    const ingestor = createIngestor(conn, { downloadAndStore: async () => null });

    // Emit several events back-to-back without awaiting the usual settle-timer —
    // flush() must still wait for the whole per-jid write queue to drain.
    conn.emit("history", {
      chats: [{ id: JID, name: "Alice", conversationTimestamp: 1000 }],
      contacts: [],
      messages: [textMessage("m1", "hello", 1000)],
    });
    conn.emit("messages", { messages: [textMessage("m2", "world", 1001)], type: "notify" });
    conn.emit("message-update", [
      { key: { remoteJid: JID, fromMe: false, id: "m1" }, update: { messageStubType: 1, messageTimestamp: 3000 } },
    ]);

    await ingestor.flush();

    const chat = await loadChat(JID);
    expect(chat?.messages.map((m) => m.id)).toEqual(["m1", "m2"]);
    expect(chat?.messages.find((m) => m.id === "m1")?.deleted).toBe(true);

    // Idempotent / safe to call again once the queue is already empty.
    await expect(ingestor.flush()).resolves.toBeUndefined();
  });

  it("advances delivery status on receipts for outbound messages", async () => {
    const conn = fakeConnection();
    const ingestor = createIngestor(conn, { downloadAndStore: async () => null });
    void ingestor;

    conn.emit("history", {
      chats: [{ id: JID }],
      contacts: [],
      messages: [
        {
          key: { remoteJid: JID, fromMe: true, id: "out1" },
          messageTimestamp: 1000,
          status: 2, // SERVER_ACK -> "sent"
          message: { conversation: "outbound text" },
        } as unknown as WAMessage,
      ],
    });
    await flush();

    conn.emit("receipts", [
      {
        key: { remoteJid: JID, fromMe: true, id: "out1" },
        receipt: { userJid: "999@s.whatsapp.net", receiptTimestamp: 5000 },
      },
    ]);
    await flush();

    let chat = await loadChat(JID);
    expect(chat?.messages.find((m) => m.id === "out1")?.deliveryStatus).toBe("delivered");

    conn.emit("receipts", [
      {
        key: { remoteJid: JID, fromMe: true, id: "out1" },
        receipt: { userJid: "999@s.whatsapp.net", receiptTimestamp: 5000, readTimestamp: 6000 },
      },
    ]);
    await flush();

    chat = await loadChat(JID);
    expect(chat?.messages.find((m) => m.id === "out1")?.deliveryStatus).toBe("read");
  });

  it("schedules an eager media download and attaches the resulting MediaRef", async () => {
    const conn = fakeConnection();
    const downloadAndStore = vi.fn().mockResolvedValue({ relativePath: "media/img1.jpg", mimeType: "image/jpeg", fileName: null });
    const ingestor = createIngestor(conn, { downloadAndStore });
    void ingestor;

    conn.emit("messages", {
      messages: [
        {
          key: { remoteJid: JID, fromMe: false, id: "img1" },
          messageTimestamp: 1000,
          pushName: "Alice",
          message: { imageMessage: { mimetype: "image/jpeg", caption: "look" } },
        } as unknown as WAMessage,
      ],
      type: "notify",
    });
    await flush();
    await flush();

    expect(downloadAndStore).toHaveBeenCalledTimes(1);
    const chat = await loadChat(JID);
    expect(chat?.messages[0]?.media).toEqual({ relativePath: "media/img1.jpg", mimeType: "image/jpeg", fileName: null });
  });
});
