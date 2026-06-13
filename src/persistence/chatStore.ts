import { getLogger } from "../logger.js";
import {
  chatTypeOf,
  type Chat,
  type DeliveryStatus,
  type GroupParticipant,
  type MediaRef,
  type Message,
  type QuotedRef,
} from "../types/index.js";
import { mapWAMessage, mentionedJidsOf, rawWAMessage } from "../whatsapp/mappers.js";
import { advanceDeliveryStatus, mergeChatMeta, tombstone, upsertChat } from "./reconcile.js";
import { getActiveDb, type AccountDb } from "./db.js";
import {
  accountById,
  accountByJid,
  chatDisplayName,
  ensureAccount,
  preferredJid,
  selfAccountId,
  senderLabel,
  UNKNOWN_ACCOUNT_ID,
  type AccountObservation,
  type AccountRecord,
} from "./peerStore.js";

/**
 * SQLite-backed chat store. Two API tiers:
 *
 * - The whole-chat tier (`loadChat`/`saveChat`/`loadAllChats`) keeps the
 *   pre-SQLite contract: a `Chat` aggregate in, a `Chat` aggregate out.
 *   `saveChat` is a full row replacement — correct but write-amplified, so
 *   it's reserved for infrequent paths (sending, import).
 *
 * - `chatOps` is the targeted tier used by live ingestion: each operation
 *   touches only the rows it needs (a receipt updates one column of one row
 *   instead of rewriting a 3,000-message chat).
 *
 * The public API stays keyed by jid strings; internally every entry point
 * resolves the jid to a chat row once — individual chats are found through
 * `account_jids` → `peer_account_id`, so a `@lid` jid and a phone jid hit the
 * same chat without any folding.
 *
 * Name policy: this module NEVER writes name fields from aggregates. Loaded
 * aggregates carry *resolved labels* in `senderName`/participant
 * `displayName`, so writing them back would poison the accounts table with
 * formatted strings. All name sightings flow exclusively through
 * `chatOps.observeAccounts` (called by ingest with raw event data).
 */

interface ChatRow {
  id: number;
  jid: string;
  type: string;
  peer_account_id: number | null;
  group_subject: string | null;
  archived: number;
  last_activity: number;
  unread_count: number;
}

