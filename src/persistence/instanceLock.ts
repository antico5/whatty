import fs from "node:fs/promises";
import path from "node:path";
import { accountDir } from "./paths.js";

/**
 * Single-instance lock per account. Two app instances sharing one WhatsApp
 * session replace each other's socket in a loop (stream error
 * `conflict type="replaced"` every few seconds) and double-process the job
 * queue — so opening an account that is already open elsewhere must fail fast.
 *
 * The lock is `<accountDir>/app.lock` holding `{ pid, startedAt }`. Staleness
 * is decided by pid liveness, so a `kill -9` never needs manual cleanup: the
 * next start simply takes the lock over.
 */

export interface InstanceLock {
  release(): Promise<void>;
}

interface LockContents {
  pid: number;
  startedAt: number;
}

function lockPath(accountId: string): string {
  return path.join(accountDir(accountId), "app.lock");
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // ESRCH: no such process → stale. EPERM: exists but not ours → alive.
    return (err as { code?: string }).code !== "ESRCH";
  }
}

async function tryCreate(file: string): Promise<boolean> {
  try {
    const handle = await fs.open(file, "wx");
    try {
      await handle.writeFile(JSON.stringify({ pid: process.pid, startedAt: Date.now() } satisfies LockContents));
      await handle.sync();
    } finally {
      await handle.close();
    }
    return true;
  } catch (err) {
    if ((err as { code?: string }).code === "EEXIST") return false;
    throw err;
  }
}

export async function acquireInstanceLock(accountId: string): Promise<InstanceLock> {
  const file = lockPath(accountId);
  await fs.mkdir(path.dirname(file), { recursive: true });

  if (!(await tryCreate(file))) {
    let holder: LockContents | null = null;
    try {
      holder = JSON.parse(await fs.readFile(file, "utf8")) as LockContents;
    } catch {
      // unreadable/corrupt lock — treat as stale
    }
    if (holder && Number.isInteger(holder.pid) && pidAlive(holder.pid)) {
      throw new Error(`account is already open in another instance (pid ${holder.pid})`);
    }
    await fs.unlink(file).catch(() => undefined);
    if (!(await tryCreate(file))) {
      throw new Error("account is already open in another instance (lock contested)");
    }
  }

  return {
    async release() {
      try {
        const holder = JSON.parse(await fs.readFile(file, "utf8")) as LockContents;
        // Never remove a successor's lock (e.g. ours was taken over as stale).
        if (holder.pid === process.pid) await fs.unlink(file);
      } catch {
        // already gone or unreadable — nothing to release
      }
    },
  };
}
