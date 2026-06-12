/**
 * Durable job-queue contracts. Every Baileys event becomes a job file on disk
 * before any logic runs; handlers are idempotent so a job may execute more
 * than once (crash replay, duplicate enqueue) and converge to the same state.
 */

/** Event jobs — one per Baileys event, processed FIFO by seq on the db lane. */
export type EventJobType =
  | "process-messages"
  | "process-history"
  | "process-message-update"
  | "process-receipts"
  | "process-reaction"
  | "process-contacts"
  | "process-chats"
  | "process-groups"
  | "own-identity";

/** Derived jobs — enqueued by handlers (or startup), deterministic names dedup them. */
export type DerivedJobType =
  | "download-media"
  | "apply-encrypted-edit"
  | "refresh-group-metadata"
  | "sweep-unlinked-media";

export type JobType = EventJobType | DerivedJobType;

/** Media-lane jobs are network-bound and run concurrently; everything else is db-lane. */
export const MEDIA_LANE_TYPES: ReadonlySet<JobType> = new Set(["download-media", "sweep-unlinked-media"]);

export interface JobFile {
  /** Filename stem; `<seq>-<type>` for event jobs, deterministic for derived jobs. */
  id: string;
  type: JobType;
  /** Real failures so far (RetryLater does not count). */
  attempts: number;
  /** Epoch ms; the lane skips the job until then. */
  notBefore?: number;
  createdAt: number;
  payload: unknown;
}

/** What a handler touched, in data terms — the UI decides what that means. */
export type DataChange =
  | { table: "chats"; jid: string }
  | { table: "messages"; jid: string; messageId: string }
  | { table: "accounts"; jids: string[] };

export interface ChildJob {
  type: DerivedJobType;
  /** Deterministic name (without .json) — enqueue no-ops if it already exists. */
  name: string;
  payload: unknown;
}

export interface JobResult {
  changes: DataChange[];
  children?: ChildJob[];
}

export interface JobHandlerContext {
  conn: import("../whatsapp/connection.js").Connection;
  log: import("pino").Logger;
}

/**
 * Must be idempotent: a job may run more than once (crash replay, duplicate
 * enqueue) and must converge to the same state. Throw `RetryLater` when the
 * world isn't ready (no socket); any other throw consumes an attempt.
 */
export type JobHandler = (payload: unknown, ctx: JobHandlerContext) => Promise<JobResult>;

/**
 * Thrown by handlers when the world isn't ready (no socket, offline): the job
 * is rescheduled without consuming an attempt.
 */
export class RetryLater extends Error {
  readonly delayMs: number;

  constructor(reason: string, delayMs = 30_000) {
    super(reason);
    this.name = "RetryLater";
    this.delayMs = delayMs;
  }
}

/** Network-shaped errors also reschedule for free — the link is down, not the job broken. */
const NETWORK_ERROR_CODES = new Set(["ENOTFOUND", "ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "EAI_AGAIN", "EPIPE"]);

export function isRetryLater(err: unknown): boolean {
  if (err instanceof RetryLater) return true;
  if (err && typeof err === "object") {
    const code = (err as { code?: unknown; cause?: { code?: unknown } }).code;
    const causeCode = (err as { cause?: { code?: unknown } }).cause?.code;
    if (typeof code === "string" && NETWORK_ERROR_CODES.has(code)) return true;
    if (typeof causeCode === "string" && NETWORK_ERROR_CODES.has(causeCode)) return true;
    const message = (err as { message?: unknown }).message;
    if (typeof message === "string" && /fetch failed|network|socket hang up/i.test(message)) return true;
  }
  return false;
}
