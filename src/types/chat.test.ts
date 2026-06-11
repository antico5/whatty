import { describe, expect, it } from "vitest";
import { createEmptyChat, isGroupJid } from "./chat.js";

describe("createEmptyChat", () => {
  it("produces an empty chat shape for an individual JID", () => {
    const chat = createEmptyChat("12345@s.whatsapp.net", "individual");
    expect(chat).toEqual({
      jid: "12345@s.whatsapp.net",
      type: "individual",
      displayName: null,
      phoneNumber: null,
      groupSubject: null,
      participants: [],
      archived: false,
      lastActivity: 0,
      messages: [],
    });
  });

  it("produces an empty chat shape for a group JID", () => {
    const chat = createEmptyChat("123-456@g.us", "group");
    expect(chat.type).toBe("group");
    expect(chat.jid).toBe("123-456@g.us");
    expect(chat.participants).toEqual([]);
    expect(chat.messages).toEqual([]);
  });
});

describe("isGroupJid", () => {
  it("returns true for group JIDs", () => {
    expect(isGroupJid("123-456@g.us")).toBe(true);
  });

  it("returns false for individual JIDs", () => {
    expect(isGroupJid("12345@s.whatsapp.net")).toBe(false);
  });
});
