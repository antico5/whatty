import { jidNormalizedUser, type Chat as BaileysChat } from "baileys";
import { chatOps } from "../../persistence/chatStore.js";
import { mapChat } from "../../whatsapp/mappers.js";
import type { DataChange, JobHandler } from "../types.js";
import { STATUS_BROADCAST_JID } from "./shared.js";

/** `process-chats` — chat metadata upserts/updates (subject, archived, activity). */
export const processChats: JobHandler = async (payload) => {
  const waChats = payload as Partial<BaileysChat>[];
  const changes: DataChange[] = [];

  for (const waChat of waChats) {
    if (!waChat.id) continue;
    const jid = jidNormalizedUser(waChat.id);
    if (jid === STATUS_BROADCAST_JID) continue;
    const cjid = await chatOps.resolveChatJid(jid);
    if (await chatOps.mergeChatMeta(cjid, mapChat(waChat), true)) {
      changes.push({ table: "chats", jid: cjid });
    }
  }

  return { changes };
};
