import { getLogger } from "../logger.js";
import {
  chatTypeOf,
  type Chat,
  type ChatType,
  type DeliveryStatus,
  type GroupParticipant,
  type MediaRef,
  type Message,
} from "../types/index.js";
import { advanceDeliveryStatus, mergeChatMeta, tombstone, upsertChat } from "./reconcile.js";
import { getActiveDb, type AccountDb } from "./db.js";

/**
 * SQLite-backed chat store. Two API tiers:
 *
 * - The whole-chat tier (`loadChat`/`saveChat`/`loadAllChats`) keeps the
 *   pre-SQLite contract: a `Chat` aggregate in, a `Chat` aggregate out.
 *   `saveChat` is a full row replacement — correct but write-amplified, so
 *   it's reserved for infrequent paths (sending, alias merges, import).
 *
 * - `chatOps` is the targeted tier used by live ingestion: each operation
 *   touches only the rows it needs (a receipt updates one column of one row
 *   instead of rewriting a 3,000-message chat).
 *
 * Every entry point resolves `aliases` first, so events addressed to a chat's
 * `@lid` identity land on the canonical (phone-jid) record.
 */

interface ChatRow {
  jid: string;
  type: string;
  display_name: string | null;
  phone_number: string | null;
  group_subject: string | null;
  archived: number;
  last_activity: number;
}

interface MessageRow {
  chat_jid: string;
  id: string;
  sender_jid: string | null;
  sender_name: string | null;
  direction: string;
  timestamp: number;
  type: string;
  text: string | null;
  delivery_status: string | null;
  deleted_at: number | null;
  edited: number;
  media: string | null;
  quoted: string | null;
  raw: string | null;
}

function parseJson<T>(text: string | null): T | null {
  if (text == null) return null;
  try {
    return JSON.parse(text) as T;
  } catch (err) {
    getLogger().warn({ err }, "corrupt JSON column — treating as null");
    return null;
  }
}

function toJson(value: unknown): string | null {
  if (value == null) return null;
  return JSON.stringify(value);
}

function messageFromRow(row: MessageRow, reactions?: { emoji: string; sender: string }[]): Message {
  const message: Message = {
    id: row.id,
    senderJid: row.sender_jid,
    senderName: row.sender_name,
    direction: row.direction as Message["direction"],
    timestamp: row.timestamp,
    type: row.type as Message["type"],
    text: row.text,
    media: parseJson<MediaRef>(row.media),
    quoted: parseJson<Message["quoted"]>(row.quoted),
    deliveryStatus: row.delivery_status as DeliveryStatus | null,
    deleted: row.deleted_at != null,
    deletedAt: row.deleted_at,
    raw: parseJson(row.raw),
  };
  if (row.edited) message.edited = true;
  if (reactions && reactions.length > 0) message.reactions = reactions;
  return message;
}

function chatFromRow(row: ChatRow, participants: GroupParticipant[], messages: Message[]): Chat {
  return {
    jid: row.jid,
    type: row.type as ChatType,
    displayName: row.display_name,
    phoneNumber: row.phone_number,
    groupSubject: row.group_subject,
    participants,
    archived: row.archived !== 0,
    lastActivity: row.last_activity,
    messages,
  };
}

function participantsOf(db: AccountDb, jid: string): GroupParticipant[] {
  const rows = db.sql
    .prepare("SELECT jid, display_name, is_admin FROM participants WHERE chat_jid = ? ORDER BY rowid")
    .all(jid) as { jid: string; display_name: string | null; is_admin: number | null }[];
  return rows.map((r) => {
    const p: GroupParticipant = { jid: r.jid, displayName: r.display_name };
    if (r.is_admin != null) p.isAdmin = r.is_admin !== 0;
    return p;
  });
}

function reactionsByMessage(db: AccountDb, jid: string): Map<string, { emoji: string; sender: string }[]> {
  const rows = db.sql
    .prepare("SELECT message_id, sender, emoji FROM reactions WHERE chat_jid = ? ORDER BY rowid")
    .all(jid) as { message_id: string; sender: string; emoji: string }[];
  const byId = new Map<string, { emoji: string; sender: string }[]>();
  for (const r of rows) {
    const list = byId.get(r.message_id) ?? [];
    list.push({ emoji: r.emoji, sender: r.sender });
    byId.set(r.message_id, list);
  }
  return byId;
}

function resolveAlias(db: AccountDb, jid: string): string {
  const row = db.sql.prepare("SELECT chat_jid FROM aliases WHERE alias_jid = ?").get(jid) as
    | { chat_jid: string }
    | undefined;
  return row?.chat_jid ?? jid;
}

