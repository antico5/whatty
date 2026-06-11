import fs from "node:fs";
import path from "node:path";
import pino from "pino";
import { dataDir } from "./persistence/paths.js";

/**
 * The TUI owns stdout/stderr — every module logs here instead, never to the
 * console. Shared by persistence and whatsapp layers (task 06 re-exports it
 * as `src/whatsapp/logger.ts`).
 *
 * Lazily created on first use (not at import time) so merely importing this
 * module — e.g. transitively through chatStore in tests — never creates
 * `data/` as a side effect; the destination path is resolved against
 * `dataDir()` on first call, respecting `WHATSAPP_TERMINAL_DATA_DIR` overrides.
 */
let instance: pino.Logger | undefined;

export function getLogger(): pino.Logger {
  if (!instance) {
    const logFile = path.join(dataDir(), "whatsapp-terminal.log");
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    instance = pino(
      { level: process.env.WHATSAPP_TERMINAL_LOG_LEVEL ?? "info" },
      pino.destination({ dest: logFile, sync: false }),
    );
  }
  return instance;
}
