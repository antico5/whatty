import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveSenderLabel } from "./contacts.js";
import { closeActiveDb, openAccountDb, type AccountDb } from "./db.js";
import { setActiveAccount } from "./paths.js";

let tmpDir: string;
let db: AccountDb;
let originalDataDir: string | undefined;

const PHONE_JID = "5491100000000@s.whatsapp.net";
const LID_JID = "100000000000001@lid";
const GROUP_JID = "abc123@g.us";

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "whatsapp-terminal-contacts-test-"));
  originalDataDir = process.env.WHATSAPP_TERMINAL_DATA_DIR;
  process.env.WHATSAPP_TERMINAL_DATA_DIR = tmpDir;
  setActiveAccount("test-account@s.whatsapp.net");
  db = await openAccountDb("test-account@s.whatsapp.net");
});

afterEach(async () => {
  closeActiveDb();
  db.close();
  if (originalDataDir === undefined) delete process.env.WHATSAPP_TERMINAL_DATA_DIR;
  else process.env.WHATSAPP_TERMINAL_DATA_DIR = originalDataDir;
  setActiveAccount(null);
  await fs.rm(tmpDir, { recursive: true, force: true });
});

/** Insert a minimal individual chat row with an optional saved-contact name. */
function seedChat(jid: string, displayName: string | null, phoneNumber: string | null = null): void {
  db.sql
    .prepare(
      "INSERT OR REPLACE INTO chats (jid, type, display_name, phone_number, archived, last_activity) VALUES (?, 'individual', ?, ?, 0, 0)",
    )
    .run(jid, displayName, phoneNumber);
}

/** Register an alias mapping. */
function seedAlias(aliasJid: string, chatJid: string): void {
  db.sql.prepare("INSERT OR REPLACE INTO aliases (alias_jid, chat_jid) VALUES (?, ?)").run(aliasJid, chatJid);
}

describe("resolveSenderLabel", () => {
  it("returns the saved-contact name when the sender has a matching individual chat", () => {
    seedChat(PHONE_JID, "Alice Smith");
    const label = resolveSenderLabel(PHONE_JID, "Alice push", db);
    expect(label).toBe("Alice Smith");
  });

  it("returns pushName (phone) when the sender has no contact but has a push name", () => {
    seedChat(PHONE_JID, null, "+5491100000000");
    const label = resolveSenderLabel(PHONE_JID, "Alice", db);
    expect(label).toBe("Alice (+5491100000000)");
  });

  it("derives phone from JID when no contact row exists for the sender", () => {
    // No chat row at all — phone comes from the JID itself.
    const label = resolveSenderLabel(PHONE_JID, "Bob", db);
    expect(label).toBe("Bob (+5491100000000)");
  });

  it("returns only pushName when no phone is available", () => {
    // A @lid JID with a push name but no alias and no chat row.
    const label = resolveSenderLabel(LID_JID, "Carol", db);
    expect(label).toBe("Carol");
  });

  it("returns just the phone when there is no push name and no contact name", () => {
    const label = resolveSenderLabel(PHONE_JID, null, db);
    expect(label).toBe("+5491100000000");
  });

  it("falls back to the raw JID when there is neither push name nor phone", () => {
    const label = resolveSenderLabel(LID_JID, null, db);
    expect(label).toBe(LID_JID);
  });

  it("resolves a @lid JID through the alias table to the canonical phone JID", () => {
    seedAlias(LID_JID, PHONE_JID);
    seedChat(PHONE_JID, "Dave Saved");
    const label = resolveSenderLabel(LID_JID, "Dave push", db);
    // Should resolve to the saved-contact name on the canonical phone chat.
    expect(label).toBe("Dave Saved");
  });

  it("resolves a @lid JID through alias to a phone JID and formats with push name + phone", () => {
    seedAlias(LID_JID, PHONE_JID);
    seedChat(PHONE_JID, null, "+5491100000000");
    const label = resolveSenderLabel(LID_JID, "Eve", db);
    expect(label).toBe("Eve (+5491100000000)");
  });

  it("caches results: second call for the same canonical JID returns cached value", () => {
    seedChat(PHONE_JID, "Frank");
    const cache = new Map<string, string>();
    const first = resolveSenderLabel(PHONE_JID, "Frank push", db, cache);
    // Overwrite the chat row so a fresh DB lookup would return a different name.
    db.sql.prepare("UPDATE chats SET display_name = 'Modified' WHERE jid = ?").run(PHONE_JID);
    const second = resolveSenderLabel(PHONE_JID, "Frank push", db, cache);
    expect(first).toBe("Frank");
    // Cache hit — returns the original value, not the modified one.
    expect(second).toBe("Frank");
  });

  it("caches by canonical JID so a @lid and its canonical phone JID share one cache entry", () => {
    seedAlias(LID_JID, PHONE_JID);
    seedChat(PHONE_JID, "Grace");
    const cache = new Map<string, string>();
    // First call via lid — resolves to canonical and caches (one entry,
    // keyed on canonical jid + push name).
    resolveSenderLabel(LID_JID, "Grace push", db, cache);
    expect([...cache.keys()]).toEqual([`${PHONE_JID}\0Grace push`]);
    // Subsequent call via phone JID hits the cache directly.
    const second = resolveSenderLabel(PHONE_JID, "Grace push", db, cache);
    expect(second).toBe("Grace");
    expect(cache.size).toBe(1);
  });

  it("does not serve a label cached without a push name to a message that carries one", () => {
    seedAlias(LID_JID, PHONE_JID);
    const cache = new Map<string, string>();
    // History-synced message: no push name anywhere → phone-only label.
    expect(resolveSenderLabel(LID_JID, null, db, cache)).toBe("+5491100000000");
    // A later message from the same sender carries its push name.
    expect(resolveSenderLabel(LID_JID, "Hana push", db, cache)).toBe("Hana push (+5491100000000)");
  });

  it("returns 'You' when the sender JID matches the own (account) JID", () => {
    const ownJid = PHONE_JID;
    // Even if there is a contact row for ownJid, own-JID wins with "You".
    seedChat(PHONE_JID, "My Name");
    const label = resolveSenderLabel(PHONE_JID, "My push", db, new Map(), ownJid);
    expect(label).toBe("You");
  });

  it("returns 'You' for a @lid own JID after alias resolution", () => {
    seedAlias(LID_JID, PHONE_JID);
    seedChat(PHONE_JID, "My Name");
    const label = resolveSenderLabel(LID_JID, "My push", db, new Map(), PHONE_JID);
    expect(label).toBe("You");
  });

  it("does not return 'You' when ownJid is absent or null", () => {
    seedChat(PHONE_JID, "Henry Contact");
    const label = resolveSenderLabel(PHONE_JID, "Henry push", db, new Map());
    expect(label).toBe("Henry Contact");
  });
});

