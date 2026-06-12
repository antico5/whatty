import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { defaultDataDir } from "./paths.js";

/** Path of the legacy data directory relative to the cwd (the repo checkout). */
export const LEGACY_DATA_DIR_NAME = "data";

/**
 * Recursively copies `src` into `dest` (created if needed), then verifies
 * every file's size matches, then removes `src`.  Throws on any mismatch so
 * the caller can bail out without removing anything.
 */
async function copyAndVerify(src: string, dest: string): Promise<void> {
  await fsp.mkdir(dest, { recursive: true });
  const entries = await fsp.readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      await copyAndVerify(srcPath, destPath);
    } else {
      await fsp.copyFile(srcPath, destPath);
      const [srcStat, destStat] = await Promise.all([fsp.stat(srcPath), fsp.stat(destPath)]);
      if (srcStat.size !== destStat.size) {
        throw new Error(`size mismatch after copy: ${srcPath} (${srcStat.size}) vs ${destPath} (${destStat.size})`);
      }
    }
  }
  // Remove after all files are copied and verified
  await fsp.rm(src, { recursive: true, force: true });
}

/**
 * Attempts a cross-device rename via `fs.renameSync`; if the OS returns
 * EXDEV (different filesystems) falls back to recursive copy + verify + rm.
 */
async function moveDir(src: string, dest: string): Promise<void> {
  try {
    fs.renameSync(src, dest);
  } catch (err: unknown) {
    const nodeErr = err as NodeJS.ErrnoException;
    if (nodeErr.code === "EXDEV") {
      await copyAndVerify(src, dest);
    } else {
      throw err;
    }
  }
}

/**
 * One-shot startup migration: if the legacy `./data` directory (relative to
 * the current working directory) exists, move it to `defaultDataDir()`.
 *
 * Rules:
 * - Skipped entirely when `WHATSAPP_TERMINAL_DATA_DIR` is set (user override).
 * - Old dir exists, new dir does not → move (rename or cross-fs copy+verify+rm).
 * - Both exist → print which dir is being used and how to resolve; do NOT merge
 *   or delete either side (chat data is sacred).
 * - Neither exists → nothing to do.
 *
 * Must be called before any SQLite DB is opened.
 *
 * @param cwd  Directory to resolve `./data` from (defaults to `process.cwd()`).
 *             Exposed as a parameter for testing.
 */
export async function migrateDataDir(cwd?: string): Promise<void> {
  // Skip when env override is active — user knows exactly where their data is.
  if (process.env.WHATSAPP_TERMINAL_DATA_DIR) return;

  const legacyDir = path.resolve(cwd ?? process.cwd(), LEGACY_DATA_DIR_NAME);
  const newDir = defaultDataDir();

  // If they resolve to the same path there's nothing to do.
  if (legacyDir === newDir) return;

  const legacyExists = await fsp.stat(legacyDir).then(() => true).catch(() => false);
  const newExists = await fsp.stat(newDir).then(() => true).catch(() => false);

  if (!legacyExists) {
    // Nothing to migrate; new dir will be created on first use.
    return;
  }

  if (legacyExists && !newExists) {
    // Happy path: move the old dir to the new location.
    await fsp.mkdir(path.dirname(newDir), { recursive: true });
    await moveDir(legacyDir, newDir);
    console.log(`[whatsapp-terminal] Data directory migrated: ${legacyDir} → ${newDir}`);
    return;
  }

  // Both exist — do not merge automatically; inform the user.
  console.warn(
    `[whatsapp-terminal] Two data directories found:\n` +
    `  Old (legacy): ${legacyDir}\n` +
    `  New (active): ${newDir}\n` +
    `Using the new location. To resolve:\n` +
    `  • If the old dir is a stale leftover, remove it:  rm -rf "${legacyDir}"\n` +
    `  • If you want to keep the old data, merge manually:\n` +
    `      cp -r "${legacyDir}/." "${newDir}/" && rm -rf "${legacyDir}"`,
  );
}
