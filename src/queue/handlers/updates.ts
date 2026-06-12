import {
  jidNormalizedUser,
  proto,
  type MessageUserReceiptUpdate,
  type WAMessageUpdate,
} from "baileys";
import { chatOps } from "../../persistence/chatStore.js";
import { editedTargetIdOf, editedTextOf, mapDeliveryStatus, timestampToMillis } from "../../whatsapp/mappers.js";
import type { DataChange, JobHandler } from "../types.js";
import { resolveSelfJid, statusFromReceipt } from "./shared.js";

/** `process-message-update` — revokes, edits, delivery-status patches. */
export const processMessageUpdate: JobHandler = async (payload) => {
  const updates = payload as WAMessageUpdate[];
  const changes: DataChange[] = [];

  for (const { key, update: patch } of updates) {
    if (!key.remoteJid || !key.id) continue;
    const jid = jidNormalizedUser(key.remoteJid);
    const cjid = await chatOps.resolveChatJid(jid);

    if (patch.messageStubType === proto.WebMessageInfo.StubType.REVOKE) {
      if (await chatOps.applyMessageDeletion(cjid, key.id, timestampToMillis(patch.messageTimestamp) || Date.now())) {
        changes.push({ table: "messages", jid: cjid, messageId: key.id });
      }
      continue;
    }

    const editedText = editedTextOf(patch.message);
    if (editedText != null) {
      const targetId = editedTargetIdOf(patch.message) ?? key.id;
      if (await chatOps.applyMessageEdit(cjid, targetId, editedText)) {
        changes.push({ table: "messages", jid: cjid, messageId: targetId });
      }
      continue;
    }

    const status = mapDeliveryStatus(patch.status);
    if (status && (await chatOps.applyDeliveryReceipt(cjid, key.id, status))) {
      changes.push({ table: "messages", jid: cjid, messageId: key.id });
    }
  }

  return { changes };
};

/** `process-receipts` — per-user delivery/read receipts (outbound rows only). */
export const processReceipts: JobHandler = async (payload) => {
  const updates = payload as MessageUserReceiptUpdate[];
  const changes: DataChange[] = [];

  for (const { key, receipt } of updates) {
    if (!key.remoteJid || !key.id) continue;
    const status = statusFromReceipt(receipt);
    if (!status) continue;
    const cjid = await chatOps.resolveChatJid(jidNormalizedUser(key.remoteJid));
    if (await chatOps.applyDeliveryReceipt(cjid, key.id, status)) {
      changes.push({ table: "messages", jid: cjid, messageId: key.id });
    }
  }

  return { changes };
};

/** `process-reaction` — add/replace/remove an emoji reaction. */
export const processReaction: JobHandler = async (payload, ctx) => {
  const entries = payload as { key: proto.IMessageKey; reaction: proto.IReaction }[];
  const changes: DataChange[] = [];

  for (const { key, reaction } of entries) {
    if (!key.remoteJid || !key.id) continue;
    const jid = jidNormalizedUser(key.remoteJid);
    const sender = await reactionSender(reaction.key, ctx);
    if (!sender) continue;
    const cjid = await chatOps.resolveChatJid(jid);
    if (await chatOps.applyReaction(cjid, key.id, { emoji: reaction.text ?? "", senderJid: sender })) {
      changes.push({ table: "messages", jid: cjid, messageId: key.id });
    }
  }

  return { changes };
};

async function reactionSender(
  senderKey: proto.IMessageKey | null | undefined,
  ctx: Parameters<JobHandler>[1],
): Promise<string | null> {
  if (!senderKey) return null;
  // `fromMe` resolves via the DB self account (replay may run with no socket).
  if (senderKey.fromMe) return resolveSelfJid(ctx.conn);
  const candidate = senderKey.participant ?? senderKey.remoteJid ?? undefined;
  return candidate ? jidNormalizedUser(candidate) : null;
}
