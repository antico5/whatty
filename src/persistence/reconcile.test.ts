import { describe, expect, it } from "vitest";
import { createEmptyChat, type Chat, type Message } from "../types/index.js";
import {
  applyDeliveryReceipt,
  applyMessageDeletion,
  applyMessageEdit,
  applyReaction,
  mergeChatMeta,
  mergeMessages,
  upsertChat,
} from "./reconcile.js";

const JID = "12345@s.whatsapp.net";

function msg(overrides: Partial<Message>): Message {
  return {
    id: "m1",
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
    raw: { id: "m1" },
    ...overrides,
  };
}

describe("mergeChatMeta", () => {
  it("does not wipe local fields when incoming has fewer fields", () => {
    const local: Chat = { ...createEmptyChat(JID, "individual"), displayName: "Alice", phoneNumber: "+1 555" };
    const merged = mergeChatMeta(local, { lastActivity: 500 });
    expect(merged.displayName).toBe("Alice");
    expect(merged.phoneNumber).toBe("+1 555");
  });

  it("applies incoming values when present", () => {
    const local = createEmptyChat(JID, "individual");
    const merged = mergeChatMeta(local, { displayName: "Bob", archived: true });
    expect(merged.displayName).toBe("Bob");
    expect(merged.archived).toBe(true);
  });

  it("starts from an empty chat when local is null", () => {
    const merged = mergeChatMeta(null, { jid: JID, type: "individual", displayName: "Carol" });
    expect(merged.jid).toBe(JID);
    expect(merged.displayName).toBe("Carol");
    expect(merged.messages).toEqual([]);
  });

  it("recomputes lastActivity as the max of existing/incoming/newest message", () => {
    const local: Chat = {
      ...createEmptyChat(JID, "individual"),
      lastActivity: 100,
      messages: [msg({ id: "m1", timestamp: 300 })],
    };
    const merged = mergeChatMeta(local, { lastActivity: 200 });
    expect(merged.lastActivity).toBe(300);
  });

  it("merges group participants additively, keeping locally-known ones", () => {
    const local: Chat = {
      ...createEmptyChat("g1@g.us", "group"),
      participants: [{ jid: "a@s.whatsapp.net", displayName: "Alice", isAdmin: true }],
    };
    const merged = mergeChatMeta(local, {
      participants: [
        { jid: "a@s.whatsapp.net", displayName: "Alice Updated" },
        { jid: "b@s.whatsapp.net", displayName: "Bob" },
      ],
    });
    expect(merged.participants).toEqual([
      { jid: "a@s.whatsapp.net", displayName: "Alice Updated", isAdmin: true },
      { jid: "b@s.whatsapp.net", displayName: "Bob", isAdmin: undefined },
    ]);
  });
});

