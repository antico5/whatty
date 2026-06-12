import fs from "node:fs/promises";
import path from "node:path";
import { BufferJSON } from "baileys";
import { accountQueueDir } from "../persistence/paths.js";
import { getQueueLogger } from "./queueLogger.js";
import type { JobFile, JobType } from "./types.js";

/**
 * Durable filesystem job queue. A job is accepted only once its file is
 * fsynced and renamed into `pending/` — from then on a crash cannot lose it;
 * startup replays whatever is still pending.
 *
 *   <accountDir>/queue/
 *     tmp/        in-flight writes (wiped at startup — never durably accepted)
 *     pending/    <seq 16-digit>-<type>.json  event jobs, FIFO by seq
 *                 <deterministic-name>.json   derived jobs (existence = dedup)
 *     failed/     parked after exhausting attempts (inspectable, hand-replayable)
 *
 * Payloads are BufferJSON-encoded (same as auth_kv) so Baileys protobuf
 * Uint8Arrays round-trip; Longs come back as strings — `timestampToMillis`
 * tolerates that.
 */

const SEQ_PAD = 16;

export interface FsQueue {
  /** Durably accept an event job (seq-named, db lane, FIFO). Returns the accepted job. */
  enqueueEvent(type: JobType, payload: unknown): Promise<JobFile>;
  /** Durably accept a derived job; no-op if `name` is already pending. Returns false on dedup. */
  enqueueNamed(type: JobType, name: string, payload: unknown): Promise<boolean>;
  /** All pending jobs, event jobs sorted by seq. Re-reads the directory. */
  scan(): Promise<JobFile[]>;
  /** Job done — remove its file. */
  complete(job: JobFile): Promise<void>;
  /** Persist a retry: bump attempts (unless free), set notBefore. */
  reschedule(job: JobFile, opts: { consumeAttempt: boolean; notBefore: number }): Promise<void>;
  /** Park the job into failed/. */
  park(job: JobFile): Promise<void>;
  /** Wipe tmp/, ensure dirs, init seq counter. Returns counts for the startup log. */
  init(): Promise<{ pending: number; staleTmpRemoved: number; failedCount: number }>;
}

export function createFsQueue(accountId: string): FsQueue {
  const root = accountQueueDir(accountId);
  const dirs = {
    tmp: path.join(root, "tmp"),
    pending: path.join(root, "pending"),
    failed: path.join(root, "failed"),
  };
  const log = getQueueLogger().child({ module: "fs-queue" });

  let seq = 0;
  let tmpCounter = 0;
  // Enqueues are chained so pending/ visibility order always matches seq order —
  // otherwise a crash mid-write could let the db lane run seq N+1 while N was
  // still sitting in tmp/.
  let chain: Promise<unknown> = Promise.resolve();

  function chained<T>(task: () => Promise<T>): Promise<T> {
    const next = chain.then(task, task);
    chain = next.catch(() => undefined);
    return next;
  }

  function pendingPath(id: string): string {
    return path.join(dirs.pending, `${id}.json`);
  }

  /** tmp-write → fsync → rename: the job exists in pending/ fully or not at all. */
  async function writeDurably(target: string, job: JobFile): Promise<void> {
    const tmp = path.join(dirs.tmp, `${process.pid}-${++tmpCounter}.json`);
    const handle = await fs.open(tmp, "wx");
    try {
      await handle.writeFile(JSON.stringify(job, BufferJSON.replacer), "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(tmp, target);
  }

  async function parseJobFile(file: string): Promise<JobFile | null> {
    try {
      const text = await fs.readFile(path.join(dirs.pending, file), "utf8");
      return JSON.parse(text, BufferJSON.reviver) as JobFile;
    } catch (err) {
      log.error({ err, file }, "unreadable job file, leaving in place");
      return null;
    }
  }

  return {
    async init() {
      for (const dir of Object.values(dirs)) await fs.mkdir(dir, { recursive: true });

      const stale = await fs.readdir(dirs.tmp);
      for (const f of stale) await fs.unlink(path.join(dirs.tmp, f)).catch(() => undefined);

      const pending = await fs.readdir(dirs.pending);
      seq = 1 + pending.reduce((max, f) => {
        const n = Number.parseInt(f, 10);
        return Number.isFinite(n) && n > max ? n : max;
      }, 0);

      const failed = await fs.readdir(dirs.failed);
      return { pending: pending.length, staleTmpRemoved: stale.length, failedCount: failed.length };
    },

    enqueueEvent(type, payload) {
      return chained(async () => {
        const id = `${String(seq++).padStart(SEQ_PAD, "0")}-${type}`;
        const job: JobFile = { id, type, attempts: 0, createdAt: Date.now(), payload };
        await writeDurably(pendingPath(id), job);
        log.debug({ jobId: id, type, payload }, "enqueued");
        return job;
      });
    },

    enqueueNamed(type, name, payload) {
      return chained(async () => {
        const target = pendingPath(name);
        const exists = await fs.access(target).then(() => true, () => false);
        if (exists) {
          log.debug({ jobId: name, type }, "dedup-skipped");
          return false;
        }
        const job: JobFile = { id: name, type, attempts: 0, createdAt: Date.now(), payload };
        await writeDurably(target, job);
        log.debug({ jobId: name, type, payload }, "enqueued");
        return true;
      });
    },

    async scan() {
      const files = await fs.readdir(dirs.pending);
      files.sort();
      const jobs: JobFile[] = [];
      for (const file of files) {
        const job = await parseJobFile(file);
        if (job) jobs.push(job);
      }
      return jobs;
    },

    async complete(job) {
      await fs.unlink(pendingPath(job.id)).catch(() => undefined);
    },

    async reschedule(job, opts) {
      if (opts.consumeAttempt) job.attempts += 1;
      job.notBefore = opts.notBefore;
      await writeDurably(pendingPath(job.id), job);
    },

    async park(job) {
      await fs.rename(pendingPath(job.id), path.join(dirs.failed, `${job.id}.json`)).catch((err) => {
        log.error({ err, jobId: job.id }, "failed to park job");
      });
    },
  };
}
