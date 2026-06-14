import { getLogger } from "./logger.js";
import { getAppVersion } from "./version.js";

const REGISTRY_URL = "https://registry.npmjs.org/whatty/latest";
const TIMEOUT_MS = 4000;

/**
 * Best-effort check for a newer published whatty on npm. Resolves to the latest
 * version string when an upgrade is available, or null otherwise — already
 * current, offline, request failed/timed out, or unparseable. Deliberately
 * never throws and never blocks: the caller renders regardless of the outcome,
 * and the result is checked fresh on every launch (no on-disk cache).
 */
export async function checkForUpdate(): Promise<string | null> {
  const current = getAppVersion();
  if (current === "unknown") return null;

  try {
    const res = await fetch(REGISTRY_URL, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { version?: unknown };
    const latest = typeof body.version === "string" ? body.version : null;
    return latest && isNewer(latest, current) ? latest : null;
  } catch (err) {
    getLogger().debug({ err }, "update check failed (ignored)");
    return null;
  }
}

/**
 * Strictly-greater comparison of the `major.minor.patch` core, ignoring any
 * prerelease/build suffix. npm's `latest` dist-tag points at the newest stable
 * release, so a core-triple compare is sufficient here.
 */
function isNewer(latest: string, current: string): boolean {
  const a = core(latest);
  const b = core(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) {
    if (a[i]! !== b[i]!) return a[i]! > b[i]!;
  }
  return false;
}

/** Parse `"1.2.3-rc1"` → `[1, 2, 3]`; null when the core isn't three integers. */
function core(v: string): [number, number, number] | null {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(v.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}