describe("mergeMessages", () => {
  it("appends new messages and sorts ascending by timestamp then id", () => {
    const local = [msg({ id: "m2", timestamp: 2000 })];
    const incoming = [msg({ id: "m1", timestamp: 1000 }), msg({ id: "m3", timestamp: 3000 })];
    const merged = mergeMessages(local, incoming);
    expect(merged.map((m) => m.id)).toEqual(["m1", "m2", "m3"]);
  });

  it("merges duplicates by id rather than duplicating", () => {
    const local = [msg({ id: "m1", text: "hello" })];
    const incoming = [msg({ id: "m1", text: "hello" })];
    const merged = mergeMessages(local, incoming);
    expect(merged).toHaveLength(1);
  });

  it("treats revised text for the same message id as an edit", () => {
    const local = [msg({ id: "m1", text: "Test" })];
    const incoming = [msg({ id: "m1", text: "Tested" })];

    const merged = mergeMessages(local, incoming);

    expect(merged[0]).toMatchObject({ id: "m1", text: "Tested", edited: true });
  });

  it("keeps a locally-deleted message deleted after a resync resends the original", () => {
    const local = [msg({ id: "m1", deleted: true, deletedAt: 5000 })];
    const incoming = [msg({ id: "m1", deleted: false, deletedAt: null, text: "original text" })];
    const merged = mergeMessages(local, incoming);
    expect(merged[0]?.deleted).toBe(true);
    expect(merged[0]?.deletedAt).toBe(5000);
  });

  it("only advances delivery status forward, never reverting read to delivered", () => {
    const local = [msg({ id: "m1", direction: "outbound", deliveryStatus: "read" })];
    const incoming = [msg({ id: "m1", direction: "outbound", deliveryStatus: "delivered" })];
    const merged = mergeMessages(local, incoming);
    expect(merged[0]?.deliveryStatus).toBe("read");
  });

  it("fills in media/quoted/text when local was missing them", () => {
    const local = [msg({ id: "m1", text: null, media: null, quoted: null })];
    const incoming = [
      msg({
        id: "m1",
        text: "caption",
        media: { relativePath: "media/m1.jpg", mimeType: "image/jpeg", fileName: "m1.jpg" },
        quoted: { messageId: "m0", sender: "Bob", snippet: "earlier" },
      }),
    ];
    const merged = mergeMessages(local, incoming);
    expect(merged[0]?.text).toBe("caption");
    expect(merged[0]?.media?.relativePath).toBe("media/m1.jpg");
    expect(merged[0]?.quoted?.messageId).toBe("m0");
  });

  it("keeps the richer raw payload when a duplicate adds a message secret", () => {
    const local = [msg({ id: "m1", raw: { message: { conversation: "hello" } } })];
    const incoming = [
      msg({
        id: "m1",
        raw: {
          message: {
            conversation: "hello",
            messageContextInfo: { messageSecret: "secret" },
          },
        },
      }),
    ];

    const merged = mergeMessages(local, incoming);

    expect(
      (merged[0]?.raw as { message?: { messageContextInfo?: { messageSecret?: string } } })
        .message?.messageContextInfo?.messageSecret,
    ).toBe("secret");
  });

  it("unions reactions without duplicates", () => {
    const local = [msg({ id: "m1", reactions: [{ emoji: "👍", sender: "a@s.whatsapp.net" }] })];
    const incoming = [
      msg({
        id: "m1",
        reactions: [
          { emoji: "👍", sender: "a@s.whatsapp.net" },
          { emoji: "❤️", sender: "b@s.whatsapp.net" },
        ],
      }),
    ];
    const merged = mergeMessages(local, incoming);
    expect(merged[0]?.reactions).toHaveLength(2);
  });
});

describe("applyMessageDeletion", () => {
  it("marks an existing message as deleted, keeping original content", () => {
    const chat: Chat = { ...createEmptyChat(JID, "individual"), messages: [msg({ id: "m1", text: "secret" })] };
    const updated = applyMessageDeletion(chat, "m1", 9999);
    expect(updated.messages[0]?.deleted).toBe(true);
    expect(updated.messages[0]?.deletedAt).toBe(9999);
    expect(updated.messages[0]?.text).toBe("secret");
  });

  it("creates a tombstone for an unknown message id", () => {
    const chat = createEmptyChat(JID, "individual");
    const updated = applyMessageDeletion(chat, "unknown-id", 1234);
    expect(updated.messages).toHaveLength(1);
    expect(updated.messages[0]).toMatchObject({ id: "unknown-id", deleted: true, deletedAt: 1234 });
  });
});

describe("applyMessageEdit", () => {
  it("updates the text without changing the original timestamp or position", () => {
    const chat: Chat = {
      ...createEmptyChat(JID, "individual"),
      messages: [msg({ id: "m1", text: "before", timestamp: 1000 })],
    };

    const updated = applyMessageEdit(chat, "m1", "after");

    expect(updated.messages[0]).toMatchObject({
      id: "m1",
      text: "after",
      timestamp: 1000,
      edited: true,
    });
  });
});