/** Chat meta + participants, without messages. */
function chatShell(db: AccountDb, jid: string): Chat | null {
  const row = db.sql.prepare("SELECT * FROM chats WHERE jid = ?").get(jid) as ChatRow | undefined;
  if (!row) return null;
  return chatFromRow(row, participantsOf(db, jid), []);
}

function loadMessages(db: AccountDb, jid: string): Message[] {
  const rows = db.sql
    .prepare("SELECT * FROM messages WHERE chat_jid = ? ORDER BY timestamp, id")
    .all(jid) as unknown as MessageRow[];
  const reactions = reactionsByMessage(db, jid);
  return rows.map((r) => messageFromRow(r, reactions.get(r.id)));
}

function writeChatRow(db: AccountDb, chat: Chat): void {
  db.sql
    .prepare(
      `INSERT OR REPLACE INTO chats (jid, type, display_name, phone_number, group_subject, archived, last_activity)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(chat.jid, chat.type, chat.displayName, chat.phoneNumber, chat.groupSubject, chat.archived, chat.lastActivity);
  db.sql.prepare("DELETE FROM participants WHERE chat_jid = ?").run(chat.jid);
  const insert = db.sql.prepare(
    "INSERT INTO participants (chat_jid, jid, display_name, is_admin) VALUES (?, ?, ?, ?)",
  );
  for (const p of chat.participants) insert.run(chat.jid, p.jid, p.displayName, p.isAdmin ?? null);
}

function upsertMessageRow(db: AccountDb, chatJid: string, m: Message): void {
  db.sql
    .prepare(
      `INSERT OR REPLACE INTO messages
       (chat_jid, id, sender_jid, sender_name, direction, timestamp, type, text,
        delivery_status, deleted_at, edited, media, quoted, raw)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      chatJid,
      m.id,
      m.senderJid,
      m.senderName,
      m.direction,
      m.timestamp,
      m.type,
      m.text,
      m.deliveryStatus,
      m.deletedAt ?? (m.deleted ? m.timestamp : null),
      m.edited ?? false,
      toJson(m.media),
      toJson(m.quoted),
      toJson(m.raw),
    );
  db.sql.prepare("DELETE FROM reactions WHERE chat_jid = ? AND message_id = ?").run(chatJid, m.id);
  if (m.reactions) {
    const insert = db.sql.prepare(
      "INSERT OR REPLACE INTO reactions (chat_jid, message_id, sender, emoji) VALUES (?, ?, ?, ?)",
    );
    for (const r of m.reactions) insert.run(chatJid, m.id, r.sender, r.emoji);
  }
}

function loadChatFrom(db: AccountDb, jid: string): Chat | null {
  const canonical = resolveAlias(db, jid);
  const shell = chatShell(db, canonical);
  if (!shell) return null;
  shell.messages = loadMessages(db, canonical);
  return shell;
}

function saveChatTo(db: AccountDb, chat: Chat): void {
  db.transaction(() => {
    writeChatRow(db, chat);
    db.sql.prepare("DELETE FROM reactions WHERE chat_jid = ?").run(chat.jid);
    db.sql.prepare("DELETE FROM messages WHERE chat_jid = ?").run(chat.jid);
    for (const m of chat.messages) upsertMessageRow(db, chat.jid, m);
  });
}

// ── whole-chat tier (pre-SQLite contract) ───────────────────────────────────

export async function loadChat(jid: string): Promise<Chat | null> {
  return loadChatFrom(await getActiveDb(), jid);
}

/** Full replacement of the chat's rows — reserved for infrequent paths. */
export async function saveChat(chat: Chat): Promise<void> {
  saveChatTo(await getActiveDb(), chat);
}

export async function listChatJids(): Promise<string[]> {
  const db = await getActiveDb();
  const rows = db.sql.prepare("SELECT jid FROM chats").all() as { jid: string }[];
  return rows.map((r) => r.jid);
}

export async function loadAllChats(): Promise<Chat[]> {
  const db = await getActiveDb();
  const chatRows = db.sql.prepare("SELECT * FROM chats").all() as unknown as ChatRow[];
  const chats: Chat[] = [];
  for (const row of chatRows) {
    const chat = loadChatFrom(db, row.jid);
    if (chat) chats.push(chat);
  }
  return chats;
}

// ── targeted tier: chatOps ──────────────────────────────────────────────────

export interface FoundMessage {
  chatJid: string;
  message: Message;
}

