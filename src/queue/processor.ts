import { EventEmitter } from "node:events";
import type { Connection } from "../whatsapp/connection.js";
import type { FsQueue } from "./fsQueue.js";
import { getQueueLogger, maybeRotateQueueLog } from "./queueLogger.js";
import {
  isRetryLater,
  MEDIA_LANE_TYPES,
  RetryLater,
  type DataChange,
  type JobFile,
  type JobHandler,
  type JobType,
} from "./types.js";

/**
 * Executes the durable job queue. Two lanes:
 *
 * - **db lane** — one job at a time. Event jobs (`<seq>-*`) run strictly FIFO:
 *   a not-yet-due event job blocks the ones behind it (ordering is the
 *   guarantee), bounded by the fast park policy below. Derived db jobs
 *   (enc-edit, refresh-group) are skipped while `notBefore` is in the future
 *   and never block the lane — their ops are guarded/convergent.
 * - **media lane** — network-bound downloads, small concurrency, fully paused
 *   while the connection is not open.
 *
 * Retry classes (see plan): event jobs fail only on local/deterministic causes
 * → 3 quick attempts (1s/5s/15s) then park; socket-dependent jobs get free
 * `RetryLater` rescheduling while offline and park only after real failures.
 */

const MEDIA_CONCURRENCY = 2;
const RESCAN_INTERVAL_MS = 10_000;

const EVENT_BACKOFF_MS = [1_000, 5_000, 15_000];
const DERIVED_BACKOFF_BASE_MS = 5_000;
const DERIVED_BACKOFF_CAP_MS = 15 * 60_000;

const MAX_ATTEMPTS: Record<string, number> = {
  "download-media": 6,
  "sweep-unlinked-media": 6,
  "apply-encrypted-edit": 10,
  "refresh-group-metadata": 10,
};
const MAX_EVENT_ATTEMPTS = EVENT_BACKOFF_MS.length;

/** Event jobs carry their queue sequence in the filename; derived jobs don't. */
function isEventJob(job: JobFile): boolean {
  return /^\d/.test(job.id);
}

function backoffFor(job: JobFile): number {
  if (isEventJob(job)) return EVENT_BACKOFF_MS[Math.min(job.attempts, EVENT_BACKOFF_MS.length - 1)]!;
  return Math.min(DERIVED_BACKOFF_BASE_MS * 2 ** job.attempts, DERIVED_BACKOFF_CAP_MS);
}

function maxAttemptsFor(job: JobFile): number {
  return isEventJob(job) ? MAX_EVENT_ATTEMPTS : (MAX_ATTEMPTS[job.type] ?? MAX_EVENT_ATTEMPTS);
}

export interface Processor extends EventEmitter {
  on(event: "data-changed", listener: (changes: DataChange[]) => void): this;
  emit(event: "data-changed", changes: DataChange[]): boolean;
}

export interface ProcessorApi extends Processor {
  start(): Promise<void>;
  /** Stops picking up new jobs and awaits the in-flight ones — pending work stays on disk. */
  stop(): Promise<void>;
  enqueueEvent(type: JobType, payload: unknown): Promise<void>;
  enqueueNamed(type: JobType, name: string, payload: unknown): Promise<void>;
}

