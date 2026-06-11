import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { loadChat as defaultLoadChat, saveChat as defaultSaveChat } from "../persistence/chatStore.js";
import { mergeMessages, upsertChat } from "../persistence/reconcile.js";
import { minimalChatMeta, type Chat, type Message } from "../types/index.js";
import type { Connection } from "./connection.js";
import { getLogger } from "./logger.js";
import { timestampToMillis } from "./mappers.js";

export interface SenderDeps {
  loadChat: (jid: string) => Promise<Chat | null>;
  saveChat: (chat: Chat) => Promise<void>;
}

export interface Sender extends EventEmitter {
  sendText(jid: string, text: string): Promise<Message>;
}

function optimisticMessage(text: string): Message {
  return {
    id: `local-${randomUUID()}`,
    senderJid: null,
    senderName: null,
    direction: "outbound",
    timestamp: Date.now(),
    type: "text",
    text,
    media: null,
    quoted: null,
    deliveryStatus: "pending",
    deleted: false,
    deletedAt: null,
    raw: null,
  };
}

/** Swap a message by id for a replacement, re-sorting via `mergeMessages` (the
 * replacement may carry a different id — e.g. temp local id → server-assigned id). */
function replaceMessage(chat: Chat, oldId: string, next: Message): Chat {
  const withoutOld = chat.messages.filter((m) => m.id !== oldId);
  return { ...chat, messages: mergeMessages(withoutOld, [next]) };
}

/**
 * Outbound text sending (v1 = text only): persists an optimistic message
 * immediately so the UI reflects it without waiting on the network, then
 * reconciles the server-assigned id and final status once the send settles.
 */
export function createSender(conn: Connection, deps: Partial<SenderDeps> = {}): Sender {
  const loadChat = deps.loadChat ?? defaultLoadChat;
  const saveChat = deps.saveChat ?? defaultSaveChat;
  const log = getLogger().child({ module: "send" });
  const emitter = new EventEmitter() as Sender;

  async function persist(jid: string, mutate: (local: Chat | null) => Chat | null): Promise<void> {
    try {
      const local = await loadChat(jid);
      const next = mutate(local);
      if (!next) return;
      await saveChat(next);
      emitter.emit("chat-updated", jid);
    } catch (err) {
      log.error({ err, jid }, "failed to persist outbound message");
    }
  }

  emitter.sendText = async (jid: string, text: string): Promise<Message> => {
    const optimistic = optimisticMessage(text);

    await persist(jid, (local) => upsertChat(local, minimalChatMeta(jid), [optimistic]));

    let result;
    try {
      result = await conn.sendText(jid, text);
    } catch (err) {
      log.error({ err, jid, id: optimistic.id }, "failed to send text message");
      const failed: Message = { ...optimistic, deliveryStatus: "failed" };
      await persist(jid, (local) => (local ? replaceMessage(local, optimistic.id, failed) : null));
      return failed;
    }

    const sent: Message = {
      ...optimistic,
      id: result?.key?.id ?? optimistic.id,
      timestamp: timestampToMillis(result?.messageTimestamp) || optimistic.timestamp,
      deliveryStatus: "sent",
      raw: result ?? null,
    };

    await persist(jid, (local) => (local ? replaceMessage(local, optimistic.id, sent) : null));

    return sent;
  };

  return emitter;
}
