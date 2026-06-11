import type { Message } from "./message.js";

export type ChatType = "individual" | "group";

export interface GroupParticipant {
  jid: string;
  displayName: string | null;
  isAdmin?: boolean;
}

export interface Chat {
  jid: string;
  type: ChatType;
  displayName: string | null;
  phoneNumber: string | null;
  groupSubject: string | null;
  participants: GroupParticipant[];
  archived: boolean;
  lastActivity: number;
  messages: Message[];
}

export function createEmptyChat(jid: string, type: ChatType): Chat {
  return {
    jid,
    type,
    displayName: null,
    phoneNumber: null,
    groupSubject: null,
    participants: [],
    archived: false,
    lastActivity: 0,
    messages: [],
  };
}

export function isGroupJid(jid: string): boolean {
  return jid.endsWith("@g.us");
}

export function chatTypeOf(jid: string): ChatType {
  return isGroupJid(jid) ? "group" : "individual";
}

/** The minimal metadata every chat upsert carries — the jid and its derived type. */
export function minimalChatMeta(jid: string): Partial<Chat> {
  return { jid, type: chatTypeOf(jid) };
}