export function createProcessor(
  queue: FsQueue,
  conn: Connection,
  handlers: Partial<Record<JobType, JobHandler>>,
): ProcessorApi {
  const log = getQueueLogger().child({ module: "processor" });
  const emitter = new EventEmitter() as ProcessorApi;

  // In-memory mirror of pending/ — authoritative between rescans for jobs
  // enqueued through this process; the periodic rescan picks up hand-dropped
  // files and anything this view lost track of.
  const jobs = new Map<string, JobFile>();
  const inFlight = new Set<string>();

  let running = false;
  let connOpen = false;
  const sleepers = new Set<() => void>();
  let rescanTimer: ReturnType<typeof setInterval> | null = null;
  const laneDone: Promise<void>[] = [];

  function wake(): void {
    const pending = [...sleepers];
    sleepers.clear();
    for (const resolve of pending) resolve();
  }

  function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const wakeup = () => {
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        sleepers.delete(wakeup);
        resolve();
      }, ms);
      sleepers.add(wakeup);
    });
  }

  async function rescan(): Promise<void> {
    try {
      const found = await queue.scan();
      let added = 0;
      for (const job of found) {
        if (!jobs.has(job.id) && !inFlight.has(job.id)) {
          jobs.set(job.id, job);
          added++;
        }
      }
      if (added > 0) wake();
    } catch (err) {
      log.error({ err }, "pending rescan failed");
    }
  }

  /** Next due db-lane job: event jobs strictly in seq order, derived jobs when due. */
  function nextDbJob(now: number): { job: JobFile | null; soonest: number | null } {
    const sorted = [...jobs.values()]
      .filter((j) => !MEDIA_LANE_TYPES.has(j.type) && !inFlight.has(j.id))
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    let soonest: number | null = null;
    let eventBlocked = false;
    for (const job of sorted) {
      const due = (job.notBefore ?? 0) <= now;
      if (isEventJob(job)) {
        if (eventBlocked) continue;
        if (due) return { job, soonest };
        eventBlocked = true; // FIFO: never run a later event job before this one
        soonest = soonest === null ? job.notBefore! : Math.min(soonest, job.notBefore!);
      } else if (due) {
        return { job, soonest };
      } else {
        soonest = soonest === null ? job.notBefore! : Math.min(soonest, job.notBefore!);
      }
    }
    return { job: null, soonest };
  }

  function nextMediaJob(now: number): { job: JobFile | null; soonest: number | null } {
    let soonest: number | null = null;
    for (const job of jobs.values()) {
      if (!MEDIA_LANE_TYPES.has(job.type) || inFlight.has(job.id)) continue;
      if ((job.notBefore ?? 0) <= now) return { job, soonest };
      soonest = soonest === null ? job.notBefore! : Math.min(soonest, job.notBefore!);
    }
    return { job: null, soonest };
  }

  async function execute(job: JobFile): Promise<void> {
    const handler = handlers[job.type];
    const jobLog = log.child({ jobId: job.id, type: job.type, attempts: job.attempts });

    if (!handler) {
      jobLog.error("no handler for job type — parking");
      await queue.park(job);
      jobs.delete(job.id);
      return;
    }

    jobLog.debug("started");
    const startedAt = Date.now();
    try {
      const result = await handler(job.payload, { conn, log: jobLog });
      // Children land durably before the parent file is deleted (at-least-once).
      for (const child of result.children ?? []) {
        await queue.enqueueNamed(child.type, child.name, child.payload);
        const childJob: JobFile = {
          id: child.name,
          type: child.type,
          attempts: 0,
          createdAt: Date.now(),
          payload: child.payload,
        };
        if (!jobs.has(child.name)) jobs.set(child.name, childJob);
      }
      await queue.complete(job);
      jobs.delete(job.id);
      jobLog.debug(
        { durationMs: Date.now() - startedAt, changes: result.changes.length, children: result.children?.length ?? 0 },
        "completed",
      );
      if (result.changes.length > 0) emitter.emit("data-changed", result.changes);
    } catch (err) {
      if (isRetryLater(err)) {
        const delayMs = err instanceof RetryLater ? err.delayMs : 30_000;
        const notBefore = Date.now() + delayMs;
        await queue.reschedule(job, { consumeAttempt: false, notBefore });
        job.notBefore = notBefore;
        jobLog.debug({ err: String(err), notBefore }, "retry-later (attempt not consumed)");
      } else if (job.attempts + 1 >= maxAttemptsFor(job)) {
        jobLog.error({ err, payload: job.payload }, "parked after exhausting attempts");
        await queue.park(job);
        jobs.delete(job.id);
      } else {
        const notBefore = Date.now() + backoffFor(job);
        await queue.reschedule(job, { consumeAttempt: true, notBefore });
        job.attempts += 1;
        job.notBefore = notBefore;
        jobLog.warn({ err, nextNotBefore: notBefore, attempts: job.attempts }, "failed, will retry");
      }
    } finally {
      maybeRotateQueueLog();
    }
  }

  async function runLane(pick: (now: number) => { job: JobFile | null; soonest: number | null }): Promise<void> {
    while (running) {
      const { job, soonest } = pick(Date.now());
      if (!job) {
        const waitMs = soonest === null ? RESCAN_INTERVAL_MS : Math.max(50, soonest - Date.now());
        await sleep(Math.min(waitMs, RESCAN_INTERVAL_MS));
        continue;
      }
      inFlight.add(job.id);
      try {
        await execute(job);
      } finally {
        inFlight.delete(job.id);
      }
    }
  }

  /** Media lane additionally pauses while the connection is down — downloads can't succeed. */
  function pickMedia(now: number): { job: JobFile | null; soonest: number | null } {
    if (!connOpen) return { job: null, soonest: null };
    return nextMediaJob(now);
  }

  conn.on("status", (status: string) => {
    connOpen = status === "open";
    if (connOpen) wake();
  });

  emitter.start = async () => {
    const summary = await queue.init();
    log.info(summary, "queue scan");
    await rescan();
    running = true;
    laneDone.push(runLane(nextDbJob));
    for (let i = 0; i < MEDIA_CONCURRENCY; i++) laneDone.push(runLane(pickMedia));
    rescanTimer = setInterval(() => void rescan(), RESCAN_INTERVAL_MS);
  };

  emitter.stop = async () => {
    running = false;
    if (rescanTimer) clearInterval(rescanTimer);
    rescanTimer = null;
    wake();
    await Promise.allSettled(laneDone);
  };

  emitter.enqueueEvent = async (type, payload) => {
    const job = await queue.enqueueEvent(type, payload);
    jobs.set(job.id, job);
    wake();
  };

  emitter.enqueueNamed = async (type, name, payload) => {
    const accepted = await queue.enqueueNamed(type, name, payload);
    if (accepted && !jobs.has(name)) {
      jobs.set(name, { id: name, type, attempts: 0, createdAt: Date.now(), payload });
      wake();
    }
  };

  return emitter;
}
