import {
  delay,
  downloadMediaMessage,
  getContentType,
  normalizeMessageContent,
  type WAMessage,
  type WAMessageContent,
} from "baileys";
import type { MediaRef } from "../types/index.js";
import { saveMedia } from "../persistence/mediaStore.js";
import type { Connection } from "./connection.js";
import { getLogger } from "./logger.js";
import { MEDIA_CONTENT_KEYS, timestampToMillis } from "./mappers.js";

const MAX_ATTEMPTS = 3;
const RETRY_DELAY_MS = 500;

type MediaInner = { mimetype?: string | null; fileName?: string | null };

function mediaInner(content: WAMessageContent | undefined): MediaInner | null {
  const key = getContentType(content);
  if (!key || !MEDIA_CONTENT_KEYS.has(key)) return null;
  const inner = (content as unknown as Record<string, MediaInner | undefined>)[key];
  return inner ?? null;
}

/**
 * Eagerly download and persist any media attached to `waMsg` (including
 * view-once content, which `normalizeMessageContent` unwraps for us).
 * Returns `null` for non-media messages or on unrecoverable failure — never
 * throws, since this runs off the event loop and one bad message must not
 * take down ingestion.
 */
export async function downloadAndStore(conn: Connection, waMsg: WAMessage, jid: string): Promise<MediaRef | null> {
  const inner = mediaInner(normalizeMessageContent(waMsg.message));
  if (!inner) return null;

  const sock = conn.getSocket();
  if (!sock) return null;

  const messageId = waMsg.key.id;
  if (!messageId) return null;

  const log = getLogger().child({ module: "media" });

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const buffer = await downloadMediaMessage(
        waMsg,
        "buffer",
        {},
        { logger: getLogger().child({ module: "baileys-media" }), reuploadRequest: sock.updateMediaMessage },
      );
      return await saveMedia(jid, {
        data: buffer,
        messageId,
        timestamp: timestampToMillis(waMsg.messageTimestamp) || Date.now(),
        mimeType: inner.mimetype ?? undefined,
        fileName: inner.fileName ?? undefined,
      });
    } catch (err) {
      if (attempt === MAX_ATTEMPTS) {
        log.error({ err, jid, messageId, attempt }, "giving up on media download");
        return null;
      }
      log.warn({ err, jid, messageId, attempt }, "media download attempt failed, retrying");
      await delay(RETRY_DELAY_MS * attempt);
    }
  }

  return null;
}
