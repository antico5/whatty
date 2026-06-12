import { jidNormalizedUser, type proto, type WAMessage } from "baileys";
import { chatOps } from "../../persistence/chatStore.js";
import { decryptEncryptedEdit, encryptedEditOf } from "../../whatsapp/edits.js";
import { rawWAMessage } from "../../whatsapp/mappers.js";
import { RetryLater, type JobHandler, type JobHandlerContext } from "../types.js";
import { resolveSelfJid } from "./shared.js";

/**
 * `apply-encrypted-edit` — replaces the old in-memory `pendingEncryptedEdits`
 * map (a 100-entry LRU that silently evicted, and evaporated on exit). The
 * envelope is embedded in the job because edit envelopes are filtered out of
 * regular ingestion and never stored as message rows.
 *
 * The original message usually arrives later (on-demand history response →
 * its own `process-messages` job), so "original missing" throws and the job
 * retries on its own clock until it lands or the job parks.
 */

/** History-request dedup, scoped to one socket: a reconnect kills in-flight
 * on-demand history responses, so a fresh socket must be allowed to re-ask. */
let dedupSocket: unknown = null;
const requestedHistory = new Set<string>();

interface EncryptedEditPayload {
  jid: string;
  targetId: string;
  envelope: WAMessage;
}

export const applyEncryptedEdit: JobHandler = async (payload, ctx) => {
  const { jid, targetId, envelope } = payload as EncryptedEditPayload;
  const encryptedEdit = encryptedEditOf(envelope);
  if (!encryptedEdit) {
    ctx.log.warn({ jid, targetId }, "job payload carries no encrypted edit — dropping");
    return { changes: [] };
  }

  const me = await resolveSelfJid(ctx.conn);
  const targetKey = envelope.message?.secretEncryptedMessage?.targetMessageKey;
  const envelopeAuthor = envelope.key.fromMe
    ? me
    : jidNormalizedUser(envelope.key.participant ?? envelope.key.remoteJid ?? undefined);
  const originalSender = targetKey?.participant
    ? jidNormalizedUser(targetKey.participant)
    : targetKey?.fromMe
      ? envelopeAuthor
      : jidNormalizedUser(targetKey?.remoteJid ?? undefined);
  if (!envelopeAuthor || !originalSender) {
    ctx.log.warn({ jid, targetId }, "cannot resolve edit participants — dropping");
    return { changes: [] };
  }

  const cjid = await chatOps.resolveChatJid(jid);
  const original = await chatOps.getMessage(cjid, targetId);
  if (!original) {
    await requestEditHistory(jid, targetId, ctx, [
      { key: envelope.key, timestamp: envelope.messageTimestamp },
      { key: targetKey ?? envelope.key, timestamp: envelope.messageTimestamp },
    ]);
    throw new Error("original message not stored yet");
  }

  const originalRaw = rawWAMessage(original);
  const historyKey = originalRaw?.key ?? targetKey ?? envelope.key;
  const historyTimestamp = originalRaw?.messageTimestamp ?? original.timestamp / 1000;
  const historyRequests = [
    { key: envelope.key, timestamp: envelope.messageTimestamp },
    { key: historyKey, timestamp: envelope.messageTimestamp },
    { key: historyKey, timestamp: historyTimestamp },
  ];

  let text: string | null;
  try {
    text = decryptEncryptedEdit(encryptedEdit, original, originalSender, envelopeAuthor);
  } catch (err) {
    await requestEditHistory(jid, targetId, ctx, historyRequests);
    ctx.log.warn({ err, jid, targetId }, "failed to decrypt encrypted message edit");
    throw err instanceof Error ? err : new Error(String(err));
  }
  if (text == null) {
    // No messageSecret on the stored original (phone-sent) — the on-demand
    // history response is the only source of one.
    await requestEditHistory(jid, targetId, ctx, historyRequests);
    throw new Error("original message lacks a messageSecret");
  }

  const applied = await chatOps.applyMessageEdit(cjid, targetId, text);
  return { changes: applied ? [{ table: "messages", jid: cjid, messageId: targetId }] : [] };
};

async function requestEditHistory(
  jid: string,
  targetId: string,
  ctx: JobHandlerContext,
  requests: { key: proto.IMessageKey; timestamp: WAMessage["messageTimestamp"] }[],
): Promise<void> {
  const socket = ctx.conn.getSocket();
  if (!socket) throw new RetryLater("no socket to request edit history");
  if (dedupSocket !== socket) {
    dedupSocket = socket;
    requestedHistory.clear();
  }

  const dedupKey = `${jid}\0${targetId}`;
  if (requestedHistory.has(dedupKey)) return;
  const validRequests = requests.filter((request) => request.key.id);
  if (validRequests.length === 0) return;
  requestedHistory.add(dedupKey);
  ctx.log.info({ jid, targetId, requests: validRequests.length }, "requesting history for encrypted edit");

  const results = await Promise.allSettled(
    validRequests.map((request) =>
      socket.fetchMessageHistory(10, request.key, request.timestamp ?? Math.floor(Date.now() / 1000)),
    ),
  );
  if (results.every((result) => result.status === "rejected")) {
    requestedHistory.delete(dedupKey);
    ctx.log.warn({ jid, targetId }, "all history requests for encrypted edit failed");
  }
}
