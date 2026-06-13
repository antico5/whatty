import { createHash } from "node:crypto";
import { mkdirSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";

/** Created links this session — avoids fs syscalls on every render frame. */
const linked = new Set<string>();
let dirReady = false;

/**
 * Short, stable alias for a media file: `<tmpdir>/wt/<last 8 md5 hex of absPath><ext>`.
 * Creates the symlink lazily on first use (i.e. when the message first scrolls into
 * view); the tmp dir is volatile, so links self-heal on the next render after a reboot.
 * Falls back to the original path if the link can't be created.
 */
export function ensureTmpLink(absPath: string): string {
  const hash = createHash("md5").update(absPath).digest("hex").slice(-8);
  const linkPath = join(tmpdir(), "wt", hash + extname(absPath));
  if (linked.has(linkPath)) return linkPath;
  try {
    if (!dirReady) {
      mkdirSync(join(tmpdir(), "wt"), { recursive: true });
      dirReady = true;
    }
    symlinkSync(absPath, linkPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") return absPath;
  }
  linked.add(linkPath);
  return linkPath;
}
