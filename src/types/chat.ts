import type { Message } from "./message.js";

export type ChatType = "individual" | "group";

export interface GroupParticipant {
  /** The member's preferred jid (phone-first); still `@lid` while the pairing is unknown. */
  jid: string;
  /** Derived at load from the member's account row (contact ?? verified ?? push name). */
  displayName: string | null;
  isAdmin?: boolean;
}

export interface Chat {
  jid: string;
  type: ChatType;
  /** Individuals: derived at load from the peer account (saved-contact or verified name only — null renders "Not Contact"). */
  displayName: string | null;
  /** Derived at load from the peer account's phone jid. */
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
