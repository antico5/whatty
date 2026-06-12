// Run tests in UTC so formatMediaTimestamp output is deterministic across machines.
process.env.TZ = "UTC";

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setActiveAccount } from "./paths.js";
import { absoluteMediaPath, fileUrl, formatMediaTimestamp, messageIdSuffix, mimeToExt, saveMedia } from "./mediaStore.js";

let tmpDir: string;
let originalDataDir: string | undefined;

// A fixed timestamp used across tests: 2024-03-04 15:20:42.124 UTC.
const FIXED_TS_MS = 1_709_565_642_124;
// Expected formatted prefix for FIXED_TS_MS in UTC.
const FIXED_TS_FMT = "2024_03_04_15_20_42_124";

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "whatsapp-terminal-media-"));
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

const JID = "12345@s.whatsapp.net";

describe("formatMediaTimestamp", () => {
  it("formats a known UTC timestamp to yyyy_MM_dd_HH_mm_ss_SSS", () => {
    // 2024-03-04 15:20:42.124 UTC
    expect(formatMediaTimestamp(FIXED_TS_MS)).toBe(FIXED_TS_FMT);
  });

  it("pads single-digit month, day, hour, minute, second with zeros", () => {
    // 2024-01-05 03:07:09.006 UTC
    const ts = new Date("2024-01-05T03:07:09.006Z").getTime();
    expect(formatMediaTimestamp(ts)).toBe("2024_01_05_03_07_09_006");
  });

  it("pads single-digit milliseconds to three digits", () => {
    // 2024-06-15 12:00:00.042 UTC
    const ts = new Date("2024-06-15T12:00:00.042Z").getTime();
    expect(formatMediaTimestamp(ts)).toBe("2024_06_15_12_00_00_042");
  });
});

describe("messageIdSuffix", () => {
  it("returns the last 8 chars of the sanitized message id", () => {
    expect(messageIdSuffix("3EB0C9A0D2B6")).toBe("C9A0D2B6");
  });

  it("sanitizes non-alphanumeric chars before slicing", () => {
    // "A@B:C.D-E" → sanitized "A_B_C.D-E" → last 8 = "B_C.D-E" — only 7 after prefix
    // "A@B:C.D-EF" → sanitized "A_B_C.D-EF" (10 chars) → last 8 = "B_C.D-EF"
    expect(messageIdSuffix("A@B:C.D-EF")).toBe("B_C.D-EF");
  });

  it("returns the full sanitized id when shorter than 8 chars", () => {
    expect(messageIdSuffix("msg-1")).toBe("msg-1");
  });

  it("is deterministic for the same message id", () => {
    const id = "3EB0C9A0D2B6CAFE";
    expect(messageIdSuffix(id)).toBe(messageIdSuffix(id));
  });
});

describe("saveMedia", () => {
  it("writes the file under media/ with timestamp-based name and returns a relative path", async () => {
    const ref = await saveMedia(JID, {
      data: Buffer.from("hello world"),
      messageId: "msg-1",
      timestamp: FIXED_TS_MS,
      mimeType: "image/jpeg",
    });
    const suffix = messageIdSuffix("msg-1");
    expect(ref.relativePath).toBe(`media/${FIXED_TS_FMT}__${suffix}.jpg`);
    expect(ref.mimeType).toBe("image/jpeg");

    const abs = absoluteMediaPath(ref);
    const contents = await fs.readFile(abs, "utf8");
    expect(contents).toBe("hello world");
  });

  it("derives the extension from fileName when mimeType is absent", async () => {
    const ref = await saveMedia(JID, {
      data: Buffer.from("data"),
      messageId: "msg-2",
      timestamp: FIXED_TS_MS,
      fileName: "report.pdf",
    });
    const suffix = messageIdSuffix("msg-2");
    expect(ref.relativePath).toBe(`media/${FIXED_TS_FMT}__${suffix}.pdf`);
  });

  it("does not duplicate when re-saving the same messageId and timestamp with the same size", async () => {
    const opts = { data: Buffer.from("same bytes"), messageId: "msg-3", timestamp: FIXED_TS_MS, mimeType: "image/png" };
    const first = await saveMedia(JID, opts);
    const abs = absoluteMediaPath(first);
    const statBefore = await fs.stat(abs);

    await new Promise((r) => setTimeout(r, 5));
    const second = await saveMedia(JID, opts);
    const statAfter = await fs.stat(absoluteMediaPath(second));

    expect(statAfter.mtimeMs).toBe(statBefore.mtimeMs);
    expect(second.relativePath).toBe(first.relativePath);
  });

  it("rewrites when content size differs for the same messageId and timestamp", async () => {
    await saveMedia(JID, { data: Buffer.from("short"), messageId: "msg-4", timestamp: FIXED_TS_MS, mimeType: "image/png" });
    const ref = await saveMedia(JID, {
      data: Buffer.from("a much longer body of bytes"),
      messageId: "msg-4",
      timestamp: FIXED_TS_MS,
      mimeType: "image/png",
    });
    const contents = await fs.readFile(absoluteMediaPath(ref), "utf8");
    expect(contents).toBe("a much longer body of bytes");
  });

  it("two messages with the same timestamp but different ids produce different filenames", async () => {
    const ref1 = await saveMedia(JID, {
      data: Buffer.from("data-a"),
      messageId: "AAAA0001",
      timestamp: FIXED_TS_MS,
      mimeType: "image/jpeg",
    });
    const ref2 = await saveMedia(JID, {
      data: Buffer.from("data-b"),
      messageId: "BBBB0002",
      timestamp: FIXED_TS_MS,
      mimeType: "image/jpeg",
    });
    expect(ref1.relativePath).not.toBe(ref2.relativePath);
    // Both names start with the same timestamp prefix.
    expect(ref1.relativePath.startsWith(`media/${FIXED_TS_FMT}`)).toBe(true);
    expect(ref2.relativePath.startsWith(`media/${FIXED_TS_FMT}`)).toBe(true);
  });

  it("preserves the extension from mimeType over fileName when both are present", async () => {
    const ref = await saveMedia(JID, {
      data: Buffer.from("x"),
      messageId: "msg-ext",
      timestamp: FIXED_TS_MS,
      mimeType: "image/png",
      fileName: "photo.jpg",
    });
    expect(ref.relativePath.endsWith(".png")).toBe(true);
  });

  it("produces no extension when neither mimeType nor fileName is provided", async () => {
    const ref = await saveMedia(JID, {
      data: Buffer.from("x"),
      messageId: "msg-noext",
      timestamp: FIXED_TS_MS,
    });
    // The path should end with the id suffix (no dot-extension).
    const suffix = messageIdSuffix("msg-noext");
    expect(ref.relativePath).toBe(`media/${FIXED_TS_FMT}__${suffix}`);
  });
});

describe("absoluteMediaPath / fileUrl", () => {
  it("produces a valid absolute file:// URL", async () => {
    const ref = await saveMedia(JID, { data: Buffer.from("x"), messageId: "msg-5", timestamp: FIXED_TS_MS, mimeType: "image/jpeg" });
    const abs = absoluteMediaPath(ref);
    expect(path.isAbsolute(abs)).toBe(true);

    const url = fileUrl(abs);
    expect(url.startsWith("file:///")).toBe(true);
    // The suffix of msg-5 (5 chars < 8, full string) is "msg-5".
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
