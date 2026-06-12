import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WAMessageAddressingMode, type WAMessage, type GroupMetadata, type Contact } from "baileys";
import { describe, expect, it } from "vitest";
import { encryptedEditOf } from "./edits.js";
import {
  editedTargetIdOf,
  editedTextOf,
  groupParticipantAliases,
  mapChat,
  mapGroupMetadata,
  mapWAMessage,
  messageType,
  phoneNumberFromMessages,
} from "./mappers.js";

const fixturesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "__fixtures__");

function fixture(name: string): WAMessage {
  return JSON.parse(readFileSync(path.join(fixturesDir, `${name}.json`), "utf8")) as WAMessage;
}

describe("messageType", () => {
  it("classifies plain conversation text", () => {
    expect(messageType(fixture("text"))).toBe("text");
  });

  it("classifies image messages", () => {
    expect(messageType(fixture("image-caption"))).toBe("image");
  });

  it("classifies extended text (replies) as text", () => {
    expect(messageType(fixture("quoted-reply"))).toBe("text");
  });

  it("classifies view-once wrapped media as viewOnce, not image", () => {
    expect(messageType(fixture("view-once"))).toBe("viewOnce");
  });
});

describe("encryptedEditOf", () => {
  it("extracts the target and encrypted bytes from a MESSAGE_EDIT envelope", () => {
    const edit = encryptedEditOf({
      key: { remoteJid: "123@lid", fromMe: true, id: "envelope" },
      message: {
        secretEncryptedMessage: {
          targetMessageKey: { remoteJid: "123@lid", fromMe: true, id: "original" },
          encPayload: Buffer.alloc(32, 1),
          encIv: Buffer.alloc(12, 2),
          secretEncType: "MESSAGE_EDIT",
        },
      },
    } as unknown as WAMessage);

    expect(edit?.targetId).toBe("original");
    expect(edit?.payload).toHaveLength(32);
    expect(edit?.iv).toHaveLength(12);
  });
});

describe("edit mapping", () => {
  it("extracts text from an editedMessage wrapper", () => {
    expect(editedTextOf({ editedMessage: { message: { conversation: "Edited text" } } })).toBe("Edited text");
  });

  it("extracts text and target id from a protocol MESSAGE_EDIT", () => {
    const message = {
      protocolMessage: {
        key: { id: "original" },
        type: 14,
        editedMessage: { extendedTextMessage: { text: "Edited text" } },
      },
    };
    expect(editedTextOf(message)).toBe("Edited text");
    expect(editedTargetIdOf(message)).toBe("original");
  });
});

describe("mapWAMessage", () => {
  it("maps a plain inbound text message", () => {
    const msg = mapWAMessage(fixture("text"));
    expect(msg).toMatchObject({
      id: "ABCD1234",
      senderJid: "123456789@s.whatsapp.net",
      senderName: "Alice",
      direction: "inbound",
      timestamp: 1700000000 * 1000,
      type: "text",
      text: "Hello there!",
      media: null,
      quoted: null,
      deliveryStatus: null,
      deleted: false,
      deletedAt: null,
    });
    expect(msg.raw).toBeDefined();
  });

  it("maps an image message and extracts its caption", () => {
    const msg = mapWAMessage(fixture("image-caption"));
    expect(msg.type).toBe("image");
    expect(msg.text).toBe("Check this out");
    expect(msg.senderJid).toBe("123456789@s.whatsapp.net");
  });

  it("maps a quoted reply with a snippet of the quoted message", () => {
    const msg = mapWAMessage(fixture("quoted-reply"));
    expect(msg.direction).toBe("outbound");
    expect(msg.text).toBe("Sounds good!");
    expect(msg.quoted).toEqual({
      messageId: "ABCD1234",
      sender: "123456789@s.whatsapp.net",
      snippet: "Hello there!",
    });
    // status 2 == SERVER_ACK -> "sent"
    expect(msg.deliveryStatus).toBe("sent");
  });

  it("quoted contextInfo — QuotedRef.sender carries the participant JID, not a display name", () => {
    // Req 5: the mapper must store the raw JID so read-time resolution can
    // apply resolveSenderLabel (contact lookup, own-JID → "You", etc.).
    const groupReply = {
      key: { remoteJid: "123456-789@g.us", fromMe: false, id: "GRP-REPLY", participant: "987654321@s.whatsapp.net" },
      messageTimestamp: 1700000500,
      pushName: "Bob",
      message: {
        extendedTextMessage: {
          text: "Agreed!",
          contextInfo: {
            stanzaId: "GRPMSG01",
            participant: "999000111@s.whatsapp.net",
            quotedMessage: { conversation: "Hey everyone" },
          },
        },
      },
    } as unknown as import("baileys").WAMessage;

    const msg = mapWAMessage(groupReply);
    // sender must be the raw normalized JID from contextInfo.participant
    expect(msg.quoted?.sender).toBe("999000111@s.whatsapp.net");
    expect(msg.quoted?.snippet).toBe("Hey everyone");
    expect(msg.quoted?.messageId).toBe("GRPMSG01");
  });

  it("maps a group message, taking the sender from key.participant", () => {
    const msg = mapWAMessage(fixture("group-message"));
    expect(msg.senderJid).toBe("987654321@s.whatsapp.net");
    expect(msg.senderName).toBe("Bob");
    expect(msg.text).toBe("Hey everyone");
  });

  it("classifies and maps a view-once image message", () => {
    const msg = mapWAMessage(fixture("view-once"));
    expect(msg.type).toBe("viewOnce");
    expect(msg.senderJid).toBe("123456789@s.whatsapp.net");
  });

  it("never throws on a revoke stub message and keeps the original id", () => {
    const msg = mapWAMessage(fixture("revoke"));
    expect(msg.id).toBe("ABCD1234");
    expect(msg.text).toBeNull();
  });
});