interface MessageRow {
  chat_id: number;
  id: string;
  sender_account_id: number;
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

/** Shape of the `messages.quoted` JSON column. */
interface PersistedQuoted {
  messageId: string;
  senderAccountId: number | null;
  snippet: string;
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

const DIRECTIONS: readonly Message["direction"][] = ["inbound", "outbound"];
const MESSAGE_TYPES: readonly Message["type"][] = [
  "text", "image", "video", "audio", "document", "sticker", "viewOnce", "other",
];
const DELIVERY_STATUSES: readonly DeliveryStatus[] = ["pending", "sent", "delivered", "read", "failed"];

/** Validate a DB string against its expected union — unexpected values degrade to `fallback` with a warning. */
function narrow<T extends string, F extends T | null>(value: string, allowed: readonly T[], fallback: F): T | F {
  if ((allowed as readonly string[]).includes(value)) return value as T;
  getLogger().warn({ value, allowed }, "unexpected enum column value — using fallback");
  return fallback;
}

// ── read context ─────────────────────────────────────────────────────────────

/**
 * Per-load context: caches account rows so a 500-message group does one DB
 * lookup per distinct sender, not per message. Shared across messages, quoted
 * refs, reactions and participants of one load (or all chats in loadAllChats).
 */
interface LoadCtx {
  db: AccountDb;
  selfId: number;
  accounts: Map<number, AccountRecord | null>;
}

function makeCtx(db: AccountDb): LoadCtx {
  return { db, selfId: selfAccountId(db), accounts: new Map() };
}

function accountOf(ctx: LoadCtx, id: number): AccountRecord | null {
  if (id === UNKNOWN_ACCOUNT_ID) return null;
  let account = ctx.accounts.get(id);
  if (account === undefined) {
    account = accountById(ctx.db, id);
    ctx.accounts.set(id, account);
  }
  return account;
}

function quotedFromJson(ctx: LoadCtx, json: string | null): QuotedRef | null {
  const persisted = parseJson<PersistedQuoted>(json);
  if (!persisted) return null;
  const account = persisted.senderAccountId != null ? accountOf(ctx, persisted.senderAccountId) : null;
  return {
    messageId: persisted.messageId,
    sender: account ? senderLabel(account, ctx.selfId) : null,
    senderAccountId: persisted.senderAccountId,
    snippet: persisted.snippet,
  };
}

function messageFromRow(
  ctx: LoadCtx,
  row: MessageRow,
  isGroup: boolean,
  reactions?: { emoji: string; sender: string }[],
): Message {
  const sender = accountOf(ctx, row.sender_account_id);
  const message: Message = {
    id: row.id,
    senderJid: sender ? preferredJid(sender) : null,
    // Group inbound renders a sender line — resolve the full label; otherwise
    // surface the bare push name (parity with what the old schema stored).
    senderName:
      row.direction === "inbound" && sender
        ? isGroup
          ? senderLabel(sender, ctx.selfId)
          : (sender.pushName ?? null)
        : null,
    direction: narrow(row.direction, DIRECTIONS, "inbound"),
    timestamp: row.timestamp,
    type: narrow(row.type, MESSAGE_TYPES, "other"),
    text: row.text,
    media: parseJson<MediaRef>(row.media),
    quoted: quotedFromJson(ctx, row.quoted),
    deliveryStatus: row.delivery_status == null ? null : narrow(row.delivery_status, DELIVERY_STATUSES, null),
    deleted: row.deleted_at != null,
    deletedAt: row.deleted_at,
    raw: parseJson(row.raw),
  };
  if (row.edited) message.edited = true;
  if (reactions && reactions.length > 0) message.reactions = reactions;
  if (isGroup && row.text?.includes("@")) {
    // `@`-mention digits in group text reference jids (often `@lid`), not phone
    // numbers — resolve each mentioned jid to its account's label so the UI can
    // substitute the tokens. Unresolvable jids are omitted (token renders raw).
    const mentions = mentionedJidsOf(message).flatMap((jid) => {
      const account = accountByJid(ctx.db, jid);
      return account ? [{ jid, label: senderLabel(account, ctx.selfId) }] : [];
    });
    if (mentions.length > 0) message.mentions = mentions;
  }
  return message;
}

function participantsOf(ctx: LoadCtx, chatId: number): GroupParticipant[] {
  const rows = ctx.db.sql
    .prepare<{ account_id: number; is_admin: number | null }>(
      "SELECT account_id, is_admin FROM participants WHERE chat_id = ? ORDER BY rowid",
    )
    .all(chatId);
  return rows.map((r) => {
    const account = accountOf(ctx, r.account_id);
    // A participant whose account has no phone jid surfaces as `@lid` — the
    // store's cue (used by the app store) to refresh group metadata.
    const p: GroupParticipant = {
      jid: (account && preferredJid(account)) ?? `${r.account_id}`,
      displayName: account ? (account.contactName ?? account.verifiedName ?? account.pushName) : null,
    };
    if (r.is_admin != null) p.isAdmin = r.is_admin !== 0;
    return p;
  });
}

function reactionsByMessage(ctx: LoadCtx, chatId: number): Map<string, { emoji: string; sender: string }[]> {
  const rows = ctx.db.sql
    .prepare<{ message_id: string; sender_account_id: number; emoji: string }>(
      "SELECT message_id, sender_account_id, emoji FROM reactions WHERE chat_id = ? ORDER BY rowid",
    )
    .all(chatId);
  const byId = new Map<string, { emoji: string; sender: string }[]>();
  for (const r of rows) {
    const account = accountOf(ctx, r.sender_account_id);
    const sender = (account && preferredJid(account)) ?? `${r.sender_account_id}`;
    const list = byId.get(r.message_id) ?? [];
    list.push({ emoji: r.emoji, sender });
    byId.set(r.message_id, list);
  }
  return byId;
}

function chatFromRow(ctx: LoadCtx, row: ChatRow, participants: GroupParticipant[], messages: Message[]): Chat {
  const peer = row.peer_account_id != null ? accountOf(ctx, row.peer_account_id) : null;
  return {
    jid: row.jid,
    // The type column is written from chatTypeOf at insert; deriving it again
    // beats trusting a string column.
    type: chatTypeOf(row.jid),
    displayName: row.type === "individual" ? chatDisplayName(peer) : null,
    phoneNumber: peer?.phoneNumber ?? null,
    groupSubject: row.group_subject,
    participants,
    archived: row.archived !== 0,
    lastActivity: row.last_activity,
    unreadCount: row.unread_count,
    messages,
  };
}

// ── row resolution ───────────────────────────────────────────────────────────

/**
 * jid → chat row. Group jids match `chats.jid` directly; any jid of an
 * individual peer reaches the same chat through its account.
 */
function resolveChatRow(db: AccountDb, jid: string): ChatRow | null {
  return db.sql
    .prepare<ChatRow>(
      `SELECT * FROM chats WHERE jid = ?1
       UNION ALL
       SELECT c.* FROM account_jids aj JOIN chats c ON c.peer_account_id = aj.account_id
       WHERE aj.jid = ?1
       LIMIT 1`,
    )
    .get(jid) ?? null;
}

function ensureChatRow(db: AccountDb, jid: string): ChatRow {
  const existing = resolveChatRow(db, jid);
  if (existing) return existing;
  if (chatTypeOf(jid) === "group") {
    db.sql.prepare("INSERT OR IGNORE INTO chats (jid, type) VALUES (?, 'group')").run(jid);
  } else {
    const accountId = ensureAccount(db, { jids: [jid] });
    const account = accountById(db, accountId);
    const chatJid = (account && preferredJid(account)) ?? jid;
    db.sql
      .prepare("INSERT OR IGNORE INTO chats (jid, type, peer_account_id) VALUES (?, 'individual', ?)")
      .run(chatJid, accountId);
  }
  const row = resolveChatRow(db, jid);
  if (!row) throw new Error(`failed to ensure chat row for ${jid}`);
  return row;
}

/** The chat row of an account's individual chat, if it exists. */
function peerChatOf(db: AccountDb, accountId: number): { id: number; jid: string } | null {
  return db.sql
    .prepare<{ id: number; jid: string }>("SELECT id, jid FROM chats WHERE peer_account_id = ?")
    .get(accountId) ?? null;
}

/**
 * Group chats whose rendered labels reference this account (as message sender
 * or participant) — they must reload when the account changes, or an open
 * group keeps a stale sender label until its next event (e.g. a lid-only
 * sender whose phone pairing arrives minutes later).
 */
function groupChatsReferencingAccount(db: AccountDb, accountId: number): string[] {
  const rows = db.sql
    .prepare<{ jid: string }>(
      `SELECT DISTINCT c.jid FROM messages m JOIN chats c ON c.id = m.chat_id
         WHERE m.sender_account_id = ?1 AND c.type = 'group'
       UNION
       SELECT c.jid FROM participants p JOIN chats c ON c.id = p.chat_id
         WHERE p.account_id = ?1`,
    )
    .all(accountId);
  return rows.map((r) => r.jid);
}

/** Chat meta + participants, without messages. */
function chatShell(ctx: LoadCtx, row: ChatRow): Chat {
  return chatFromRow(ctx, row, participantsOf(ctx, row.id), []);
}

function loadMessages(ctx: LoadCtx, chatId: number, isGroup: boolean): Message[] {
  const rows = ctx.db.sql
    .prepare<MessageRow>("SELECT * FROM messages WHERE chat_id = ? ORDER BY timestamp, id")
    .all(chatId);
  const reactions = reactionsByMessage(ctx, chatId);
  return rows.map((r) => messageFromRow(ctx, r, isGroup, reactions.get(r.id)));
}

// ── write paths ──────────────────────────────────────────────────────────────

/**
 * Resolve a message's sender to an account id. Outbound rows belong to the
 * self account (the triple PK forbids NULL senders); unknown inbound senders
 * use the 0 sentinel. Deliberately no name observation here — see the module
 * doc on name policy.
 */
function senderAccountIdFor(db: AccountDb, m: Message): number {
  if (m.direction === "outbound") return selfAccountId(db);
  return m.senderJid ? ensureAccount(db, { jids: [m.senderJid] }) : UNKNOWN_ACCOUNT_ID;
}

function quotedToJson(db: AccountDb, quoted: QuotedRef | null): string | null {
  if (!quoted) return null;
  const senderAccountId =
    quoted.senderAccountId ??
    (quoted.sender?.includes("@") ? ensureAccount(db, { jids: [quoted.sender] }) : null);
  const persisted: PersistedQuoted = {
    messageId: quoted.messageId,
    senderAccountId,
    snippet: quoted.snippet,
  };
  return toJson(persisted);
}

function getMessageRow(db: AccountDb, chatId: number, id: string): MessageRow | undefined {
  return db.sql
    .prepare<MessageRow>("SELECT * FROM messages WHERE chat_id = ? AND id = ? LIMIT 1")
    .get(chatId, id);
}

function upsertMessageRow(db: AccountDb, chatId: number, m: Message): void {
  let sender = senderAccountIdFor(db, m);
  const existing = getMessageRow(db, chatId, m.id);
  if (existing && existing.sender_account_id !== sender) {
    if (sender === UNKNOWN_ACCOUNT_ID) {
      // Don't fork a sentinel row next to the known one — write onto it.
      sender = existing.sender_account_id;
    } else if (existing.sender_account_id === UNKNOWN_ACCOUNT_ID) {
      // A tombstone (or other unknown-sender row) learns its real sender.
      db.sql
        .prepare(
          "UPDATE OR REPLACE messages SET sender_account_id = ? WHERE chat_id = ? AND id = ? AND sender_account_id = ?",
        )
        .run(sender, chatId, m.id, UNKNOWN_ACCOUNT_ID);
    }
    // Two distinct real senders sharing an id are genuinely different
    // messages (ids are only unique per sender) — both rows are kept.
  }
  db.sql
    .prepare(
      `INSERT OR REPLACE INTO messages
       (chat_id, id, sender_account_id, direction, timestamp, type, text,
        delivery_status, deleted_at, edited, media, quoted, raw)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      chatId,
      m.id,
      sender,
      m.direction,
      m.timestamp,
      m.type,
      m.text,
      m.deliveryStatus,
      m.deletedAt ?? (m.deleted ? m.timestamp : null),
      m.edited ?? false,
      toJson(m.media),
      quotedToJson(db, m.quoted),
      toJson(m.raw),
    );
  db.sql.prepare("DELETE FROM reactions WHERE chat_id = ? AND message_id = ?").run(chatId, m.id);
  if (m.reactions) {
    const insert = db.sql.prepare(
      "INSERT OR REPLACE INTO reactions (chat_id, message_id, sender_account_id, emoji) VALUES (?, ?, ?, ?)",
    );
    for (const r of m.reactions) {
      const reactor = r.sender.includes("@") ? ensureAccount(db, { jids: [r.sender] }) : UNKNOWN_ACCOUNT_ID;
      insert.run(chatId, m.id, reactor, r.emoji);
    }
  }
}

/** Persist chat-level state and membership. Name fields on the aggregate are ignored by design. */
function writeChatRow(db: AccountDb, chat: Chat): number {
  const row = ensureChatRow(db, chat.jid);
  db.sql
    .prepare("UPDATE chats SET group_subject = ?, archived = ?, last_activity = ?, unread_count = ? WHERE id = ?")
    .run(chat.groupSubject, chat.archived, chat.lastActivity, chat.unreadCount, row.id);
  db.sql.prepare("DELETE FROM participants WHERE chat_id = ?").run(row.id);
  const insert = db.sql.prepare(
    "INSERT OR REPLACE INTO participants (chat_id, account_id, is_admin) VALUES (?, ?, ?)",
  );
  for (const p of chat.participants) {
    const accountId = ensureAccount(db, { jids: [p.jid] });
    if (accountId !== UNKNOWN_ACCOUNT_ID) insert.run(row.id, accountId, p.isAdmin ?? null);
  }
  return row.id;
}

function loadChatFrom(db: AccountDb, jid: string): Chat | null {
  const row = resolveChatRow(db, jid);
  if (!row) return null;
  const ctx = makeCtx(db);
  const shell = chatShell(ctx, row);
  shell.messages = loadMessages(ctx, row.id, shell.type === "group");
  return shell;
}

function saveChatTo(db: AccountDb, chat: Chat): void {
  db.transaction(() => {
    const chatId = writeChatRow(db, chat);
    db.sql.prepare("DELETE FROM reactions WHERE chat_id = ?").run(chatId);
    db.sql.prepare("DELETE FROM messages WHERE chat_id = ?").run(chatId);
    for (const m of chat.messages) upsertMessageRow(db, chatId, m);
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
  const rows = db.sql.prepare<{ jid: string }>("SELECT jid FROM chats").all();
  return rows.map((r) => r.jid);
}

export async function loadAllChats(): Promise<Chat[]> {
  const db = await getActiveDb();
  const chatRows = db.sql.prepare<ChatRow>("SELECT * FROM chats").all();
  // One context for the whole listing — accounts repeat heavily across chats.
  const ctx = makeCtx(db);
  return chatRows.map((row) => {
    const shell = chatShell(ctx, row);
    shell.messages = loadMessages(ctx, row.id, shell.type === "group");
    return shell;
  });
}

/**
 * Re-derive `type`/`text` from the persisted raw envelope for rows saved
 * before the mapper understood their content (e.g. business template/button
 * messages stored as "other" with no text). Runs at startup, idempotent:
 * rows the mapper still can't extract text from are left untouched and
 * re-examined on the next start. Returns the number of repaired rows.
 */
export async function backfillTextFromRaw(): Promise<number> {
  const db = await getActiveDb();
  const rows = db.sql
    .prepare<Pick<MessageRow, "chat_id" | "id" | "sender_account_id" | "raw">>(
      "SELECT chat_id, id, sender_account_id, raw FROM messages WHERE type = 'other' AND text IS NULL AND raw IS NOT NULL",
    )
    .all();
  if (rows.length === 0) return 0;
  const update = db.sql.prepare(
    "UPDATE messages SET type = ?, text = ? WHERE chat_id = ? AND id = ? AND sender_account_id = ?",
  );
  let repaired = 0;
  db.transaction(() => {
    for (const row of rows) {
      const waMsg = rawWAMessage({ raw: parseJson(row.raw) });
      if (!waMsg) continue;
      const mapped = mapWAMessage(waMsg);
      if (mapped.text == null) continue;
      update.run(mapped.type, mapped.text, row.chat_id, row.id, row.sender_account_id);
      repaired += 1;
    }
  });
  return repaired;
}

// ── targeted tier: chatOps ──────────────────────────────────────────────────

export interface FoundMessage {
  chatJid: string;
  message: Message;
}

export interface ChatOps {
  /** Resolve a jid to its chat's preferred jid (lid → phone jid once the pairing is known). */
  resolveChatJid(jid: string): Promise<string>;
  /**
   * Register that `lidJid` and `phoneJid` are the same person. Merges their
   * account rows (and any duplicate individual chats) when they were known
   * separately, and re-keys the chat to the phone jid. Returns the jids of
   * chats whose identity changed (for UI reloads) — empty when the pairing
   * was already known.
   */
  registerJidPair(lidJid: string, phoneJid: string): Promise<string[]>;
  /**
   * Land name/identity sightings on account rows (the only write path for
   * names). Returns the jids of existing individual chats whose peer account
   * actually changed — callers emit chat-updated for those.
   */
  observeAccounts(observations: AccountObservation[]): Promise<string[]>;
  /** Reconcile-merge incoming meta + messages into the chat, touching only the affected message rows. */
  upsertChatMessages(jid: string, meta: Partial<Chat>, incoming: Message[]): Promise<void>;
  /** Merge chat metadata only. Returns false when the chat doesn't exist and `createIfMissing` is off. */
  mergeChatMeta(jid: string, meta: Partial<Chat>, createIfMissing: boolean): Promise<boolean>;
  applyDeliveryReceipt(jid: string, messageId: string, status: DeliveryStatus): Promise<boolean>;
  applyReaction(
    jid: string,
    targetMessageId: string,
    reaction: { emoji: string; senderJid: string },
  ): Promise<boolean>;
  applyMessageEdit(jid: string, messageId: string, text: string): Promise<boolean>;
  /** Mark deleted in place, or create a tombstone (and the chat) when unknown. */
  applyMessageDeletion(jid: string, messageId: string, deletedAt: number): Promise<boolean>;
  /** Attach a downloaded MediaRef; no-op if the message is gone or already has media. */
  setMessageMedia(jid: string, messageId: string, media: MediaRef): Promise<boolean>;
  getMessage(jid: string, messageId: string): Promise<Message | null>;
  /** Indexed cross-chat lookup by message id (replaces the all-chats scan). */
  findMessageById(messageId: string): Promise<FoundMessage | null>;
  /** Reset the chat's unread badge to 0 (after we send read receipts). No-op if the chat is unknown. */
  clearUnread(jid: string): Promise<boolean>;
}

export const chatOps: ChatOps = {
  async resolveChatJid(jid) {
    const db = await getActiveDb();
    const row = resolveChatRow(db, jid);
    if (row) return row.jid;
    const account = accountByJid(db, jid);
    return (account && preferredJid(account)) ?? jid;
  },

  async registerJidPair(lidJid, phoneJid) {
    if (lidJid === phoneJid) return [];
    const db = await getActiveDb();
    return db.transaction(() => {
      const known = accountByJid(db, lidJid);
      if (known && known.jids.includes(phoneJid)) return [];

      // Capture the chats reachable under either address before the merge —
      // a fold can orphan a lid-keyed list entry the UI must reload to drop.
      const affected = new Set<string>();
      for (const jid of [lidJid, phoneJid]) {
        const row = resolveChatRow(db, jid);
        if (row) affected.add(row.jid);
      }

      // ensureAccount merges the two accounts when they were known separately
      // and re-keys the surviving peer chat to the phone jid.
      const accountId = ensureAccount(db, { jids: [lidJid, phoneJid] });
      const chat = peerChatOf(db, accountId);
      if (chat) affected.add(chat.jid);
      for (const jid of groupChatsReferencingAccount(db, accountId)) affected.add(jid);
      return [...affected];
    });
  },

  async observeAccounts(observations) {
    const db = await getActiveDb();
    return db.transaction(() => {
      const affected = new Set<string>();
      for (const obs of observations) {
        const jids = obs.jids.filter((j): j is string => Boolean(j));
        if (jids.length === 0) continue;
        // Chats reachable before the observation: a merge/re-key can orphan a
        // lid-keyed list entry the UI must reload to drop.
        const beforeChats = new Set<string>();
        for (const jid of jids) {
          const row = resolveChatRow(db, jid);
          if (row) beforeChats.add(row.jid);
        }
        const before = accountByJid(db, jids[0]!);
        const accountId = ensureAccount(db, obs);
        if (accountId === UNKNOWN_ACCOUNT_ID) continue;
        const after = accountById(db, accountId);
        const changed =
          !before ||
          before.id !== accountId ||
          before.pushName !== after?.pushName ||
          before.contactName !== after?.contactName ||
          before.verifiedName !== after?.verifiedName ||
          before.phoneNumber !== after?.phoneNumber ||
          before.jids.length !== after?.jids.length;
        if (!changed) continue;
        for (const jid of beforeChats) affected.add(jid);
        const chat = peerChatOf(db, accountId);
        if (chat) affected.add(chat.jid);
        for (const jid of groupChatsReferencingAccount(db, accountId)) affected.add(jid);
      }
      return [...affected];
    });
  },

  async upsertChatMessages(jid, meta, incoming) {
    const db = await getActiveDb();
    db.transaction(() => {
      const row = resolveChatRow(db, jid);
      const ctx = makeCtx(db);
      const shell = row ? chatShell(ctx, row) : null;
      const metaX: Partial<Chat> = { ...meta, jid: row?.jid ?? jid };

      const existing: Message[] = [];
      if (row && incoming.length > 0) {
        const reactions = reactionsByMessage(ctx, row.id);
        const isGroup = row.type === "group";
        for (const m of incoming) {
          const stored = getMessageRow(db, row.id, m.id);
          if (stored) existing.push(messageFromRow(ctx, stored, isGroup, reactions.get(stored.id)));
        }
      }

      const base = shell ? { ...shell, messages: existing } : null;
      const next = upsertChat(base, metaX, incoming);

      const chatId = writeChatRow(db, next);
      for (const m of next.messages) upsertMessageRow(db, chatId, m);
    });
  },

  async mergeChatMeta(jid, meta, createIfMissing) {
    const db = await getActiveDb();
    return db.transaction(() => {
      const row = resolveChatRow(db, jid);
      if (!row && !createIfMissing) return false;
      const shell = row ? chatShell(makeCtx(db), row) : null;
      const next = mergeChatMeta(shell, { ...meta, jid: row?.jid ?? jid });
      writeChatRow(db, next);
      return true;
    });
  },

  async applyDeliveryReceipt(jid, messageId, status) {
    const db = await getActiveDb();
    const row = resolveChatRow(db, jid);
    if (!row) return false;
    // Receipts only ever apply to our own messages; the direction filter also
    // disambiguates the realistic (chat, id) collision under the triple PK.
    const msg = db.sql
      .prepare<{ delivery_status: string | null }>(
        "SELECT delivery_status FROM messages WHERE chat_id = ? AND id = ? AND direction = 'outbound' LIMIT 1",
      )
      .get(row.id, messageId);
    if (!msg) return false;
    const next = advanceDeliveryStatus(msg.delivery_status as DeliveryStatus | null, status);
    if (next === msg.delivery_status) return false;
    db.sql
      .prepare("UPDATE messages SET delivery_status = ? WHERE chat_id = ? AND id = ? AND direction = 'outbound'")
      .run(next, row.id, messageId);
    return true;
  },

  async applyReaction(jid, targetMessageId, reaction) {
    const db = await getActiveDb();
    return db.transaction(() => {
      const row = resolveChatRow(db, jid);
      if (!row || !getMessageRow(db, row.id, targetMessageId)) return false;
      const reactor = ensureAccount(db, { jids: [reaction.senderJid] });
      db.sql
        .prepare("DELETE FROM reactions WHERE chat_id = ? AND message_id = ? AND sender_account_id = ?")
        .run(row.id, targetMessageId, reactor);
      if (reaction.emoji) {
        db.sql
          .prepare("INSERT INTO reactions (chat_id, message_id, sender_account_id, emoji) VALUES (?, ?, ?, ?)")
          .run(row.id, targetMessageId, reactor, reaction.emoji);
      }
      return true;
    });
  },

  async applyMessageEdit(jid, messageId, text) {
    const db = await getActiveDb();
    const row = resolveChatRow(db, jid);
    if (!row) return false;
    const stored = getMessageRow(db, row.id, messageId);
    if (!stored) return false;
    if (stored.edited && stored.text === text) return false;
    db.sql
      .prepare("UPDATE messages SET text = ?, edited = 1 WHERE chat_id = ? AND id = ?")
      .run(text, row.id, messageId);
    return true;
  },

  async applyMessageDeletion(jid, messageId, deletedAt) {
    const db = await getActiveDb();
    return db.transaction(() => {
      const row = ensureChatRow(db, jid);
      const stored = getMessageRow(db, row.id, messageId);
      if (!stored) {
        upsertMessageRow(db, row.id, tombstone(messageId, deletedAt));
        return true;
      }
      if (stored.deleted_at != null) return false;
      db.sql
        .prepare("UPDATE messages SET deleted_at = ? WHERE chat_id = ? AND id = ?")
        .run(deletedAt, row.id, messageId);
      return true;
    });
  },

  async setMessageMedia(jid, messageId, media) {
    const db = await getActiveDb();
    const row = resolveChatRow(db, jid);
    if (!row) return false;
    const stored = getMessageRow(db, row.id, messageId);
    if (!stored || stored.media != null) return false;
    db.sql
      .prepare("UPDATE messages SET media = ? WHERE chat_id = ? AND id = ? AND media IS NULL")
      .run(toJson(media), row.id, messageId);
    return true;
  },

  async getMessage(jid, messageId) {
    const db = await getActiveDb();
    const row = resolveChatRow(db, jid);
    if (!row) return null;
    const stored = getMessageRow(db, row.id, messageId);
    return stored ? messageFromRow(makeCtx(db), stored, row.type === "group") : null;
  },

  async findMessageById(messageId) {
    const db = await getActiveDb();
    const stored = db.sql
      .prepare<MessageRow & { chat_jid: string; chat_type: string }>(
        `SELECT m.*, c.jid AS chat_jid, c.type AS chat_type
         FROM messages m JOIN chats c ON c.id = m.chat_id
         WHERE m.id = ? LIMIT 1`,
      )
      .get(messageId);
    if (!stored) return null;
    return {
      chatJid: stored.chat_jid,
      message: messageFromRow(makeCtx(db), stored, stored.chat_type === "group"),
    };
  },

  async clearUnread(jid) {
    const db = await getActiveDb();
    const row = resolveChatRow(db, jid);
    if (!row || row.unread_count === 0) return false;
    db.sql.prepare("UPDATE chats SET unread_count = 0 WHERE id = ?").run(row.id);
    return true;
  },
};
