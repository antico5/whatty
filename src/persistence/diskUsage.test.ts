import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { dbSize, getDiskUsage, getStorageSummary, mediaBreakdown, mediaSize } from "./diskUsage.js";
import { setActiveAccount } from "./paths.js";

let tmpDir: string;
let originalDataDir: string | undefined;

const ACCOUNT_ID = "111111111@s.whatsapp.net";

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "whatsapp-terminal-disk-"));
  originalDataDir = process.env.WHATSAPP_TERMINAL_DATA_DIR;
  process.env.WHATSAPP_TERMINAL_DATA_DIR = tmpDir;
  setActiveAccount(ACCOUNT_ID);

  // create the account dir layout
  const accountDir = path.join(tmpDir, "accounts", ACCOUNT_ID);
  await fs.mkdir(accountDir, { recursive: true });
  await fs.mkdir(path.join(accountDir, "media"), { recursive: true });
});

afterEach(async () => {
  if (originalDataDir === undefined) delete process.env.WHATSAPP_TERMINAL_DATA_DIR;
  else process.env.WHATSAPP_TERMINAL_DATA_DIR = originalDataDir;
  setActiveAccount(null);
  await fs.rm(tmpDir, { recursive: true, force: true });
});

function accountDir(): string {
  return path.join(tmpDir, "accounts", ACCOUNT_ID);
}

describe("dbSize", () => {
  it("returns 0 when no db files exist", async () => {
    expect(await dbSize(ACCOUNT_ID)).toBe(0);
  });

  it("counts only the main db file when WAL files are absent", async () => {
    const dbFile = path.join(accountDir(), "chats.db");
    await fs.writeFile(dbFile, Buffer.alloc(1024));
    expect(await dbSize(ACCOUNT_ID)).toBe(1024);
  });

  it("sums db + wal + shm files", async () => {
    const base = path.join(accountDir(), "chats.db");
    await fs.writeFile(base, Buffer.alloc(1000));
    await fs.writeFile(base + "-wal", Buffer.alloc(500));
    await fs.writeFile(base + "-shm", Buffer.alloc(32));
    expect(await dbSize(ACCOUNT_ID)).toBe(1532);
  });
});

describe("mediaSize", () => {
  it("returns 0 when the media directory is empty", async () => {
    expect(await mediaSize(ACCOUNT_ID)).toBe(0);
  });

  it("returns 0 when the media directory does not exist", async () => {
    await fs.rm(path.join(accountDir(), "media"), { recursive: true });
    expect(await mediaSize(ACCOUNT_ID)).toBe(0);
  });

  it("sums all file sizes in the media directory", async () => {
    const mediaDir = path.join(accountDir(), "media");
    await fs.writeFile(path.join(mediaDir, "img1.jpg"), Buffer.alloc(200));
    await fs.writeFile(path.join(mediaDir, "img2.jpg"), Buffer.alloc(300));
    expect(await mediaSize(ACCOUNT_ID)).toBe(500);
  });
});

describe("getDiskUsage", () => {
  it("returns zeroed object when no files exist", async () => {
    const usage = await getDiskUsage(ACCOUNT_ID);
    expect(usage).toEqual({ db: 0, media: 0, total: 0 });
  });

  it("correctly breaks down db, media, and total (including log file)", async () => {
    const base = path.join(accountDir(), "chats.db");
    await fs.writeFile(base, Buffer.alloc(1000));
    await fs.writeFile(base + "-wal", Buffer.alloc(200));

    const mediaDir = path.join(accountDir(), "media");
    await fs.writeFile(path.join(mediaDir, "photo.jpg"), Buffer.alloc(400));

    // create log file
    await fs.writeFile(path.join(tmpDir, "whatsapp-terminal.log"), Buffer.alloc(100));

    const usage = await getDiskUsage(ACCOUNT_ID);
    expect(usage.db).toBe(1200);
    expect(usage.media).toBe(400);
    expect(usage.total).toBe(1700); // 1200 + 400 + 100
  });

  it("total equals db + media when there is no log file", async () => {
    const base = path.join(accountDir(), "chats.db");
    await fs.writeFile(base, Buffer.alloc(500));
    const mediaDir = path.join(accountDir(), "media");
    await fs.writeFile(path.join(mediaDir, "file.mp4"), Buffer.alloc(300));

    const usage = await getDiskUsage(ACCOUNT_ID);
    expect(usage.db).toBe(500);
    expect(usage.media).toBe(300);
    expect(usage.total).toBe(800);
  });
});