describe("resolveSenderLabel — integration with group message load", () => {
  /**
   * Verify that the group-message loader in chatStore applies resolveSenderLabel
   * at read time. This avoids coupling the test to chatStore internals — we
   * just check that a saved-contact name overrides the raw push name stored in
   * the messages row.
   */
  it("group chat sender name is overridden by saved-contact name at read time", async () => {
    const { saveChat, loadChat } = await import("./chatStore.js");
    const { createEmptyChat } = await import("../types/index.js");

    // Seed a saved contact for the sender.
    seedChat(PHONE_JID, "Hana Contact", "+5491100000000");

    // Create a group chat with one message from that sender.
    const chat = createEmptyChat(GROUP_JID, "group");
    chat.groupSubject = "Test Group";
    chat.messages = [
      {
        id: "msg-1",
        senderJid: PHONE_JID,
        senderName: "hana push name",
        direction: "inbound",
        timestamp: 1000,
        type: "text",
        text: "hello group",
        media: null,
        quoted: null,
        deliveryStatus: null,
        deleted: false,
        deletedAt: null,
        raw: null,
      },
    ];
    await saveChat(chat);

    const loaded = await loadChat(GROUP_JID);
    // The senderName on the loaded message should be the contact name, not the push name.
    expect(loaded?.messages[0]?.senderName).toBe("Hana Contact");
  });

  it("group chat sender name falls back to pushName (phone) when sender is not a contact", async () => {
    const { saveChat, loadChat } = await import("./chatStore.js");
    const { createEmptyChat } = await import("../types/index.js");

    // No contact row for the sender — only a phone number derived from JID.
    const chat = createEmptyChat(GROUP_JID, "group");
    chat.groupSubject = "Test Group";
    chat.messages = [
      {
        id: "msg-2",
        senderJid: PHONE_JID,
        senderName: "Ivan push",
        direction: "inbound",
        timestamp: 1000,
        type: "text",
        text: "hi",
        media: null,
        quoted: null,
        deliveryStatus: null,
        deleted: false,
        deletedAt: null,
        raw: null,
      },
    ];
    await saveChat(chat);

    const loaded = await loadChat(GROUP_JID);
    expect(loaded?.messages[0]?.senderName).toBe("Ivan push (+5491100000000)");
  });
});
