import { createRequire } from "node:module";

const requireFrom = createRequire(import.meta.url);

let cached: string | undefined;

/**
 * whatty's own version, read once from the package's `package.json`. Single
 * source of truth for `--version` and the start-up update check, so neither can
 * drift from the version that was actually published. Falls back to "unknown"
 * if the manifest can't be resolved.
 */
export function getAppVersion(): string {
  if (cached === undefined) {
    try {
      cached = (requireFrom("../package.json") as { version: string }).version;
    } catch {
      cached = "unknown";
    }
  }
  return cached;
}
