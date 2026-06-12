import { jidNormalizedUser, type Chat as BaileysChat, type Contact, type WAMessage } from "baileys";
import { mapChat } from "../../whatsapp/mappers.js";
import type { ChildJob, DataChange, JobHandler } from "../types.js";
import { ingestMessageBatch } from "./messages.js";
import {
  contactObservation,
  groupMessagesByJid,
  minimalMeta,
  observeAccounts,
  registerPairs,
  STATUS_BROADCAST_JID,
} from "./shared.js";

interface HistoryPayload {
  chats: BaileysChat[];
  contacts: Contact[];
  messages: WAMessage[];
  syncType?: unknown;
  progress?: number | null;
  isLatest?: boolean;
}

/**
 * `process-history` — one history-sync chunk (bootstrap, RECENT or FULL; the
 * socket config processes all of them). Chunks arrive once at link time;
 * persisting their push names here is what keeps non-contact group member
 * names across restarts.
 */
export const processHistory: JobHandler = async (payload, ctx) => {
  const { chats, contacts, messages, syncType, progress } = payload as HistoryPayload;
  ctx.log.debug({ chats: chats.length, contacts: contacts.length, messages: messages.length, syncType, progress }, "history chunk");

  const changes: DataChange[] = [...(await observeAccounts(contacts.map(contactObservation)))];
  const children: ChildJob[] = [];

  const { byJid: messagesByJid, aliases } = groupMessagesByJid(messages);
  changes.push(...(await registerPairs(aliases)));

  const jids = new Set<string>();
  for (const c of chats) {
    if (c.id) jids.add(jidNormalizedUser(c.id));
  }
  for (const jid of messagesByJid.keys()) jids.add(jid);

  for (const jid of jids) {
    if (jid === STATUS_BROADCAST_JID) continue;
    const waChat = chats.find((c) => c.id && jidNormalizedUser(c.id) === jid);
    const meta = waChat ? mapChat(waChat) : minimalMeta(jid);
    const batch = await ingestMessageBatch(jid, messagesByJid.get(jid) ?? [], meta, ctx);
    changes.push(...batch.changes);
    children.push(...batch.children);
  }

  return { changes, children };
};
