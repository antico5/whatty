import { jidNormalizedUser, type GroupMetadata } from "baileys";
import { chatOps } from "../../persistence/chatStore.js";
import type { Chat } from "../../types/index.js";
import {
  groupParticipantAliases,
  mapGroupMetadata,
  mapGroupParticipants,
} from "../../whatsapp/mappers.js";
import { RetryLater, type ChildJob, type DataChange, type JobHandler } from "../types.js";
import { observeAccounts, participantObservations, refreshGroupJobName, registerPairs } from "./shared.js";

/**
 * `process-groups` — `groups.update` delivers partial metadata arrays applied
 * directly; `group-participants.update` only names the group, so it derives a
 * `refresh-group-metadata` job to fetch the full participant list.
 */
export const processGroups: JobHandler = async (payload) => {
  const changes: DataChange[] = [];
  const children: ChildJob[] = [];

  if (Array.isArray(payload)) {
    for (const meta of payload as Partial<GroupMetadata>[]) {
      if (!meta.id) continue;
      const jid = jidNormalizedUser(meta.id);
      const partial: Partial<Chat> = { jid, type: "group" };
      if (meta.subject != null) partial.groupSubject = meta.subject;
      if (meta.participants) {
        changes.push(...(await registerPairs(groupParticipantAliases(meta.participants))));
        changes.push(...(await observeAccounts(participantObservations(meta.participants))));
        partial.participants = mapGroupParticipants(meta.participants);
      }
      const cjid = await chatOps.resolveChatJid(jid);
      if (await chatOps.mergeChatMeta(cjid, partial, true)) changes.push({ table: "chats", jid: cjid });
    }
    return { changes, children };
  }

  const evt = payload as { id?: string } | null | undefined;
  if (evt?.id) {
    const jid = jidNormalizedUser(evt.id);
    children.push({ type: "refresh-group-metadata", name: refreshGroupJobName(jid), payload: { jid } });
  }
  return { changes, children };
};

/** `refresh-group-metadata` — fetch the full group state; needs a live socket. */
export const refreshGroupMetadata: JobHandler = async (payload, ctx) => {
  const { jid } = payload as { jid: string };
  const sock = ctx.conn.getSocket();
  if (!sock) throw new RetryLater("no socket for group metadata refresh");

  const meta = await sock.groupMetadata(jid);
  const changes: DataChange[] = [
    ...(await registerPairs(groupParticipantAliases(meta.participants))),
    ...(await observeAccounts(participantObservations(meta.participants))),
  ];
  const cjid = await chatOps.resolveChatJid(jid);
  if (await chatOps.mergeChatMeta(cjid, mapGroupMetadata(meta), true)) changes.push({ table: "chats", jid: cjid });
  return { changes };
};
