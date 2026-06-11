import fs from "node:fs";
import path from "node:path";
import { getLogger } from "../logger.js";
import { accountDbFile, getActiveAccount } from "./paths.js";
import { openSqlite, type SqlDatabase } from "./sqlite.js";

/**
 * Per-account SQLite database (`accounts/<id>/chats.db`): chats, messages,
 * reactions, participants, lid/phone aliases, the Baileys auth store and a
 * capped ring buffer of raw connection events for debugging.
 *
 * Media blobs and the rotating log file deliberately stay on the filesystem.
 */

const SCHEMA_VERSION = 1;

const SCHEMA: string[] = [
  `CREATE TABLE IF NOT EXISTS chats (
    jid TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    display_name TEXT,
    phone_number TEXT,
    group_subject TEXT,
    archived INTEGER NOT NULL DEFAULT 0,
    last_activity INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE TABLE IF NOT EXISTS aliases (
    alias_jid TEXT PRIMARY KEY,
    chat_jid TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS participants (
    chat_jid TEXT NOT NULL,
    jid TEXT NOT NULL,
    display_name TEXT,
    is_admin INTEGER,
    PRIMARY KEY (chat_jid, jid)
  )`,
  `CREATE TABLE IF NOT EXISTS messages (
    chat_jid TEXT NOT NULL,
    id TEXT NOT NULL,
    sender_jid TEXT,
    sender_name TEXT,
    direction TEXT NOT NULL,
    timestamp INTEGER NOT NULL,
    type TEXT NOT NULL,
    text TEXT,
    delivery_status TEXT,
    deleted_at INTEGER,
    edited INTEGER NOT NULL DEFAULT 0,
    media TEXT,
    quoted TEXT,
    raw TEXT,
    PRIMARY KEY (chat_jid, id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_messages_chat_ts ON messages(chat_jid, timestamp)`,
  `CREATE INDEX IF NOT EXISTS idx_messages_id ON messages(id)`,
  `CREATE TABLE IF NOT EXISTS reactions (
    chat_jid TEXT NOT NULL,
    message_id TEXT NOT NULL,
    sender TEXT NOT NULL,
    emoji TEXT NOT NULL,
    PRIMARY KEY (chat_jid, message_id, sender)
  )`,
  `CREATE TABLE IF NOT EXISTS auth_kv (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS events (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    ts INTEGER NOT NULL,
    source TEXT NOT NULL,
    event_type TEXT NOT NULL,
    jid TEXT,
    payload TEXT
  )`,
];

const EVENTS_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const EVENTS_MAX_ROWS = 100_000;
const EVENT_PAYLOAD_MAX_CHARS = 64_000;

export interface AccountDb {
  readonly file: string;
  readonly sql: SqlDatabase;
  /** Run `fn` inside a transaction (no nesting — SQLite has a single write txn). */
  transaction<T>(fn: () => T): T;
  close(): void;
}

function migrate(sql: SqlDatabase): void {
  const row = sql.prepare("PRAGMA user_version").get() as { user_version: number };
  if (row.user_version >= SCHEMA_VERSION) return;
  for (const stmt of SCHEMA) sql.exec(stmt);
  sql.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
}

/** Open (creating if needed) an account's database, independent of the active account. */
export async function openAccountDb(accountId: string): Promise<AccountDb> {
  const file = accountDbFile(accountId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const sql = await openSqlite(file);
  sql.exec("PRAGMA journal_mode = WAL");
  sql.exec("PRAGMA synchronous = NORMAL");
  migrate(sql);

  let inTx = false;
  return {
    file,
    sql,
    transaction<T>(fn: () => T): T {
      if (inTx) return fn();
      inTx = true;
      sql.exec("BEGIN");
      try {
        const result = fn();
        sql.exec("COMMIT");
        return result;
      } catch (err) {
        try {
          sql.exec("ROLLBACK");
        } catch {
          // connection-level failure — nothing more to roll back
        }
        throw err;
      } finally {
        inTx = false;
      }
    },
    close: () => sql.close(),
  };
}

export function accountDbExists(accountId: string): boolean {
  return fs.existsSync(accountDbFile(accountId));
}

/**
 * Cached handle for the active account's DB, keyed by file path so switching
 * accounts (or tests switching data dirs) transparently reopens.
 */
let active: AccountDb | null = null;

export async function getActiveDb(): Promise<AccountDb> {
  const accountId = getActiveAccount();
  if (accountId === null) throw new Error("no active account — cannot open its database");
  const file = accountDbFile(accountId);
  if (active && active.file !== file) {
    active.close();
    active = null;
  }
  if (!active) active = await openAccountDb(accountId);
  return active;
}

export function closeActiveDb(): void {
  active?.close();
  active = null;
}

/** Drop expired/excess rows from the events ring buffer. */
export function pruneEvents(db: AccountDb): void {
  db.sql.prepare("DELETE FROM events WHERE ts < ?").run(Date.now() - EVENTS_MAX_AGE_MS);
  db.sql
    .prepare(
      "DELETE FROM events WHERE seq <= (SELECT MAX(seq) FROM events) - ?",
    )
    .run(EVENTS_MAX_ROWS);
}

/**
 * Append a raw connection event to the debugging ring buffer. Fire-and-forget:
 * never throws, no-ops when no account DB is active (e.g. during pairing).
 * Buffers inside the payload are compacted to short base64 markers.
 */
export function recordEvent(eventType: string, jid: string | null, payload: unknown): void {
  if (!active) return;
  let json: string | null;
  try {
    json = JSON.stringify(payload, (_k, v: unknown) => {
      if (v instanceof Uint8Array) return `<bytes:${v.length}>`;
      if (typeof v === "bigint") return v.toString();
      return v;
    });
  } catch {
    json = String(payload);
  }
  if (json && json.length > EVENT_PAYLOAD_MAX_CHARS) {
    json = `${json.slice(0, EVENT_PAYLOAD_MAX_CHARS)}…(truncated)`;
  }
  try {
    active.sql
      .prepare("INSERT INTO events (ts, source, event_type, jid, payload) VALUES (?, ?, ?, ?, ?)")
      .run(Date.now(), "baileys", eventType, jid, json ?? null);
  } catch (err) {
    getLogger().warn({ err, eventType }, "failed to record event");
  }
}
