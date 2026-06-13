import fs from "node:fs";
import path from "node:path";
import { getLogger } from "../logger.js";
import { accountDbFile, dataDir, getActiveAccount } from "./paths.js";
import { openSqlite, type SqlDatabase } from "./sqlite.js";

/**
 * Per-account SQLite database (`accounts/<id>/chats.db`): people (accounts +
 * their jids), chats, participants, messages, reactions, the Baileys auth
 * store and a capped ring buffer of raw connection events for debugging.
 *
 * Identity model: an `accounts` row is a person/business; `account_jids` maps
 * every address they're known by (`@s.whatsapp.net`, `@lid`) onto that row.
 * Everything else references accounts by surrogate id, so a lid-addressed and
 * a phone-addressed sighting of the same person can never split into two
 * identities or two individual chats.
 *
 * Media blobs and the rotating log file deliberately stay on the filesystem.
 */

const SCHEMA_VERSION = 3;

const SCHEMA: string[] = [
  `CREATE TABLE IF NOT EXISTS accounts (
    id INTEGER PRIMARY KEY,
    phone_number TEXT,
    push_name TEXT,
    contact_name TEXT,
    verified_name TEXT
  )`,
  // Sentinel for messages whose sender is unknown (tombstones, malformed
  // keys). Never merged, never displayed; rowid allocation continues at 1.
  `INSERT OR IGNORE INTO accounts (id) VALUES (0)`,
  `CREATE TABLE IF NOT EXISTS account_jids (
    jid TEXT PRIMARY KEY,
    account_id INTEGER NOT NULL REFERENCES accounts(id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_account_jids_account ON account_jids(account_id)`,
  `CREATE TABLE IF NOT EXISTS chats (
    id INTEGER PRIMARY KEY,
    jid TEXT NOT NULL UNIQUE,
    type TEXT NOT NULL,
    peer_account_id INTEGER REFERENCES accounts(id),
    group_subject TEXT,
    archived INTEGER NOT NULL DEFAULT 0,
    last_activity INTEGER NOT NULL DEFAULT 0,
    unread_count INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_chats_peer
     ON chats(peer_account_id) WHERE peer_account_id IS NOT NULL`,
  `CREATE TABLE IF NOT EXISTS participants (
    chat_id INTEGER NOT NULL REFERENCES chats(id),
    account_id INTEGER NOT NULL REFERENCES accounts(id),
    is_admin INTEGER,
    PRIMARY KEY (chat_id, account_id)
  )`,
  // WhatsApp message ids are only unique per sender, hence the triple PK.
  // sender_account_id is NOT NULL on purpose: composite PKs on rowid tables
  // admit NULLs and treat them as distinct, which would silently break
  // outbound-row uniqueness — outbound rows use the self account, unknown
  // senders the 0 sentinel.
  `CREATE TABLE IF NOT EXISTS messages (
    chat_id INTEGER NOT NULL,
    id TEXT NOT NULL,
    sender_account_id INTEGER NOT NULL,
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
    PRIMARY KEY (chat_id, id, sender_account_id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_messages_chat_ts ON messages(chat_id, timestamp)`,
  `CREATE INDEX IF NOT EXISTS idx_messages_id ON messages(id)`,
  `CREATE TABLE IF NOT EXISTS reactions (
    chat_id INTEGER NOT NULL,
    message_id TEXT NOT NULL,
    sender_account_id INTEGER NOT NULL,
    emoji TEXT NOT NULL,
    PRIMARY KEY (chat_id, message_id, sender_account_id)
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

/** Indexes added after a schema version shipped. `SCHEMA` only runs on fresh
 * DBs (no migration path), so these are applied on every open — additive and
 * idempotent, no version bump needed. */
const ADDITIVE_INDEXES = [
  `CREATE INDEX IF NOT EXISTS idx_messages_sender ON messages(sender_account_id)`,
  `CREATE INDEX IF NOT EXISTS idx_participants_account ON participants(account_id)`,
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
  const row = sql.prepare<{ user_version: number }>("PRAGMA user_version").get()!;
  if (row.user_version >= SCHEMA_VERSION) return;
  if (row.user_version === 2) {
    sql.exec("ALTER TABLE chats ADD COLUMN unread_count INTEGER NOT NULL DEFAULT 0");
    sql.exec("PRAGMA user_version = 3");
    return;
  }
  // No migration path exists from older schemas, and we never delete chat
  // data ourselves — the user must wipe the data dir and re-link the device.
  if (row.user_version > 0) {
    throw new Error(
      `chats.db uses schema v${row.user_version}, but this build needs v${SCHEMA_VERSION} ` +
        `and there is no migration — delete the data directory (${dataDir()}) and re-link your device`,
    );
  }
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
  for (const stmt of ADDITIVE_INDEXES) sql.exec(stmt);

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
