import fs from "node:fs/promises";
import path from "node:path";
import { accountDbFile, accountMediaDir, accountsRootDir, logFilePath } from "./paths.js";
export { logFilePath };

export interface DiskUsage {
  db: number;
  media: number;
  total: number;
}

/**
 * Media files broken down by type, classified by file extension.
 * Extensions are derived from the MIME_TO_EXT table in mediaStore.ts:
 *   images  — jpg, png, webp (non-sticker), gif
 *   videos  — mp4, 3gp, mov
 *   audio   — ogg, opus, mp3, m4a, aac
 *   stickers — webp (extension alone can't distinguish stickers from images,
 *               so we classify by the `.webp` extension as a proxy)
 *   documents — pdf, zip, doc, docx, txt
 *   other   — anything not matched above
 *
 * Note: because stickers are saved as `.webp`, the stickers bucket and the
 * images bucket overlap on the extension level.  We classify `.webp` as
 * sticker (it's the most common WA use-case) so the totals are unambiguous.
 */
export interface MediaBreakdown {
  images: number;
  videos: number;
  audio: number;
  stickers: number;
  documents: number;
  other: number;
}

const IMAGE_EXTS = new Set(["jpg", "jpeg", "png", "gif"]);
const VIDEO_EXTS = new Set(["mp4", "3gp", "mov"]);
const AUDIO_EXTS = new Set(["ogg", "opus", "mp3", "m4a", "aac"]);
const STICKER_EXTS = new Set(["webp"]);
const DOCUMENT_EXTS = new Set(["pdf", "zip", "doc", "docx", "txt"]);

function classifyExt(fileName: string): keyof MediaBreakdown {
  const ext = path.extname(fileName).slice(1).toLowerCase();
  if (STICKER_EXTS.has(ext)) return "stickers";
  if (IMAGE_EXTS.has(ext)) return "images";
  if (VIDEO_EXTS.has(ext)) return "videos";
  if (AUDIO_EXTS.has(ext)) return "audio";
  if (DOCUMENT_EXTS.has(ext)) return "documents";
  return "other";
}

/**
 * Per-type breakdown of all files in the account's media directory.
 * `.webp` files are classified as stickers (not images).
 */
export async function mediaBreakdown(accountId: string): Promise<MediaBreakdown> {
  const dir = accountMediaDir(accountId);
  const result: MediaBreakdown = { images: 0, videos: 0, audio: 0, stickers: 0, documents: 0, other: 0 };
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return result;
  }
  await Promise.all(
    entries.map(async (entry) => {
      try {
        const stat = await fs.stat(path.join(dir, entry));
        if (stat.isFile()) {
          const bucket = classifyExt(entry);
          result[bucket] += stat.size;
        }
      } catch {
        // race: file disappeared between readdir and stat
      }
    }),
  );
  return result;
}

/** Size of the app-wide log file (0 if absent). */
export async function logSize(): Promise<number> {
  try {
    const stat = await fs.stat(logFilePath());
    return stat.size;
  } catch {
    return 0;
  }
}

/**
 * Sum of `chats.db` + its WAL sidecar files (`-wal`, `-shm`).
 * WAL files can be large between checkpoints; ignoring them under-reports.
 */
export async function dbSize(accountId: string): Promise<number> {
  const base = accountDbFile(accountId);
  let total = 0;
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      const stat = await fs.stat(base + suffix);
      total += stat.size;
    } catch {
      // file absent — not yet created or already merged
    }
  }
  return total;
}

/**
 * Sum of all file sizes in the flat `media/` directory for the given account.
 * One `readdir` is sufficient because the directory is flat.
 */
export async function mediaSize(accountId: string): Promise<number> {
  const dir = accountMediaDir(accountId);
  let total = 0;
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return 0;
  }
  await Promise.all(
    entries.map(async (entry) => {
      try {
        const stat = await fs.stat(path.join(dir, entry));
        if (stat.isFile()) total += stat.size;
      } catch {
        // race: file disappeared between readdir and stat
      }
    }),
  );
  return total;
}

/**
 * Total = db + media + the app log file (if present).
 */
export async function totalSize(accountId: string): Promise<number> {
  const [db, media, logBytes] = await Promise.all([dbSize(accountId), mediaSize(accountId), logSize()]);
  return db + media + logBytes;
}

/**
 * Compute all three sizes in one pass (avoids re-computing db/media for total).
 */
export async function getDiskUsage(accountId: string): Promise<DiskUsage> {
  const [db, media, logBytes] = await Promise.all([dbSize(accountId), mediaSize(accountId), logSize()]);
  return { db, media, total: db + media + logBytes };
}

/**
 * Full storage summary aggregated across ALL accounts, for the Storage screen
 * (which is accessible before any account is selected).
 */
export interface StorageSummary {
  db: number;
  log: number;
  mediaBreakdown: MediaBreakdown;
  mediaTotal: number;
  total: number;
}

/**
 * Enumerate all account directories and aggregate sizes.
 * Ignores directories that start with `.` (pending-link dirs).
 */
export async function getStorageSummary(): Promise<StorageSummary> {
  let accountDirs: string[] = [];
  try {
    const entries = await fs.readdir(accountsRootDir());
    accountDirs = entries.filter((e) => !e.startsWith("."));
  } catch {
    // data dir doesn't exist yet
  }

  const [logBytes, ...accountResults] = await Promise.all([
    logSize(),
    ...accountDirs.map(async (id) => ({
      db: await dbSize(id),
      breakdown: await mediaBreakdown(id),
    })),
  ]);

  let db = 0;
  const breakdown: MediaBreakdown = { images: 0, videos: 0, audio: 0, stickers: 0, documents: 0, other: 0 };
  for (const result of accountResults) {
    db += result.db;
    for (const key of Object.keys(breakdown) as (keyof MediaBreakdown)[]) {
      breakdown[key] += result.breakdown[key];
    }
  }

  const mediaTotal =
    breakdown.images + breakdown.videos + breakdown.audio + breakdown.stickers + breakdown.documents + breakdown.other;

  return {
    db,
    log: logBytes,
    mediaBreakdown: breakdown,
    mediaTotal,
    total: db + logBytes + mediaTotal,
  };
}
