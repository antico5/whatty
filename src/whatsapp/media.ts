import {
  downloadMediaMessage,
  getContentType,
  normalizeMessageContent,
  type WAMessage,
  type WAMessageContent,
} from "baileys";
import type { Connection } from "./connection.js";
import { getLogger } from "./logger.js";
import { MEDIA_CONTENT_KEYS } from "./mappers.js";

type MediaInner = { mimetype?: string | null; fileName?: string | null };

function mediaInner(content: WAMessageContent | undefined): MediaInner | null {
  const key = getContentType(content);
  if (!key || !MEDIA_CONTENT_KEYS.has(key)) return null;
  const inner = (content as unknown as Record<string, MediaInner | undefined>)[key];
  return inner ?? null;
}

export interface MediaPayload {
  data: Buffer;
  mimeType?: string;
  fileName?: string;
}

/**
 * Single download attempt (including view-once content, which
 * `normalizeMessageContent` unwraps for us) — throws on failure; retry policy
 * belongs to the job queue, not here. Returns `null` only when the message
 * carries no downloadable media (so the caller can complete idempotently).
 */
export async function downloadMediaPayload(
  sock: NonNullable<ReturnType<Connection["getSocket"]>>,
  waMsg: WAMessage,
): Promise<MediaPayload | null> {
  const inner = mediaInner(normalizeMessageContent(waMsg.message));
  if (!inner) return null;
  const buffer = await downloadMediaMessage(
    waMsg,
    "buffer",
    {},
    { logger: getLogger().child({ module: "baileys-media" }), reuploadRequest: sock.updateMediaMessage },
  );
  return {
    data: buffer,
    mimeType: inner.mimetype ?? undefined,
    fileName: inner.fileName ?? undefined,
  };
}
