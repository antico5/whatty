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

export interface SaveMediaOptions {
  data: Buffer;
  messageId: string;
  mimeType?: string;
  fileName?: string;
}

/**
 * Persist media bytes under the account's flat media directory. The filename
 * embeds both the chat jid and the message id: message ids are only unique
 * per sender, so a flat directory needs the jid prefix to avoid cross-chat
 * collisions. Idempotent: if a same-named, same-sized file already exists we
 * skip the rewrite — eager downloads can otherwise re-fetch the same media on
 * resync.
 */
export async function saveMedia(jid: string, opts: SaveMediaOptions): Promise<MediaRef> {
  const dir = mediaDir();
  await fs.mkdir(dir, { recursive: true });

  const ext =
    (opts.mimeType ? mimeToExt(opts.mimeType) : null) ??
    (opts.fileName ? extFromFileName(opts.fileName) : null);
  const baseName = `${sanitizeForFilename(jid)}__${sanitizeForFilename(opts.messageId)}`;
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
