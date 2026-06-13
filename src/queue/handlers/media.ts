import { chatOps } from "../../persistence/chatStore.js";
import { getActiveDb } from "../../persistence/db.js";
import { saveMedia } from "../../persistence/mediaStore.js";
import { downloadMediaPayload } from "../../whatsapp/media.js";
import { rawWAMessage } from "../../whatsapp/mappers.js";
import { withTimeout } from "../../util/withTimeout.js";
import { RetryLater, type ChildJob, type JobHandler } from "../types.js";
import { hasMediaContent, MEDIA_AUTODOWNLOAD_MAX_AGE_MS, mediaJobName } from "./shared.js";

const DOWNLOAD_TIMEOUT_MS = 60_000;

export interface DownloadMediaPayload {
  jid: string;
  messageId: string;
  timestampMs: number;
  /**
   * Bypass the 7-day age gate. Set when the download is explicitly requested
   * (e.g. the user scrolled the message into view) rather than the eager
   * auto-download path — those requests fetch regardless of age.
   */
  force?: boolean;
}

/**
 * `download-media` — fetch one message's media and link it. The WAMessage is
 * read back from the `raw` column rather than embedded in the job: the parent
 * job committed the row before this child was durably enqueued, and the DB is
 * the single source of truth for message content.
 *
 * Every early exit is a success: the job's goal is "this message's media is
 * linked or provably not wanted", and re-execution converges.
 */
export const downloadMedia: JobHandler = async (payload, ctx) => {
  const { jid, messageId, timestampMs, force } = payload as DownloadMediaPayload;

  const cjid = await chatOps.resolveChatJid(jid);
  const message = await chatOps.getMessage(cjid, messageId);
  if (!message) {
    ctx.log.debug({ jid: cjid, messageId }, "message gone — nothing to download");
    return { changes: [] };
  }
  if (message.media != null) return { changes: [] };

  const raw = rawWAMessage(message);
  if (!raw || !hasMediaContent(raw)) return { changes: [] };

  // Gate re-checked at execution: a long-parked or replayed job must not
  // fetch media that has aged past the window since it was enqueued. Skipped
  // for `force` requests (an explicit scroll-into-view download fetches at any age).
  if (!force && Date.now() - timestampMs > MEDIA_AUTODOWNLOAD_MAX_AGE_MS) {
    ctx.log.debug({ jid: cjid, messageId }, "media aged past the 7-day window — skipping");
    return { changes: [] };
  }

  const sock = ctx.conn.getSocket();
  if (!sock) throw new RetryLater("no socket for media download");

  const downloaded = await withTimeout(downloadMediaPayload(sock, raw), DOWNLOAD_TIMEOUT_MS, "media download");
  if (!downloaded) return { changes: [] };

  const ref = await saveMedia(cjid, {
    data: downloaded.data,
    messageId,
    timestamp: timestampMs || Date.now(),
    mimeType: downloaded.mimeType,
    fileName: downloaded.fileName,
  });
  const linked = await chatOps.setMessageMedia(cjid, messageId, ref);
  return { changes: linked ? [{ table: "messages", jid: cjid, messageId }] : [] };
};

/**
 * `sweep-unlinked-media` — startup self-heal: any recent message whose media
 * never downloaded (or downloaded but never got linked — `saveMedia` is
 * idempotent, so those re-link without re-fetching) gets a download job.
 */
export const sweepUnlinkedMedia: JobHandler = async (_payload, ctx) => {
  const db = await getActiveDb();
  const since = Date.now() - MEDIA_AUTODOWNLOAD_MAX_AGE_MS;
  const rows = db.sql
    .prepare(
      `SELECT c.jid AS jid, m.id AS id, m.timestamp AS timestamp, m.raw AS raw
       FROM messages m JOIN chats c ON c.id = m.chat_id
       WHERE m.media IS NULL AND m.raw IS NOT NULL AND m.deleted_at IS NULL AND m.timestamp > ?`,
    )
    .all(since) as { jid: string; id: string; timestamp: number; raw: string }[];

  const children: ChildJob[] = [];
  for (const row of rows) {
    try {
      const raw = JSON.parse(row.raw) as Parameters<typeof hasMediaContent>[0];
      if (!hasMediaContent(raw)) continue;
    } catch {
      continue;
    }
    children.push({
      type: "download-media",
      name: mediaJobName(row.jid, row.id),
      payload: { jid: row.jid, messageId: row.id, timestampMs: row.timestamp } satisfies DownloadMediaPayload,
    });
  }

  ctx.log.info({ candidates: rows.length, enqueued: children.length }, "unlinked-media sweep");
  return { changes: [], children };
};
