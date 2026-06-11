import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setActiveAccount } from "../persistence/paths.js";
import { loadChat } from "../persistence/chatStore.js";
import { applyDeliveryReceipt } from "../persistence/reconcile.js";
import type { Connection } from "./connection.js";
import { createSender } from "./send.js";

let tmpDir: string;
let originalDataDir: string | undefined;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "wa-chat-send-"));
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

function fakeConnection(sendText: Connection["sendText"]): Connection & EventEmitter {
  const emitter = new EventEmitter() as Connection & EventEmitter;
  emitter.start = async () => {};
  emitter.stop = async () => {};
  emitter.sendText = sendText;
  emitter.getSocket = () => null;
  return emitter;
}

describe("createSender.sendText", () => {
  it("persists optimistically, then sets status sent and the real id on success", async () => {
    const sendText = vi.fn().mockResolvedValue({
      key: { remoteJid: JID, fromMe: true, id: "real-server-id" },
      messageTimestamp: 1_700_000_000,
    });
    const conn = fakeConnection(sendText as unknown as Connection["sendText"]);
    const sender = createSender(conn);
    const updates: string[] = [];
    sender.on("chat-updated", (jid: string) => updates.push(jid));

    const result = await sender.sendText(JID, "hello there");

    expect(result.deliveryStatus).toBe("sent");
    expect(result.id).toBe("real-server-id");
    expect(result.text).toBe("hello there");

    const chat = await loadChat(JID);
    expect(chat?.messages).toHaveLength(1);
    const msg = chat?.messages[0];
    expect(msg?.id).toBe("real-server-id");
    expect(msg?.deliveryStatus).toBe("sent");
    expect(msg?.text).toBe("hello there");
    expect(msg?.direction).toBe("outbound");
    expect(updates.filter((j) => j === JID).length).toBeGreaterThanOrEqual(2);
  });

  it("sets status failed and keeps the message present when the send rejects", async () => {
    const sendText = vi.fn().mockRejectedValue(new Error("network down"));
    const conn = fakeConnection(sendText as unknown as Connection["sendText"]);
    const sender = createSender(conn);

    const result = await sender.sendText(JID, "will fail");

    expect(result.deliveryStatus).toBe("failed");

    const chat = await loadChat(JID);
    expect(chat?.messages).toHaveLength(1);
    expect(chat?.messages[0]?.deliveryStatus).toBe("failed");
    expect(chat?.messages[0]?.text).toBe("will fail");
  });

  it("allows a subsequent receipt to advance the sent message's status", async () => {
    const sendText = vi.fn().mockResolvedValue({
      key: { remoteJid: JID, fromMe: true, id: "real-id-2" },
      messageTimestamp: 1_700_000_100,
    });
    const conn = fakeConnection(sendText as unknown as Connection["sendText"]);
    const sender = createSender(conn);

    await sender.sendText(JID, "ping");

    let chat = await loadChat(JID);
    expect(chat?.messages[0]?.deliveryStatus).toBe("sent");

    chat = applyDeliveryReceipt(chat!, "real-id-2", "delivered");
    expect(chat.messages[0]?.deliveryStatus).toBe("delivered");

    chat = applyDeliveryReceipt(chat, "real-id-2", "read");
    expect(chat.messages[0]?.deliveryStatus).toBe("read");
  });
});