export interface ChatOps {
  /** Resolve a jid through the alias table (lid → canonical phone jid). */
  getCanonicalJid(jid: string): Promise<string>;
  /**
   * Register `aliasJid` as an alternate identity of `chatJid` and fold any
   * chat rows accumulated under the alias into the canonical record. First
   * write wins — an alias is never silently re-pointed.
   */
  addAlias(aliasJid: string, chatJid: string): Promise<void>;
  /**
   * Reconcile-merge incoming meta + messages into the chat, touching only the
   * affected message rows. `fillDisplayNameIfMissing` mirrors the verified-biz
   * name rule: applied only when neither the stored chat nor the incoming
   * meta carries a name.
   */
  upsertChatMessages(
    jid: string,
    meta: Partial<Chat>,
    incoming: Message[],
    fillDisplayNameIfMissing?: string | null,
  ): Promise<void>;
  /** Merge chat metadata only. Returns false when the chat doesn't exist and `createIfMissing` is off. */
  mergeChatMeta(jid: string, meta: Partial<Chat>, createIfMissing: boolean): Promise<boolean>;
  applyDeliveryReceipt(jid: string, messageId: string, status: DeliveryStatus): Promise<boolean>;
  applyReaction(jid: string, targetMessageId: string, reaction: { emoji: string; sender: string }): Promise<boolean>;
  applyMessageEdit(jid: string, messageId: string, text: string): Promise<boolean>;
  /** Mark deleted in place, or create a tombstone (and the chat) when unknown. */
  applyMessageDeletion(jid: string, messageId: string, deletedAt: number): Promise<boolean>;
  /** Attach a downloaded MediaRef; no-op if the message is gone or already has media. */
  setMessageMedia(jid: string, messageId: string, media: MediaRef): Promise<boolean>;
  getMessage(jid: string, messageId: string): Promise<Message | null>;
  /** Indexed cross-chat lookup by message id (replaces the all-chats scan). */
  findMessageById(messageId: string): Promise<FoundMessage | null>;
}

function getMessageRow(db: AccountDb, chatJid: string, id: string): MessageRow | undefined {
  return db.sql.prepare("SELECT * FROM messages WHERE chat_jid = ? AND id = ?").get(chatJid, id) as
    | MessageRow
    | undefined;
}

function ensureChatRow(db: AccountDb, jid: string): void {
  db.sql.prepare("INSERT OR IGNORE INTO chats (jid, type) VALUES (?, ?)").run(jid, chatTypeOf(jid));
}