describe("mediaBreakdown", () => {
  it("returns all-zero breakdown when media directory is empty", async () => {
    const bd = await mediaBreakdown(ACCOUNT_ID);
    expect(bd).toEqual({ images: 0, videos: 0, audio: 0, stickers: 0, documents: 0, other: 0 });
  });

  it("returns all-zero breakdown when media directory does not exist", async () => {
    await fs.rm(path.join(accountDir(), "media"), { recursive: true });
    const bd = await mediaBreakdown(ACCOUNT_ID);
    expect(bd).toEqual({ images: 0, videos: 0, audio: 0, stickers: 0, documents: 0, other: 0 });
  });

  it("classifies jpg/png/gif as images", async () => {
    const dir = path.join(accountDir(), "media");
    await fs.writeFile(path.join(dir, "a.jpg"), Buffer.alloc(100));
    await fs.writeFile(path.join(dir, "b.png"), Buffer.alloc(200));
    await fs.writeFile(path.join(dir, "c.gif"), Buffer.alloc(50));
    const bd = await mediaBreakdown(ACCOUNT_ID);
    expect(bd.images).toBe(350);
    expect(bd.stickers).toBe(0);
  });

  it("classifies webp as stickers (not images)", async () => {
    const dir = path.join(accountDir(), "media");
    await fs.writeFile(path.join(dir, "sticker.webp"), Buffer.alloc(300));
    const bd = await mediaBreakdown(ACCOUNT_ID);
    expect(bd.stickers).toBe(300);
    expect(bd.images).toBe(0);
  });

  it("classifies mp4/3gp/mov as videos", async () => {
    const dir = path.join(accountDir(), "media");
    await fs.writeFile(path.join(dir, "clip.mp4"), Buffer.alloc(2000));
    await fs.writeFile(path.join(dir, "old.3gp"), Buffer.alloc(500));
    const bd = await mediaBreakdown(ACCOUNT_ID);
    expect(bd.videos).toBe(2500);
  });

  it("classifies ogg/opus/mp3/m4a/aac as audio", async () => {
    const dir = path.join(accountDir(), "media");
    await fs.writeFile(path.join(dir, "voice.ogg"), Buffer.alloc(800));
    await fs.writeFile(path.join(dir, "song.mp3"), Buffer.alloc(1200));
    const bd = await mediaBreakdown(ACCOUNT_ID);
    expect(bd.audio).toBe(2000);
  });

  it("classifies pdf/zip/doc/docx/txt as documents", async () => {
    const dir = path.join(accountDir(), "media");
    await fs.writeFile(path.join(dir, "report.pdf"), Buffer.alloc(400));
    await fs.writeFile(path.join(dir, "archive.zip"), Buffer.alloc(600));
    const bd = await mediaBreakdown(ACCOUNT_ID);
    expect(bd.documents).toBe(1000);
  });

  it("classifies unknown extensions as other", async () => {
    const dir = path.join(accountDir(), "media");
    await fs.writeFile(path.join(dir, "data.bin"), Buffer.alloc(250));
    await fs.writeFile(path.join(dir, "noext"), Buffer.alloc(100));
    const bd = await mediaBreakdown(ACCOUNT_ID);
    expect(bd.other).toBe(350);
  });

  it("sums mixed file types correctly", async () => {
    const dir = path.join(accountDir(), "media");
    await fs.writeFile(path.join(dir, "photo.jpg"), Buffer.alloc(100));
    await fs.writeFile(path.join(dir, "video.mp4"), Buffer.alloc(200));
    await fs.writeFile(path.join(dir, "voice.ogg"), Buffer.alloc(300));
    await fs.writeFile(path.join(dir, "sticker.webp"), Buffer.alloc(50));
    await fs.writeFile(path.join(dir, "doc.pdf"), Buffer.alloc(400));
    await fs.writeFile(path.join(dir, "unknown.xyz"), Buffer.alloc(75));
    const bd = await mediaBreakdown(ACCOUNT_ID);
    expect(bd.images).toBe(100);
    expect(bd.videos).toBe(200);
    expect(bd.audio).toBe(300);
    expect(bd.stickers).toBe(50);
    expect(bd.documents).toBe(400);
    expect(bd.other).toBe(75);
  });
});

describe("getStorageSummary", () => {
  it("returns zeroed summary when no data exists", async () => {
    // Remove the account dir created in beforeEach
    await fs.rm(path.join(tmpDir, "accounts"), { recursive: true, force: true });
    const s = await getStorageSummary();
    expect(s.db).toBe(0);
    expect(s.log).toBe(0);
    expect(s.mediaTotal).toBe(0);
    expect(s.total).toBe(0);
    expect(s.mediaBreakdown).toEqual({ images: 0, videos: 0, audio: 0, stickers: 0, documents: 0, other: 0 });
  });

  it("aggregates db + log + media across all accounts", async () => {
    // Account 1: 1000 byte db, 200 byte jpg
    const acc1Dir = path.join(tmpDir, "accounts", ACCOUNT_ID);
    await fs.writeFile(path.join(acc1Dir, "chats.db"), Buffer.alloc(1000));
    const m1 = path.join(acc1Dir, "media");
    await fs.writeFile(path.join(m1, "photo.jpg"), Buffer.alloc(200));

    // Account 2: 500 byte db, 300 byte ogg
    const acc2Id = "222222222@s.whatsapp.net";
    const acc2Dir = path.join(tmpDir, "accounts", acc2Id);
    await fs.mkdir(path.join(acc2Dir, "media"), { recursive: true });
    await fs.writeFile(path.join(acc2Dir, "chats.db"), Buffer.alloc(500));
    await fs.writeFile(path.join(acc2Dir, "media", "voice.ogg"), Buffer.alloc(300));

    // Log file: 100 bytes
    await fs.writeFile(path.join(tmpDir, "whatsapp-terminal.log"), Buffer.alloc(100));

    const s = await getStorageSummary();
    expect(s.db).toBe(1500); // 1000 + 500
    expect(s.log).toBe(100);
    expect(s.mediaBreakdown.images).toBe(200);
    expect(s.mediaBreakdown.audio).toBe(300);
    expect(s.mediaTotal).toBe(500); // 200 + 300
    expect(s.total).toBe(2100); // 1500 + 100 + 500
  });

  it("ignores pending-link directories", async () => {
    const pendingDir = path.join(tmpDir, "accounts", ".pending-12345", "media");
    await fs.mkdir(pendingDir, { recursive: true });
    await fs.writeFile(path.join(pendingDir, "creds.json"), Buffer.alloc(200));

    const s = await getStorageSummary();
    // The .pending- dir should not contribute to counts
    expect(s.mediaTotal).toBe(0);
  });
});
