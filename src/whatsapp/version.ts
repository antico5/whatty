import { createRequire } from "node:module";

const requireFrom = createRequire(import.meta.url);

let cached: string | undefined;

/**
 * Version of the installed `baileys` package, read once from its `package.json`.
 * Surfaced in the UI so it's obvious which protocol library the app actually
 * picked up after the auto-update that runs on start. Falls back to "unknown"
 * if the package can't be resolved.
 */
export function getBaileysVersion(): string {
  if (cached === undefined) {
    try {
      cached = (requireFrom("baileys/package.json") as { version: string }).version;
    } catch {
      cached = "unknown";
    }
  }
  return cached;
}
