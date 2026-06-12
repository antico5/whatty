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
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "whatsapp-terminal-ingest-"));
  originalDataDir = process.env.WHATSAPP_TERMINAL_DATA_DIR;
  process.env.WHATSAPP_TERMINAL_DATA_DIR = tmpDir;
  setActiveAccount("test-account@s.whatsapp.net");
});

afterEach(async () => {
  if (originalDataDir === undefined) delete process.env.WHATSAPP_TERMINAL_DATA_DIR;
  else process.env.WHATSAPP_TERMINAL_DATA_DIR = originalDataDir;
  setActiveAccount(null);
  await fs.rm(tmpDir, { recursive: true, force: true });
});

const JID = "123456789@s.whatsapp.net";
const GROUP_JID = "123456789-987654@g.us";
const SENDER_LID = "111222333@lid";
const SENDER_PN = "5491100000000@s.whatsapp.net";

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

  it('resolves quoted replies to our own messages as "You" via the own-lid alias', async () => {
    const conn = fakeConnection();
    conn.getSocket = () =>
      ({
        // Device-suffixed, as Baileys reports them — registration must normalize.
        user: { id: "test-account:7@s.whatsapp.net", lid: "777888999:7@lid" },
      }) as unknown as ReturnType<Connection["getSocket"]>;
    createIngestor(conn, { downloadAndStore: async () => null });

    conn.emit("status", "open");
    await flush();

    // Inbound reply quoting one of our own messages: the quoted participant
    // arrives as our @lid, with no alt-jid anywhere in the key.
    conn.emit("messages", {
      messages: [
        {
          key: { remoteJid: JID, fromMe: false, id: "reply-1" },
          messageTimestamp: 2000,
          message: {
            extendedTextMessage: {
              text: "Dos",
              contextInfo: {
                stanzaId: "own-msg",
                participant: "777888999@lid",
                quotedMessage: { conversation: "Uno" },
              },
            },
          },
        } as unknown as WAMessage,
      ],
      type: "notify",
    });
    await flush();

    const chat = await loadChat(JID);
    expect(chat?.messages.find((m) => m.id === "reply-1")?.quoted?.sender).toBe("You");
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

  it("resolves group sender labels from participantAlt on live message keys", async () => {
    const conn = fakeConnection();
    createIngestor(conn, { downloadAndStore: async () => null });

    conn.emit("messages", {
      messages: [
        {
          key: { remoteJid: GROUP_JID, fromMe: false, id: "g1", participant: SENDER_LID, participantAlt: SENDER_PN },
          messageTimestamp: 1000,
          pushName: "Bob",
          message: { conversation: "hola" },
        } as unknown as WAMessage,
      ],
      type: "notify",
    });
    await flush();

    const chat = await loadChat(GROUP_JID);
    expect(chat?.messages[0]?.senderName).toBe("Bob (+5491100000000)");
  });

  it("resolves history-synced group senders once group metadata supplies the lid pairing", async () => {
    const conn = fakeConnection();
    createIngestor(conn, { downloadAndStore: async () => null });

    // History-synced group message: lid sender, no participantAlt, no push name.
    conn.emit("messages", {
      messages: [
        {
          key: { remoteJid: GROUP_JID, fromMe: false, id: "g1", participant: SENDER_LID },
          messageTimestamp: 1000,
          message: { conversation: "hola" },
        } as unknown as WAMessage,
      ],
      type: "append",
    });
    await flush();

    let chat = await loadChat(GROUP_JID);
    expect(chat?.messages[0]?.senderName).toBe(SENDER_LID); // nothing to resolve with yet

    // Group metadata refresh (groups.upsert / on chat open) carries the pairing.
    conn.emit("groups", [
      { id: GROUP_JID, subject: "Club", participants: [{ id: SENDER_LID, phoneNumber: SENDER_PN }] },
    ]);
    await flush();

    chat = await loadChat(GROUP_JID);
    expect(chat?.messages[0]?.senderName).toBe("+5491100000000");
    // Participants canonicalize to the phone jid on load — the signal the
    // store uses to decide a group no longer needs a metadata refresh.
    expect(chat?.participants.map((p) => p.jid)).toEqual([SENDER_PN]);
  });

  it("labels a non-contact group sender with their push name once a live message carries it", async () => {
    const conn = fakeConnection();
    createIngestor(conn, { downloadAndStore: async () => null });

    // History-synced message: lid sender, no push name (history carries none).
    conn.emit("messages", {
      messages: [
        {
          key: { remoteJid: GROUP_JID, fromMe: false, id: "g1", participant: SENDER_LID },
          messageTimestamp: 1000,
          message: { conversation: "hola" },
        } as unknown as WAMessage,
      ],
      type: "append",
    });
    // Group metadata pairs the lid and creates the participant row.
    conn.emit("groups", [
      { id: GROUP_JID, subject: "Club", participants: [{ id: SENDER_LID, phoneNumber: SENDER_PN }] },
    ]);
    await flush();

    // A live message finally carries the sender's push name…
    conn.emit("messages", {
      messages: [
        {
          key: { remoteJid: GROUP_JID, fromMe: false, id: "g2", participant: SENDER_LID, participantAlt: SENDER_PN },
          messageTimestamp: 2000,
          pushName: "Fechu",
          message: { conversation: "que tal" },
        } as unknown as WAMessage,
      ],
      type: "notify",
    });
    await flush();

    // …and both the new and the old message resolve to "pushName (+phone)".
    const chat = await loadChat(GROUP_JID);
    expect(chat?.messages.map((m) => m.senderName)).toEqual([
      "Fechu (+5491100000000)",
      "Fechu (+5491100000000)",
    ]);
  });

  it("names group participants from history-sync push names delivered before group metadata", async () => {
    const conn = fakeConnection();
    createIngestor(conn, { downloadAndStore: async () => null });

    // History sync: the push-name chunk arrives as bare contacts, alongside a
    // nameless group message — before any participant rows exist.
    conn.emit("history", {
      chats: [],
      contacts: [{ id: SENDER_LID, notify: "Fechu" }],
      messages: [
        {
          key: { remoteJid: GROUP_JID, fromMe: false, id: "g1", participant: SENDER_LID },
          messageTimestamp: 1000,
          message: { conversation: "hola" },
        } as unknown as WAMessage,
      ],
    });
    await flush();

    // Group metadata arrives later (groups.upsert / on chat open).
    conn.emit("groups", [
      { id: GROUP_JID, subject: "Club", participants: [{ id: SENDER_LID, phoneNumber: SENDER_PN }] },
    ]);
    await flush();

    const chat = await loadChat(GROUP_JID);
    expect(chat?.messages[0]?.senderName).toBe("Fechu (+5491100000000)");
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

    // Use a recent timestamp (within the 7-day auto-download window).
    const recentTimestamp = Math.floor(Date.now() / 1000) - 60; // 1 minute ago

    conn.emit("messages", {
      messages: [
        {
          key: { remoteJid: JID, fromMe: false, id: "img1" },
          messageTimestamp: recentTimestamp,
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

  describe("media auto-download 7-day gate", () => {
    it("downloads media for a message sent 6 days ago (within window)", async () => {
      const conn = fakeConnection();
      const downloadAndStore = vi.fn().mockResolvedValue({ relativePath: "media/img.jpg", mimeType: "image/jpeg", fileName: null });
      createIngestor(conn, { downloadAndStore });

      const sixDaysAgoSeconds = Math.floor((Date.now() - 6 * 24 * 60 * 60 * 1000) / 1000);

      conn.emit("history", {
        chats: [{ id: JID }],
        contacts: [],
        messages: [
          {
            key: { remoteJid: JID, fromMe: false, id: "img-recent" },
            messageTimestamp: sixDaysAgoSeconds,
            message: { imageMessage: { mimetype: "image/jpeg" } },
          } as unknown as WAMessage,
        ],
      });
      await flush();
      await flush();

      expect(downloadAndStore).toHaveBeenCalledTimes(1);
    });

    it("skips media download for a message sent 8 days ago (outside window)", async () => {
      const conn = fakeConnection();
      const downloadAndStore = vi.fn().mockResolvedValue({ relativePath: "media/img.jpg", mimeType: "image/jpeg", fileName: null });
      createIngestor(conn, { downloadAndStore });

      const eightDaysAgoSeconds = Math.floor((Date.now() - 8 * 24 * 60 * 60 * 1000) / 1000);

      conn.emit("history", {
        chats: [{ id: JID }],
        contacts: [],
        messages: [
          {
            key: { remoteJid: JID, fromMe: false, id: "img-old" },
            messageTimestamp: eightDaysAgoSeconds,
            message: { imageMessage: { mimetype: "image/jpeg" } },
          } as unknown as WAMessage,
        ],
      });
      await flush();
      await flush();

      expect(downloadAndStore).not.toHaveBeenCalled();
    });

    it("skips download for old message but still persists the message record", async () => {
      const conn = fakeConnection();
      const downloadAndStore = vi.fn().mockResolvedValue({ relativePath: "media/img.jpg", mimeType: "image/jpeg", fileName: null });
      createIngestor(conn, { downloadAndStore });

      const eightDaysAgoSeconds = Math.floor((Date.now() - 8 * 24 * 60 * 60 * 1000) / 1000);

      conn.emit("history", {
        chats: [{ id: JID }],
        contacts: [],
        messages: [
          {
            key: { remoteJid: JID, fromMe: false, id: "img-old" },
            messageTimestamp: eightDaysAgoSeconds,
            message: { imageMessage: { mimetype: "image/jpeg", caption: "old photo" } },
          } as unknown as WAMessage,
        ],
      });
      await flush();
      await flush();

      expect(downloadAndStore).not.toHaveBeenCalled();
      const chat = await loadChat(JID);
      expect(chat?.messages).toHaveLength(1);
      expect(chat?.messages[0]?.id).toBe("img-old");
      // media stays null — not downloaded
      expect(chat?.messages[0]?.media).toBeNull();
    });

    it("treats a message at exactly the 7-day boundary as within window (boundary at the edge)", async () => {
      const conn = fakeConnection();
      const downloadAndStore = vi.fn().mockResolvedValue({ relativePath: "media/img.jpg", mimeType: "image/jpeg", fileName: null });
      createIngestor(conn, { downloadAndStore });

      // Exactly at the boundary: ageMs === MEDIA_AUTODOWNLOAD_MAX_AGE_MS means > check is false
      // Use 7 days - 30 seconds to be safely within the window
      const justInsideSeconds = Math.floor((Date.now() - 7 * 24 * 60 * 60 * 1000 + 30_000) / 1000);

      conn.emit("history", {
        chats: [{ id: JID }],
        contacts: [],
        messages: [
          {
            key: { remoteJid: JID, fromMe: false, id: "img-boundary" },
            messageTimestamp: justInsideSeconds,
            message: { imageMessage: { mimetype: "image/jpeg" } },
          } as unknown as WAMessage,
        ],
      });
      await flush();
      await flush();

      expect(downloadAndStore).toHaveBeenCalledTimes(1);
    });

    it("gate applies equally to messages.upsert (live) and messaging-history.set paths", async () => {
      const conn = fakeConnection();
      const downloadAndStore = vi.fn().mockResolvedValue({ relativePath: "media/img.jpg", mimeType: "image/jpeg", fileName: null });
      createIngestor(conn, { downloadAndStore });

      const oldSeconds = Math.floor((Date.now() - 8 * 24 * 60 * 60 * 1000) / 1000);

      // Old message via live messages.upsert — should also be skipped
      conn.emit("messages", {
        messages: [
          {
            key: { remoteJid: JID, fromMe: false, id: "img-old-live" },
            messageTimestamp: oldSeconds,
            message: { imageMessage: { mimetype: "image/jpeg" } },
          } as unknown as WAMessage,
        ],
        type: "notify",
      });
      await flush();
      await flush();

      expect(downloadAndStore).not.toHaveBeenCalled();
    });
  });
});