describe("applyDeliveryReceipt", () => {
  it("advances delivery status forward for an outbound message", () => {
    const chat: Chat = {
      ...createEmptyChat(JID, "individual"),
      messages: [msg({ id: "m1", direction: "outbound", deliveryStatus: "sent" })],
    };
    const updated = applyDeliveryReceipt(chat, "m1", "delivered");
    expect(updated.messages[0]?.deliveryStatus).toBe("delivered");
  });

  it("never downgrades delivery status", () => {
    const chat: Chat = {
      ...createEmptyChat(JID, "individual"),
      messages: [msg({ id: "m1", direction: "outbound", deliveryStatus: "read" })],
    };
    const updated = applyDeliveryReceipt(chat, "m1", "delivered");
    expect(updated.messages[0]?.deliveryStatus).toBe("read");
  });

  it("ignores receipts for inbound messages", () => {
    const chat: Chat = {
      ...createEmptyChat(JID, "individual"),
      messages: [msg({ id: "m1", direction: "inbound", deliveryStatus: null })],
    };
    const updated = applyDeliveryReceipt(chat, "m1", "delivered");
    expect(updated.messages[0]?.deliveryStatus).toBeNull();
  });

  it("marks a sent message failed when WhatsApp later rejects its ack", () => {
    const chat: Chat = {
      ...createEmptyChat(JID, "individual"),
      messages: [msg({ id: "m1", direction: "outbound", deliveryStatus: "sent" })],
    };
    const updated = applyDeliveryReceipt(chat, "m1", "failed");
    expect(updated.messages[0]?.deliveryStatus).toBe("failed");
  });
});

describe("applyReaction", () => {
  it("attaches a new reaction to a known message", () => {
    const chat: Chat = { ...createEmptyChat(JID, "individual"), messages: [msg({ id: "m1" })] };
    const updated = applyReaction(chat, "m1", { emoji: "👍", sender: "alice@s.whatsapp.net" });
    expect(updated.messages[0]?.reactions).toEqual([{ emoji: "👍", sender: "alice@s.whatsapp.net" }]);
  });

  it("replaces a sender's prior reaction rather than accumulating", () => {
    const chat: Chat = {
      ...createEmptyChat(JID, "individual"),
      messages: [msg({ id: "m1", reactions: [{ emoji: "👍", sender: "alice@s.whatsapp.net" }] })],
    };
    const updated = applyReaction(chat, "m1", { emoji: "❤️", sender: "alice@s.whatsapp.net" });
    expect(updated.messages[0]?.reactions).toEqual([{ emoji: "❤️", sender: "alice@s.whatsapp.net" }]);
  });

  it("removes a reaction when the incoming emoji is empty", () => {
    const chat: Chat = {
      ...createEmptyChat(JID, "individual"),
      messages: [msg({ id: "m1", reactions: [{ emoji: "👍", sender: "alice@s.whatsapp.net" }] })],
    };
    const updated = applyReaction(chat, "m1", { emoji: "", sender: "alice@s.whatsapp.net" });
    expect(updated.messages[0]?.reactions).toBeUndefined();
  });

  it("keeps other senders' reactions intact", () => {
    const chat: Chat = {
      ...createEmptyChat(JID, "individual"),
      messages: [
        msg({
          id: "m1",
          reactions: [
            { emoji: "👍", sender: "alice@s.whatsapp.net" },
            { emoji: "😂", sender: "bob@s.whatsapp.net" },
          ],
        }),
      ],
    };
    const updated = applyReaction(chat, "m1", { emoji: "❤️", sender: "alice@s.whatsapp.net" });
    expect(updated.messages[0]?.reactions).toEqual(
      expect.arrayContaining([
        { emoji: "❤️", sender: "alice@s.whatsapp.net" },
        { emoji: "😂", sender: "bob@s.whatsapp.net" },
      ]),
    );
  });

  it("ignores reactions for unknown message ids", () => {
    const chat = createEmptyChat(JID, "individual");
    const updated = applyReaction(chat, "unknown-id", { emoji: "👍", sender: "alice@s.whatsapp.net" });
    expect(updated).toBe(chat);
  });
});

describe("upsertChat", () => {
  it("composes meta merge and message merge", () => {
    const merged = upsertChat(null, { jid: JID, type: "individual", displayName: "Dana" }, [
      msg({ id: "m1", timestamp: 1000 }),
    ]);
    expect(merged.displayName).toBe("Dana");
    expect(merged.messages).toHaveLength(1);
    expect(merged.lastActivity).toBe(1000);
  });
});
