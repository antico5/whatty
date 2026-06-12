import type { CliRenderer } from "@opentui/core";
import { getLogger } from "./logger.js";
import { migrateDataDir } from "./persistence/migrate.js";
import { createAppStore } from "./store/appStore.js";
import { startUI } from "./ui/render.js";

const log = getLogger().child({ module: "main" });

async function main(): Promise<void> {
  let renderer: CliRenderer | null = null;
  let shuttingDown = false;

  /** Flush pending saves, stop the socket, destroy the renderer, exit — shared by Ctrl+C, SIGINT and SIGTERM. */
  async function shutdown(): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    try {
      renderer?.destroy();
    } catch (err) {
      log.error({ err }, "failed to destroy renderer during shutdown");
    }
    try {
      await store.stop();
    } catch (err) {
      log.error({ err }, "failed to stop connection during shutdown");
    }
    process.exit(0);
  }

  /**
   * Last-resort handler for uncaught errors: log to file (never to the TUI's
   * stdout/stderr — that would corrupt the alternate screen), restore the
   * terminal by destroying the renderer, then exit. Per Node's guidance we
   * don't try to keep running after an uncaught exception or rejection — the
   * process state may be corrupted — but we do make sure the user is handed
   * back a usable terminal instead of a garbled screen.
   */
  function crash(source: string, err: unknown): void {
    log.fatal({ err, source }, "unrecoverable error — restoring terminal and exiting");
    try {
      renderer?.destroy();
    } catch {
      // best effort — terminal may already be in a bad state
    }
    process.exit(1);
  }

  process.on("uncaughtException", (err) => crash("uncaughtException", err));
  process.on("unhandledRejection", (reason) => crash("unhandledRejection", reason));
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());

  // Migrate legacy ./data dir to the platform data dir before opening any DB.
  await migrateDataDir();

  const store = createAppStore({ readonly: process.argv.includes("--readonly") });
  await store.init();

  renderer = await startUI(store, () => void shutdown());
}

main().catch((err) => {
  log.error({ err }, "fatal error during startup");
  process.exit(1);
});
