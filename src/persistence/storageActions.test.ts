import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clearAllDataDestructive, clearAllMediaDestructive, clearLogsDestructive } from "./storageActions.js";

let tmpDir: string;
let originalDataDir: string | undefined;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "whatsapp-terminal-storage-actions-"));
  originalDataDir = process.env.WHATSAPP_TERMINAL_DATA_DIR;
  process.env.WHATSAPP_TERMINAL_DATA_DIR = tmpDir;
});

afterEach(async () => {
  if (originalDataDir === undefined) delete process.env.WHATSAPP_TERMINAL_DATA_DIR;
  else process.env.WHATSAPP_TERMINAL_DATA_DIR = originalDataDir;
  await fs.rm(tmpDir, { recursive: true, force: true });
});

/** Create a fake account directory with an optional DB file and media files. */
async function setupAccount(
  accountId: string,
  opts: { dbBytes?: number; mediaFiles?: Record<string, number> } = {},
): Promise<{ accountDir: string; mediaDir: string }> {
  const accountDir = path.join(tmpDir, "accounts", accountId);
  const mediaDir = path.join(accountDir, "media");
  await fs.mkdir(mediaDir, { recursive: true });

  if (opts.dbBytes !== undefined) {
    await fs.writeFile(path.join(accountDir, "chats.db"), Buffer.alloc(opts.dbBytes));
  }
  if (opts.mediaFiles) {
    for (const [name, size] of Object.entries(opts.mediaFiles)) {
      await fs.writeFile(path.join(mediaDir, name), Buffer.alloc(size));
    }
  }
  return { accountDir, mediaDir };
}

/** Create the app log file with the given content (or byte count). */
async function setupLogFile(content: string | number): Promise<string> {
  const logFile = path.join(tmpDir, "whatsapp-terminal.log");
  await fs.writeFile(logFile, typeof content === "string" ? content : Buffer.alloc(content));
  return logFile;
}

describe("clearLogsDestructive", () => {
  it("truncates the log file to zero bytes", async () => {
    const logFile = await setupLogFile("hello log\n".repeat(100));
    expect((await fs.stat(logFile)).size).toBeGreaterThan(0);

    await clearLogsDestructive();

    expect((await fs.stat(logFile)).size).toBe(0);
  });

  it("also truncates the .1 rotated backup when present", async () => {
    const logFile = await setupLogFile("main log");
    const backup = `${logFile}.1`;
    await fs.writeFile(backup, "backup log");

    await clearLogsDestructive();

    expect((await fs.stat(logFile)).size).toBe(0);
    expect((await fs.stat(backup)).size).toBe(0);
  });

  it("does not throw when the log file does not exist", async () => {
    // No log file created — should complete without error.
    await expect(clearLogsDestructive()).resolves.toBeUndefined();
  });
});

describe("clearAllMediaDestructive", () => {
  it("removes all files from every account's media directory", async () => {
    const { mediaDir: m1 } = await setupAccount("acc1@s.whatsapp.net", {
      mediaFiles: { "photo.jpg": 500, "video.mp4": 1000 },
    });
    const { mediaDir: m2 } = await setupAccount("acc2@s.whatsapp.net", {
      mediaFiles: { "audio.ogg": 300 },
    });

    await clearAllMediaDestructive();

    expect(await fs.readdir(m1)).toHaveLength(0);
    expect(await fs.readdir(m2)).toHaveLength(0);
  });

  it("leaves the media directory itself in place after clearing", async () => {
    const { mediaDir } = await setupAccount("acc1@s.whatsapp.net", {
      mediaFiles: { "img.png": 200 },
    });

    await clearAllMediaDestructive();

    await expect(fs.stat(mediaDir)).resolves.toBeTruthy();
  });

  it("does not touch the DB file", async () => {
    const { accountDir } = await setupAccount("acc1@s.whatsapp.net", {
      dbBytes: 1024,
      mediaFiles: { "img.png": 200 },
    });
    const dbFile = path.join(accountDir, "chats.db");

    await clearAllMediaDestructive();

    expect((await fs.stat(dbFile)).size).toBe(1024);
  });

  it("does not throw when no accounts exist", async () => {
    await expect(clearAllMediaDestructive()).resolves.toBeUndefined();
  });

  it("ignores pending-link directories (starting with '.')", async () => {
    // Create a .pending- dir that should be skipped
    const pendingDir = path.join(tmpDir, "accounts", ".pending-12345", "media");
    await fs.mkdir(pendingDir, { recursive: true });
    await fs.writeFile(path.join(pendingDir, "creds.json"), "{}");

    await clearAllMediaDestructive();

    // Pending dir's media subdir is NOT touched
    const files = await fs.readdir(pendingDir);
    expect(files).toContain("creds.json");
  });
});

describe("clearAllDataDestructive", () => {
  it("removes all account directories", async () => {
    const { accountDir: dir1 } = await setupAccount("acc1@s.whatsapp.net", { dbBytes: 512 });
    const { accountDir: dir2 } = await setupAccount("acc2@s.whatsapp.net", { dbBytes: 256 });

    await clearAllDataDestructive();

    await expect(fs.stat(dir1)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.stat(dir2)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("truncates the log file", async () => {
    const logFile = await setupLogFile("lots of log data\n".repeat(50));
    await setupAccount("acc1@s.whatsapp.net", { dbBytes: 128 });

    await clearAllDataDestructive();

    // Log file still exists (truncated, not unlinked)
    expect((await fs.stat(logFile)).size).toBe(0);
  });

  it("does not throw when no accounts or log file exist", async () => {
    await expect(clearAllDataDestructive()).resolves.toBeUndefined();
  });

  it("ignores pending-link directories", async () => {
    const pendingDir = path.join(tmpDir, "accounts", ".pending-99999");
    await fs.mkdir(pendingDir, { recursive: true });
    await fs.writeFile(path.join(pendingDir, "creds.json"), "{}");

    await clearAllDataDestructive();

    // pending dir is NOT removed
    await expect(fs.stat(pendingDir)).resolves.toBeTruthy();
  });
});
