import { jidNormalizedUser, type WAMessage } from "baileys";
import { chatOps } from "../../persistence/chatStore.js";
import { chatTypeOf, type Chat } from "../../types/index.js";
import { encryptedEditOf } from "../../whatsapp/edits.js";
import {
  editedTargetIdOf,
  editedTextOf,
  mapWAMessage,
  timestampToMillis,
  verifiedBizNameFromMessages,
} from "../../whatsapp/mappers.js";
import type { ChildJob, DataChange, JobHandler, JobHandlerContext } from "../types.js";
import {
  encryptedEditJobName,
  groupMessagesByJid,
  hasMediaContent,
  isRegularMessage,
  MEDIA_AUTODOWNLOAD_MAX_AGE_MS,
  mediaJobName,
  messageObservations,
  minimalMeta,
  observeAccounts,
  registerPairs,
  revokedTargetId,
} from "./shared.js";

/**
 * Core batch ingestion for one chat — shared by `process-messages` (live
 * upserts) and `process-history` (history chunks). Replaces the old
 * ingestor's `ingestMessages`: the same chatOps calls, but awaited in place
 * (the db lane already serializes) and with media downloads / encrypted edits
 * returned as child jobs instead of in-memory queue tasks.
 */
export async function ingestMessageBatch(
  jid: string,
  waMessages: WAMessage[],
  baseMeta: Partial<Chat>,
  ctx: JobHandlerContext,
): Promise<{ changes: DataChange[]; children: ChildJob[] }> {
  const changes: DataChange[] = [];
  const children: ChildJob[] = [];

  const regular = waMessages.filter(isRegularMessage);
  const incoming = regular.map(mapWAMessage);
  changes.push(...(await observeAccounts(messageObservations(waMessages))));

  if (chatTypeOf(jid) === "individual") {
    // Business accounts are rarely saved contacts, so their chats would
    // render as "Not Contact" forever; their messages carry a WhatsApp-
    // verified name, which lands on the peer account (a saved-contact name
    // still wins at label time).
    const bizName = verifiedBizNameFromMessages(waMessages);
    if (bizName != null) changes.push(...(await observeAccounts([{ jids: [jid], verifiedName: bizName }])));
    // Still keyed by `@lid` here means no message in this batch carried the
    // phone-jid pairing — recover it from Baileys' signal store (best-effort:
    // needs a live socket, and history replay may run without one).
    if (jid.endsWith("@lid")) changes.push(...(await refreshLidPhoneNumber(jid, ctx)));
  }

  const cjid = await chatOps.resolveChatJid(jid);

  if (incoming.length > 0 || Object.keys(baseMeta).length > 2) {
    await chatOps.upsertChatMessages(cjid, baseMeta, incoming);
    changes.push({ table: "chats", jid: cjid });
  }

  for (const waMsg of waMessages) {
    const targetId = revokedTargetId(waMsg);
    if (targetId) {
      if (await chatOps.applyMessageDeletion(cjid, targetId, timestampToMillis(waMsg.messageTimestamp) || Date.now())) {
        changes.push({ table: "messages", jid: cjid, messageId: targetId });
      }
    }

    const editedText = editedTextOf(waMsg.message);
    const editedTargetId = editedTargetIdOf(waMsg.message) ?? waMsg.key.id;
    if (editedText != null && editedTargetId) {
      if (await chatOps.applyMessageEdit(cjid, editedTargetId, editedText)) {
        changes.push({ table: "messages", jid: cjid, messageId: editedTargetId });
      }
    }

    const encryptedEdit = encryptedEditOf(waMsg);
    if (encryptedEdit) {
      children.push({
        type: "apply-encrypted-edit",
        name: encryptedEditJobName(jid, encryptedEdit.targetId),
        payload: { jid, targetId: encryptedEdit.targetId, envelope: waMsg },
      });
    }
  }

  for (const waMsg of regular) {
    if (!waMsg.key.id || !hasMediaContent(waMsg)) continue;
    const timestampMs = timestampToMillis(waMsg.messageTimestamp);
    if (Date.now() - timestampMs > MEDIA_AUTODOWNLOAD_MAX_AGE_MS) {
      ctx.log.debug({ jid, messageId: waMsg.key.id }, "skipping media download: message older than 7 days");
      continue;
    }
    children.push({
      type: "download-media",
      name: mediaJobName(cjid, waMsg.key.id),
      payload: { jid: cjid, messageId: waMsg.key.id, timestampMs },
    });
  }

  return { changes, children };
}

/**
 * History-synced message keys carry no alt-jid (unlike live messages), so a
 * `@lid` chat restored from history has no way to learn its phone number
 * from messages. Baileys' signal store keeps the lid↔pn pairs delivered at
 * pairing time — resolve from there and register the pair (which merges the
 * accounts and re-keys the chat to the phone jid).
 */
async function refreshLidPhoneNumber(jid: string, ctx: JobHandlerContext): Promise<DataChange[]> {
  const lidMapping = ctx.conn.getSocket()?.signalRepository?.lidMapping;
  if (!lidMapping) return [];
  try {
    const pn = await lidMapping.getPNForLID(jid);
    const phoneJid = pn ? jidNormalizedUser(pn) : null;
    if (!phoneJid?.endsWith("@s.whatsapp.net")) return [];
    return registerPairs(new Map([[jid, phoneJid]]));
  } catch (err) {
    ctx.log.warn({ err, jid }, "failed to resolve phone number for lid chat");
    return [];
  }
}

/** `process-messages` — one Baileys `messages.upsert` payload. */
export const processMessages: JobHandler = async (payload, ctx) => {
  const { messages } = payload as { messages: WAMessage[] };
  const { byJid, aliases } = groupMessagesByJid(messages);

  const changes: DataChange[] = [...(await registerPairs(aliases))];
  const children: ChildJob[] = [];

  for (const [jid, waMessages] of byJid) {
    const batch = await ingestMessageBatch(jid, waMessages, minimalMeta(jid), ctx);
    changes.push(...batch.changes);
    children.push(...batch.children);
  }

  return { changes, children };
};