export const chatOps: ChatOps = {
  async getCanonicalJid(jid) {
    return resolveAlias(await getActiveDb(), jid);
  },

  async addAlias(aliasJid, chatJid) {
    if (aliasJid === chatJid) return;
    const db = await getActiveDb();
    db.transaction(() => {
      const existing = db.sql.prepare("SELECT chat_jid FROM aliases WHERE alias_jid = ?").get(aliasJid) as
        | { chat_jid: string }
        | undefined;
      if (existing) return;
      db.sql.prepare("INSERT INTO aliases (alias_jid, chat_jid) VALUES (?, ?)").run(aliasJid, chatJid);

      const strayShell = chatShell(db, aliasJid);
      if (!strayShell) return;
      const strayMessages = loadMessages(db, aliasJid);

      const targetShell = chatShell(db, chatJid);
      const targetChat = targetShell ? { ...targetShell, messages: loadMessages(db, chatJid) } : null;

      // Canonical chat's fields win; the stray only fills gaps.
      const meta: Partial<Chat> = {
        jid: chatJid,
        type: chatTypeOf(chatJid),
        displayName: targetChat?.displayName ?? strayShell.displayName ?? undefined,
        phoneNumber: targetChat?.phoneNumber ?? strayShell.phoneNumber ?? undefined,
        groupSubject: targetChat?.groupSubject ?? strayShell.groupSubject ?? undefined,
        archived: (targetChat?.archived ?? false) || strayShell.archived,
        lastActivity: Math.max(targetChat?.lastActivity ?? 0, strayShell.lastActivity),
        participants: strayShell.participants.length > 0 ? strayShell.participants : undefined,
      };
      const merged = upsertChat(targetChat, meta, strayMessages);
      saveChatTo(db, merged);

      db.sql.prepare("DELETE FROM reactions WHERE chat_jid = ?").run(aliasJid);
      db.sql.prepare("DELETE FROM messages WHERE chat_jid = ?").run(aliasJid);
      db.sql.prepare("DELETE FROM participants WHERE chat_jid = ?").run(aliasJid);
      db.sql.prepare("DELETE FROM chats WHERE jid = ?").run(aliasJid);
      getLogger().info(
        { aliasJid, chatJid, mergedMessages: strayMessages.length },
        "merged alias-keyed chat into canonical",
      );
    });
  },

  async upsertChatMessages(jid, meta, incoming, fillDisplayNameIfMissing) {
    const db = await getActiveDb();
    db.transaction(() => {
      const canonical = resolveAlias(db, jid);
      const shell = chatShell(db, canonical);

      const metaX: Partial<Chat> = { ...meta, jid: canonical };
      if (fillDisplayNameIfMissing != null && shell?.displayName == null && metaX.displayName == null) {
        metaX.displayName = fillDisplayNameIfMissing;
      }

      const existing: Message[] = [];
      if (shell && incoming.length > 0) {
        const reactions = reactionsByMessage(db, canonical);
        for (const m of incoming) {
          const row = getMessageRow(db, canonical, m.id);
          if (row) existing.push(messageFromRow(row, reactions.get(row.id)));
        }
      }

      const base = shell ? { ...shell, messages: existing } : null;
      const next = upsertChat(base, metaX, incoming);

      writeChatRow(db, next);
      for (const m of next.messages) upsertMessageRow(db, canonical, m);
    });
  },

  async mergeChatMeta(jid, meta, createIfMissing) {
    const db = await getActiveDb();
    return db.transaction(() => {
      const canonical = resolveAlias(db, jid);
      const shell = chatShell(db, canonical);
      if (!shell && !createIfMissing) return false;
      const next = mergeChatMeta(shell, { ...meta, jid: canonical });
      writeChatRow(db, next);
      return true;
    });
  },

  async applyDeliveryReceipt(jid, messageId, status) {
    const db = await getActiveDb();
    const canonical = resolveAlias(db, jid);
    const row = getMessageRow(db, canonical, messageId);
    if (!row || row.direction !== "outbound") return false;
    const next = advanceDeliveryStatus(row.delivery_status as DeliveryStatus | null, status);
    if (next === row.delivery_status) return false;
    db.sql
      .prepare("UPDATE messages SET delivery_status = ? WHERE chat_jid = ? AND id = ?")
      .run(next, canonical, messageId);
    return true;
  },

  async applyReaction(jid, targetMessageId, reaction) {
    const db = await getActiveDb();
    return db.transaction(() => {
      const canonical = resolveAlias(db, jid);
      if (!getMessageRow(db, canonical, targetMessageId)) return false;
      db.sql
        .prepare("DELETE FROM reactions WHERE chat_jid = ? AND message_id = ? AND sender = ?")
        .run(canonical, targetMessageId, reaction.sender);
      if (reaction.emoji) {
        db.sql
          .prepare("INSERT INTO reactions (chat_jid, message_id, sender, emoji) VALUES (?, ?, ?, ?)")
          .run(canonical, targetMessageId, reaction.sender, reaction.emoji);
      }
      return true;
    });
  },

  async applyMessageEdit(jid, messageId, text) {
    const db = await getActiveDb();
    const canonical = resolveAlias(db, jid);
    const row = getMessageRow(db, canonical, messageId);
    if (!row) return false;
    if (row.edited && row.text === text) return false;
    db.sql
      .prepare("UPDATE messages SET text = ?, edited = 1 WHERE chat_jid = ? AND id = ?")
      .run(text, canonical, messageId);
    return true;
  },

  async applyMessageDeletion(jid, messageId, deletedAt) {
    const db = await getActiveDb();
    return db.transaction(() => {
      const canonical = resolveAlias(db, jid);
      ensureChatRow(db, canonical);
      const row = getMessageRow(db, canonical, messageId);
      if (!row) {
        upsertMessageRow(db, canonical, tombstone(messageId, deletedAt));
        return true;
      }
      if (row.deleted_at != null) return false;
      db.sql
        .prepare("UPDATE messages SET deleted_at = ? WHERE chat_jid = ? AND id = ?")
        .run(deletedAt, canonical, messageId);
      return true;
    });
  },

  async setMessageMedia(jid, messageId, media) {
    const db = await getActiveDb();
    const canonical = resolveAlias(db, jid);
    const row = getMessageRow(db, canonical, messageId);
    if (!row || row.media != null) return false;
    db.sql
      .prepare("UPDATE messages SET media = ? WHERE chat_jid = ? AND id = ?")
      .run(toJson(media), canonical, messageId);
    return true;
  },

  async getMessage(jid, messageId) {
    const db = await getActiveDb();
    const canonical = resolveAlias(db, jid);
    const row = getMessageRow(db, canonical, messageId);
    return row ? messageFromRow(row) : null;
  },

  async findMessageById(messageId) {
    const db = await getActiveDb();
    const row = db.sql.prepare("SELECT * FROM messages WHERE id = ? LIMIT 1").get(messageId) as
      | MessageRow
      | undefined;
    return row ? { chatJid: row.chat_jid, message: messageFromRow(row) } : null;
  },
};

/** Import-time seam: whole-chat tier against an explicit handle. */
export const internal = { loadChatFrom, saveChatTo, resolveAlias };
