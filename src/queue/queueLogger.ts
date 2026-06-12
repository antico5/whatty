import fs from "node:fs";
import path from "node:path";
import pino from "pino";
import { queueLogFilePath } from "../persistence/paths.js";

/**
 * Dedicated log for the durable job queue: every job lifecycle transition is
 * logged here *including payloads*, so a lost message can always be traced to
 * the exact bytes the queue accepted. Kept separate from the operational log
 * (`whatsapp-terminal.log`) because payload logging is high-volume.
 *
 * Unlike the startup-only rotation in `src/logger.ts`, this log rotates
 * mid-session: history-sync bursts can write hundreds of MB in one run, so
 * `maybeRotateQueueLog()` is called (throttled) from the processor on job
 * completion. One `.1` generation is kept.
 */
let instance: pino.Logger | undefined;
let destination: pino.DestinationStream | undefined;
let lastRotateCheck = 0;

const LOG_MAX_BYTES = 100 * 1024 * 1024;
const ROTATE_CHECK_INTERVAL_MS = 30_000;

export function getQueueLogger(): pino.Logger {
  if (!instance) {
    const logFile = queueLogFilePath();
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    rotateIfOversized(logFile);
    destination = pino.destination({ dest: logFile, sync: false });
    instance = pino({ level: "debug" }, destination);
  }
  return instance;
}

function rotateIfOversized(logFile: string): boolean {
  try {
    const stat = fs.statSync(logFile);
    if (stat.size <= LOG_MAX_BYTES) return false;
    fs.renameSync(logFile, `${logFile}.1`);
    return true;
  } catch {
    // missing file (first run) — nothing to rotate
    return false;
  }
}

/** Throttled size check; rotates under the live writer via SonicBoom reopen(). */
export function maybeRotateQueueLog(): void {
  if (!destination) return;
  const now = Date.now();
  if (now - lastRotateCheck < ROTATE_CHECK_INTERVAL_MS) return;
  lastRotateCheck = now;
  if (rotateIfOversized(queueLogFilePath())) {
    (destination as unknown as { reopen?: () => void }).reopen?.();
  }
}