describe("mapChat", () => {
  const contacts = new Map<string, Contact>([
    ["123456789@s.whatsapp.net", { id: "123456789@s.whatsapp.net", name: "Alice Saved", notify: "Alice" }],
  ]);

  it("maps an individual chat, preferring the saved contact name", () => {
    const partial = mapChat({ id: "123456789@s.whatsapp.net", conversationTimestamp: 1700000000 }, contacts);
    expect(partial.jid).toBe("123456789@s.whatsapp.net");
    expect(partial.type).toBe("individual");
    expect(partial.displayName).toBe("Alice Saved");
    expect(partial.phoneNumber).toBe("+123456789");
    expect(partial.lastActivity).toBe(1700000000 * 1000);
  });

  it("marks group jids as group chats with a subject", () => {
    const partial = mapChat({ id: "123456-789@g.us", name: "Cool Group" }, contacts);
    expect(partial.type).toBe("group");
    expect(partial.groupSubject).toBe("Cool Group");
    expect(partial.phoneNumber).toBeUndefined();
  });

  it("resolves a @lid chat through the contact's paired phone jid", () => {
    const lidContacts = new Map<string, Contact>([
      ["555111@lid", { id: "555111@lid", lid: "555111@lid", phoneNumber: "123456789@s.whatsapp.net", name: "Alice Saved" }],
    ]);
    const partial = mapChat({ id: "555111@lid" }, lidContacts);
    expect(partial.displayName).toBe("Alice Saved");
    // never present the opaque lid id as a phone number — use the paired jid
    expect(partial.phoneNumber).toBe("+123456789");
  });

  it("falls back to verifiedName for business accounts with no saved name", () => {
    const bizContacts = new Map<string, Contact>([
      ["999@lid", { id: "999@lid", verifiedName: "WhatsApp Business" }],
    ]);
    const partial = mapChat({ id: "999@lid" }, bizContacts);
    expect(partial.displayName).toBe("WhatsApp Business");
    // no paired phone jid → no bogus number derived from the lid
    expect(partial.phoneNumber).toBeUndefined();
  });

  it("names WhatsApp's official service account and hides its bogus +0 number", () => {
    const partial = mapChat({ id: "0@s.whatsapp.net" }, contacts);
    expect(partial.displayName).toBe("WhatsApp");
    expect(partial.phoneNumber).toBeUndefined();
  });

  it("never names a non-contact off their push name (contact.notify or chat.name)", () => {
    // Both fields carry the peer's self-chosen profile name for non-contacts;
    // the UI must keep rendering "Not Contact" instead.
    const strangers = new Map<string, Contact>([
      ["888@lid", { id: "888@lid", notify: "👆🥳" }],
    ]);
    const partial = mapChat({ id: "888@lid", name: "👆🥳" }, strangers);
    expect(partial.displayName).toBeUndefined();
  });
});

describe("phoneNumberFromMessages", () => {
  it("takes the peer's number from a key's remoteJidAlt", () => {
    const messages = [
      { key: { remoteJid: "888@lid", fromMe: false, id: "i1" } },
      { key: { remoteJid: "888@lid", fromMe: true, id: "o1", remoteJidAlt: "5491100000003@s.whatsapp.net" } },
    ] as unknown as WAMessage[];
    expect(phoneNumberFromMessages(messages)).toBe("+5491100000003");
  });

  it("takes the peer's number from a legacy inbound key's senderPn, skipping fromMe keys", () => {
    const messages = [
      { key: { remoteJid: "888@lid", fromMe: true, id: "o1", senderPn: "111@s.whatsapp.net" } },
      { key: { remoteJid: "888@lid", fromMe: false, id: "i1", senderPn: "5491100000003@s.whatsapp.net" } },
    ] as unknown as WAMessage[];
    expect(phoneNumberFromMessages(messages)).toBe("+5491100000003");
  });

  it("returns null when no key carries a phone-address alt jid", () => {
    const messages = [
      { key: { remoteJid: "888@lid", fromMe: false, id: "i1" } },
      { key: { remoteJid: "888@lid", fromMe: false, id: "i2", remoteJidAlt: "999@lid" } },
    ] as unknown as WAMessage[];
    expect(phoneNumberFromMessages(messages)).toBeNull();
  });
});

describe("mapGroupMetadata", () => {
  it("maps subject and participants", () => {
    const meta: GroupMetadata = {
      id: "123456-789@g.us",
      addressingMode: WAMessageAddressingMode.PN,
      owner: "987654321@s.whatsapp.net",
      subject: "Cool Group",
      participants: [
        { id: "987654321@s.whatsapp.net", name: "Bob", isAdmin: true },
        { id: "555555555@s.whatsapp.net", notify: "Carol" },
      ],
    };
    const partial = mapGroupMetadata(meta);
    expect(partial.groupSubject).toBe("Cool Group");
    expect(partial.participants).toEqual([
      { jid: "987654321@s.whatsapp.net", displayName: "Bob", isAdmin: true },
      { jid: "555555555@s.whatsapp.net", displayName: "Carol", isAdmin: undefined },
    ]);
  });
});

describe("groupParticipantAliases", () => {
  it("pairs lid participants with their phone jids, skipping unpaired or non-lid entries", () => {
    const aliases = groupParticipantAliases([
      { id: "111222333@lid", phoneNumber: "5491100000000@s.whatsapp.net" },
      { id: "444555666@lid" }, // no pairing delivered
      { id: "987654321@s.whatsapp.net", phoneNumber: "987654321@s.whatsapp.net" }, // pn-addressed group
    ]);
    expect([...aliases]).toEqual([["111222333@lid", "5491100000000@s.whatsapp.net"]]);
  });
});
