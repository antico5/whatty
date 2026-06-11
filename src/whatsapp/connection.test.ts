import { Boom } from "@hapi/boom";
import { DisconnectReason } from "baileys";
import { describe, expect, it } from "vitest";
import { createEmptyChat, type Chat } from "../types/index.js";
import { isLoggedOut, mapConnectionUpdate, resolveMessageContent, shouldReconnect } from "./connection.js";

function closeUpdate(statusCode: number | undefined) {
  return {
    connection: "close" as const,
    lastDisconnect: {
      error: statusCode === undefined ? new Error("boom") : new Boom("closed", { statusCode }),
    },
  };
}

describe("isLoggedOut", () => {
  it("is true for every reason that invalidates the session", () => {
    expect(isLoggedOut(DisconnectReason.loggedOut)).toBe(true);
    expect(isLoggedOut(DisconnectReason.forbidden)).toBe(true);
    expect(isLoggedOut(DisconnectReason.multideviceMismatch)).toBe(true);
  });

  it("is false for transient reasons and unknown codes", () => {
    expect(isLoggedOut(DisconnectReason.connectionClosed)).toBe(false);
    expect(isLoggedOut(DisconnectReason.restartRequired)).toBe(false);
    expect(isLoggedOut(DisconnectReason.connectionReplaced)).toBe(false);
    expect(isLoggedOut(undefined)).toBe(false);
  });
});

describe("shouldReconnect", () => {
  it("returns false when the session was invalidated", () => {
    expect(shouldReconnect(DisconnectReason.loggedOut)).toBe(false);
    expect(shouldReconnect(DisconnectReason.forbidden)).toBe(false);
    expect(shouldReconnect(DisconnectReason.multideviceMismatch)).toBe(false);
  });

  it("returns true for other disconnect reasons", () => {
    expect(shouldReconnect(DisconnectReason.connectionClosed)).toBe(true);
    expect(shouldReconnect(DisconnectReason.restartRequired)).toBe(true);
    expect(shouldReconnect(undefined)).toBe(true);
  });
});

describe("mapConnectionUpdate", () => {
  it("returns null when there is no connection field", () => {
    expect(mapConnectionUpdate({})).toBeNull();
  });

  it("passes through connecting/open as-is", () => {
    expect(mapConnectionUpdate({ connection: "connecting" })).toBe("connecting");
    expect(mapConnectionUpdate({ connection: "open" })).toBe("open");
  });

  it("maps a session-invalidating close to logged-out", () => {
    expect(mapConnectionUpdate(closeUpdate(DisconnectReason.loggedOut))).toBe("logged-out");
    expect(mapConnectionUpdate(closeUpdate(DisconnectReason.forbidden))).toBe("logged-out");
    expect(mapConnectionUpdate(closeUpdate(DisconnectReason.multideviceMismatch))).toBe("logged-out");
  });

  it("maps any other close to close", () => {
    expect(mapConnectionUpdate(closeUpdate(DisconnectReason.connectionLost))).toBe("close");
    expect(mapConnectionUpdate(closeUpdate(DisconnectReason.restartRequired))).toBe("close");
    expect(mapConnectionUpdate(closeUpdate(undefined))).toBe("close");
  });
});

describe("resolveMessageContent", () => {
  it("falls back by message id when an edit target carries the sender's chat perspective", async () => {
    const peerJid = "100000000000001@lid";
    const selfJid = "100000000000004@lid";
    const id = "original-id";
    const peerChat: Chat = {
      ...createEmptyChat(peerJid, "individual"),
      messages: [
        {
          id,
          senderJid: peerJid,
          senderName: null,
          direction: "inbound",
          timestamp: 1000,
          type: "text",
          text: "Before",
          media: null,
          quoted: null,
          deliveryStatus: null,
          deleted: false,
          deletedAt: null,
          raw: {
            message: {
              conversation: "Before",
              messageContextInfo: { messageSecret: Buffer.alloc(32, 7) },
            },
          },
        },
      ],
    };

    const content = await resolveMessageContent(
      { remoteJid: selfJid, fromMe: true, id },
      {
        loadChat: async () => null,
        findMessageById: async (messageId) => {
          const message = peerChat.messages.find((m) => m.id === messageId);
          return message ? { chatJid: peerChat.jid, message } : null;
        },
      },
    );

    expect(content?.conversation).toBe("Before");
    expect(content?.messageContextInfo?.messageSecret).toHaveLength(32);
  });
});
