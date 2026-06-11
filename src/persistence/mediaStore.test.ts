import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setActiveAccount } from "./paths.js";
import { absoluteMediaPath, fileUrl, mimeToExt, saveMedia } from "./mediaStore.js";

let tmpDir: string;
let originalDataDir: string | undefined;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "wa-chat-media-"));
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

const JID = "12345@s.whatsapp.net";

describe("saveMedia", () => {
  it("writes the file under media/ and returns a relative path", async () => {
    const ref = await saveMedia(JID, {
      data: Buffer.from("hello world"),
      messageId: "msg-1",
      mimeType: "image/jpeg",
    });
    expect(ref.relativePath).toBe("media/msg-1.jpg");
    expect(ref.mimeType).toBe("image/jpeg");

    const abs = absoluteMediaPath(JID, ref);
    const contents = await fs.readFile(abs, "utf8");
    expect(contents).toBe("hello world");
  });

  it("derives the extension from fileName when mimeType is absent", async () => {
    const ref = await saveMedia(JID, {
      data: Buffer.from("data"),
      messageId: "msg-2",
      fileName: "report.pdf",
    });
    expect(ref.relativePath).toBe("media/msg-2.pdf");
  });

  it("does not duplicate when re-saving the same messageId with the same size", async () => {
    const opts = { data: Buffer.from("same bytes"), messageId: "msg-3", mimeType: "image/png" };
    const first = await saveMedia(JID, opts);
    const abs = absoluteMediaPath(JID, first);
    const statBefore = await fs.stat(abs);

    await new Promise((r) => setTimeout(r, 5));
    const second = await saveMedia(JID, opts);
    const statAfter = await fs.stat(absoluteMediaPath(JID, second));

    expect(statAfter.mtimeMs).toBe(statBefore.mtimeMs);
    expect(second.relativePath).toBe(first.relativePath);
  });

  it("rewrites when content size differs for the same messageId", async () => {
    await saveMedia(JID, { data: Buffer.from("short"), messageId: "msg-4", mimeType: "image/png" });
    const ref = await saveMedia(JID, {
      data: Buffer.from("a much longer body of bytes"),
      messageId: "msg-4",
      mimeType: "image/png",
    });
    const contents = await fs.readFile(absoluteMediaPath(JID, ref), "utf8");
    expect(contents).toBe("a much longer body of bytes");
  });
});

describe("absoluteMediaPath / fileUrl", () => {
  it("produces a valid absolute file:// URL", async () => {
    const ref = await saveMedia(JID, { data: Buffer.from("x"), messageId: "msg-5", mimeType: "image/jpeg" });
    const abs = absoluteMediaPath(JID, ref);
    expect(path.isAbsolute(abs)).toBe(true);

    const url = fileUrl(abs);
    expect(url.startsWith("file:///")).toBe(true);
    expect(url).toContain("msg-5.jpg");
  });
});

describe("mimeToExt", () => {
  it("maps common mime types to extensions", () => {
    expect(mimeToExt("image/jpeg")).toBe("jpg");
    expect(mimeToExt("image/png")).toBe("png");
    expect(mimeToExt("video/mp4")).toBe("mp4");
    expect(mimeToExt("audio/ogg; codecs=opus")).toBe("ogg");
    expect(mimeToExt("application/pdf")).toBe("pdf");
  });

  it("returns null for unknown mime types", () => {
    expect(mimeToExt("application/x-totally-unknown")).toBeNull();
  });
});
