import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { MediaRef } from "../types/index.js";
import { mediaDir } from "./paths.js";

const MIME_TO_EXT: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
  "video/mp4": "mp4",
  "video/3gpp": "3gp",
  "video/quicktime": "mov",
  "audio/ogg": "ogg",
  "audio/opus": "opus",
  "audio/mpeg": "mp3",
  "audio/mp4": "m4a",
  "audio/aac": "aac",
  "application/pdf": "pdf",
  "application/zip": "zip",
  "application/msword": "doc",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "text/plain": "txt",
};

export function mimeToExt(mime: string): string | null {
  const base = mime.split(";")[0]?.trim().toLowerCase() ?? "";
  return MIME_TO_EXT[base] ?? null;
}

/** Strip anything that isn't safe in a filename across the chars WA ids may contain. */
export function sanitizeForFilename(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function extFromFileName(fileName: string): string | null {
  const ext = path.extname(fileName).slice(1).toLowerCase();
  return ext.length > 0 ? ext : null;
}

/**
 * Format a millisecond-epoch timestamp as `yyyy_MM_dd_HH_mm_ss_SSS` in the
 * local timezone — human-browsable and sortable by filename.
 */
export function formatMediaTimestamp(timestampMs: number): string {
  const d = new Date(timestampMs);
  const pad2 = (n: number) => String(n).padStart(2, "0");
  const pad3 = (n: number) => String(n).padStart(3, "0");
  const yyyy = String(d.getFullYear());
  const MM = pad2(d.getMonth() + 1);
  const dd = pad2(d.getDate());
  const HH = pad2(d.getHours());
  const mm = pad2(d.getMinutes());
  const ss = pad2(d.getSeconds());
  const SSS = pad3(d.getMilliseconds());
  return `${yyyy}_${MM}_${dd}_${HH}_${mm}_${ss}_${SSS}`;
}

/**
 * Derive a short, deterministic uniqueness tail from a message id so that two
 * messages sharing the same millisecond (or history-sync second-resolution
 * timestamps with ms=000) produce distinct filenames without sacrificing
 * idempotency across re-syncs.
 *
 * The tail is the last 8 characters of the sanitized message id, which is
 * sufficient to distinguish messages that share a timestamp in practice.
 */
export function messageIdSuffix(messageId: string): string {
  const sanitized = sanitizeForFilename(messageId);
  return sanitized.slice(-8);
}

export interface SaveMediaOptions {
  data: Buffer;
  messageId: string;
  /** Millisecond-epoch timestamp of the message (from WAMessage.messageTimestamp). */
  timestamp: number;
  mimeType?: string;
  fileName?: string;
}

/**
 * Persist media bytes under the account's flat media directory.
 *
 * Filenames are `yyyy_MM_dd_HH_mm_ss_SSS__<id-suffix>.<ext>` (local timezone,
 * message timestamp). The id-suffix — the last 8 chars of the sanitized
 * message id — provides deterministic collision avoidance: two messages that
 * share the same millisecond still produce different names, and the name is
 * stable across re-syncs so the same-name + same-size idempotency check can
 * skip unnecessary rewrites.
 *
 * Old files saved under the previous `<jid>__<messageId>.<ext>` scheme are
 * left untouched; their `MediaRef.relativePath` values stored in the DB
 * continue to resolve correctly.
 */
export async function saveMedia(jid: string, opts: SaveMediaOptions): Promise<MediaRef> {
  const dir = mediaDir();
  await fs.mkdir(dir, { recursive: true });

  const ext =
    (opts.mimeType ? mimeToExt(opts.mimeType) : null) ??
    (opts.fileName ? extFromFileName(opts.fileName) : null);
  const tsFormatted = formatMediaTimestamp(opts.timestamp);
  const idSuffix = messageIdSuffix(opts.messageId);
  const baseName = `${tsFormatted}__${idSuffix}`;
  const fileName = ext ? `${baseName}.${ext}` : baseName;
  const target = path.join(dir, fileName);

  const existing = await fs.stat(target).catch(() => null);
  if (!existing || existing.size !== opts.data.length) {
    const tmp = `${target}.tmp-${process.pid}-${Date.now()}`;
    await fs.writeFile(tmp, opts.data);
    await fs.rename(tmp, target);
  }

  return {
    relativePath: path.posix.join("media", fileName),
    mimeType: opts.mimeType ?? null,
    fileName: opts.fileName ?? null,
  };
}

export function absoluteMediaPath(ref: MediaRef): string {
  return path.join(mediaDir(), ...ref.relativePath.split("/").slice(1));
}

export function fileUrl(absPath: string): string {
  return pathToFileURL(absPath).href;
}
