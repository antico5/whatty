/**
 * Destructive storage actions — the ONLY legitimate exceptions to the
 * "never delete chat data or media" invariant.
 *
 * These functions MUST only be called from the Storage screen, behind a
 * ConfirmModal that clearly states what data will be deleted.
 *
 * Naming convention: every exported function ends with `Destructive` to make
 * accidental calls obvious at the call site.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { accountDir, accountsRootDir, logFilePath, queueLogFilePath } from "./paths.js";

/**
 * Truncate the log file to zero bytes.
 *
 * We truncate rather than unlink because pino holds an open file descriptor
 * and would not pick up a new file created at the same path. Truncation
 * immediately reclaims disk space without breaking the logger.
 */
export async function clearLogsDestructive(): Promise<void> {
  const logFile = logFilePath();
  try {
    await fs.truncate(logFile, 0);
  } catch (err) {
    // If the file doesn't exist there's nothing to clear.
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  // Also truncate the rotated .1 backup if it exists.
  try {
    await fs.truncate(`${logFile}.1`, 0);
  } catch {
    // absent — fine
  }
  // Truncate the queue processor log and its rotation.
  const queueLog = queueLogFilePath();
  for (const p of [queueLog, `${queueLog}.1`]) {
    try {
      await fs.truncate(p, 0);
    } catch {
      // absent — fine
    }
  }
}

/**
 * Delete all files inside every account's `media/` directory.
 *
 * The media directory itself is left in place (only its contents are removed).
 * Persisted MediaRef.relativePath values in the DB will dangle after this
 * operation — messages that reference deleted files will render as broken links.
 *
 * This affects ALL accounts.
 */
export async function clearAllMediaDestructive(): Promise<void> {
  let accountDirs: string[];
  try {
    const entries = await fs.readdir(accountsRootDir());
    accountDirs = entries.filter((e) => !e.startsWith("."));
  } catch {
    return; // no data dir yet
  }

  await Promise.all(
    accountDirs.map(async (id) => {
      const mediaDir = path.join(accountDir(id), "media");
      let files: string[];
      try {
        files = await fs.readdir(mediaDir);
      } catch {
        return; // media dir absent — nothing to do
      }
      await Promise.all(
        files.map(async (file) => {
          try {
            await fs.unlink(path.join(mediaDir, file));
          } catch {
            // already gone — fine
          }
        }),
      );
    }),
  );
}

/**
 * Remove ALL account directories (chats.db, media, everything) and truncate
 * the log file.
 *
 * After this operation the app is in a pristine state equivalent to a first
 * run: no linked accounts, no chat history, no media.  The account will need
 * to be re-paired before it can be used again.
 *
 * This affects ALL accounts.
 */
export async function clearAllDataDestructive(): Promise<void> {
  let accountDirs: string[];
  try {
    const entries = await fs.readdir(accountsRootDir());
    accountDirs = entries.filter((e) => !e.startsWith("."));
  } catch {
    accountDirs = [];
  }

  await Promise.all([
    ...accountDirs.map((id) =>
      fs.rm(accountDir(id), { recursive: true, force: true }),
    ),
    clearLogsDestructive(),
  ]);
}
