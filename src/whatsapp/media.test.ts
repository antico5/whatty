import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { WAMessage } from "baileys";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setActiveAccount } from "../persistence/paths.js";

vi.mock("baileys", async (importOriginal) => {
  const actual = await importOriginal<typeof import("baileys")>();
  return { ...actual, downloadMediaMessage: vi.fn(), delay: () => Promise.resolve() };
});

import { downloadMediaMessage } from "baileys";
import { absoluteMediaPath } from "../persistence/mediaStore.js";
import type { Connection } from "./connection.js";
import { downloadAndStore } from "./media.js";

let tmpDir: string;
let originalDataDir: string | undefined;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "wa-chat-media-dl-"));
  originalDataDir = process.env.WA_CHAT_DATA_DIR;
  process.env.WA_CHAT_DATA_DIR = tmpDir;
  setActiveAccount("test-account@s.whatsapp.net");
  vi.mocked(downloadMediaMessage).mockReset();
});

afterEach(async () => {
  if (originalDataDir === undefined) delete process.env.WA_CHAT_DATA_DIR;
  else process.env.WA_CHAT_DATA_DIR = originalDataDir;
  setActiveAccount(null);
  await fs.rm(tmpDir, { recursive: true, force: true });
});

const JID = "12345@s.whatsapp.net";

function fakeConnection(): Connection {
  const sock = { updateMediaMessage: vi.fn(), user: { id: "me@s.whatsapp.net" } };
  return { getSocket: () => sock } as unknown as Connection;
}

function imageMessage(id: string): WAMessage {
  return {
    key: { remoteJid: JID, fromMe: false, id },
    messageTimestamp: 1_700_000_000,
    message: { imageMessage: { mimetype: "image/jpeg", caption: "hi" } },
  } as unknown as WAMessage;
}

function textMessage(id: string): WAMessage {
  return {
    key: { remoteJid: JID, fromMe: false, id },
    messageTimestamp: 1_700_000_000,
    message: { conversation: "hi" },
  } as unknown as WAMessage;
}

describe("downloadAndStore", () => {
  it("returns null for non-media messages without attempting a download", async () => {
    const ref = await downloadAndStore(fakeConnection(), textMessage("m1"), JID);
    expect(ref).toBeNull();
    expect(downloadMediaMessage).not.toHaveBeenCalled();
  });

  it("downloads and persists media on success", async () => {
    vi.mocked(downloadMediaMessage).mockResolvedValueOnce(Buffer.from("image bytes"));
    const ref = await downloadAndStore(fakeConnection(), imageMessage("m2"), JID);
    expect(ref?.relativePath).toBe("media/m2.jpg");
    const contents = await fs.readFile(absoluteMediaPath(JID, ref!), "utf8");
    expect(contents).toBe("image bytes");
  });

  it("retries on failure and gives up after the max attempts without throwing", async () => {
    vi.mocked(downloadMediaMessage).mockRejectedValue(new Error("network blip"));
    const ref = await downloadAndStore(fakeConnection(), imageMessage("m3"), JID);
    expect(ref).toBeNull();
    expect(downloadMediaMessage).toHaveBeenCalledTimes(3);
  });

  it("succeeds after a transient failure", async () => {
    vi.mocked(downloadMediaMessage)
      .mockRejectedValueOnce(new Error("network blip"))
      .mockResolvedValueOnce(Buffer.from("retry bytes"));
    const ref = await downloadAndStore(fakeConnection(), imageMessage("m4"), JID);
    expect(ref?.relativePath).toBe("media/m4.jpg");
    expect(downloadMediaMessage).toHaveBeenCalledTimes(2);
  });

  it("returns null when there is no active socket", async () => {
    const conn = { getSocket: () => null } as unknown as Connection;
    const ref = await downloadAndStore(conn, imageMessage("m5"), JID);
    expect(ref).toBeNull();
    expect(downloadMediaMessage).not.toHaveBeenCalled();
  });
});
