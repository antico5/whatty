import { getLogger } from "../logger.js";
import type { AccountDb } from "./db.js";
import { getActiveAccount } from "./paths.js";

/**
 * The accounts entity store — persistent identity for every person/business
 * we've ever seen (not to be confused with `accounts.ts`, which manages the
 * app's own linked-login accounts).
 *
 * An account row is the single place names land: every sighting of a push
 * name, saved-contact name or verified business name UPSERTs onto the row,
 * whenever it arrives and in whatever address space. `account_jids` maps all
 * of a person's addresses (`@s.whatsapp.net`, `@lid`) onto one row, so the
 * lid↔phone pairing is one well-defined account merge instead of chat folding.
 */

/** Sentinel account for unknown senders (tombstones, malformed keys). Never merged, never displayed. */
export const UNKNOWN_ACCOUNT_ID = 0;

export interface AccountRecord {
  id: number;
  phoneNumber: string | null;
  pushName: string | null;
  contactName: string | null;
  verifiedName: string | null;
  /** Every jid this account is known by. */
  jids: string[];
}

/** One sighting of a person: the jids known to be theirs plus any name fields the event carried. */
export interface AccountObservation {
  jids: (string | null | undefined)[];
  /** Peer's self-chosen profile name. Latest sighting wins; never erased. */
  pushName?: string | null;
  /** The user's own saved address-book name — the "is a contact" bit. */
  contactName?: string | null;
  /** WhatsApp-verified business name. */
  verifiedName?: string | null;
}

/** WhatsApp's official service account — announcements etc. It has no contact
 * record; WA Web hardcodes its name the same way. */
const WHATSAPP_SERVICE_JID = "0@s.whatsapp.net";

/** Derive `+<number>` from a phone jid. Only `@s.whatsapp.net` carries a real
 * number — `@lid` decodes to an opaque routing id, never a dialable number. */
function phoneFromJid(jid: string): string | null {
  if (!jid.endsWith("@s.whatsapp.net")) return null;
  const user = jid.split("@")[0]?.split(":")[0];
  if (!user || user === "0") return null;
  return `+${user}`;
}

interface AccountRow {
  id: number;
  phone_number: string | null;
  push_name: string | null;
  contact_name: string | null;
  verified_name: string | null;
}

function jidsOf(db: AccountDb, accountId: number): string[] {
  const rows = db.sql
    .prepare("SELECT jid FROM account_jids WHERE account_id = ? ORDER BY rowid")
    .all(accountId) as { jid: string }[];
  return rows.map((r) => r.jid);
}

function recordFromRow(db: AccountDb, row: AccountRow): AccountRecord {
  return {
    id: row.id,
    phoneNumber: row.phone_number,
    pushName: row.push_name,
    contactName: row.contact_name,
    verifiedName: row.verified_name,
    jids: jidsOf(db, row.id),
  };
}

export function accountById(db: AccountDb, id: number): AccountRecord | null {
  const row = db.sql.prepare("SELECT * FROM accounts WHERE id = ?").get(id) as AccountRow | undefined;
  return row ? recordFromRow(db, row) : null;
}

export function accountByJid(db: AccountDb, jid: string): AccountRecord | null {
  const row = db.sql
    .prepare("SELECT a.* FROM account_jids aj JOIN accounts a ON a.id = aj.account_id WHERE aj.jid = ?")
    .get(jid) as AccountRow | undefined;
  return row ? recordFromRow(db, row) : null;
}

/** The account's best display/send address: its phone jid when known, else its first-seen jid. */
export function preferredJid(account: AccountRecord): string | null {
  return account.jids.find((j) => j.endsWith("@s.whatsapp.net")) ?? account.jids[0] ?? null;
}

/**
 * Fold `loserId` into `winnerId`: two account rows turned out to be the same
 * person (a lid↔phone pairing arrived). Re-points every reference; colliding
 * message/reaction rows are the same logical event seen under two addresses,
 * so keeping one is dedupe — the single sanctioned exception to the
 * never-delete-chat-data invariant. If both accounts accumulated an
 * individual chat, the loser's chat is folded into the winner's.
 */
function mergeAccounts(db: AccountDb, winnerId: number, loserId: number): void {
  // Names: the winner's non-null fields win; the loser only fills gaps.
  db.sql
    .prepare(
      `UPDATE accounts SET
         phone_number  = COALESCE(phone_number,  (SELECT phone_number  FROM accounts WHERE id = ?2)),
         push_name     = COALESCE(push_name,     (SELECT push_name     FROM accounts WHERE id = ?2)),
         contact_name  = COALESCE(contact_name,  (SELECT contact_name  FROM accounts WHERE id = ?2)),
         verified_name = COALESCE(verified_name, (SELECT verified_name FROM accounts WHERE id = ?2))
       WHERE id = ?1`,
    )
    .run(winnerId, loserId);

  db.sql.prepare("UPDATE account_jids SET account_id = ?1 WHERE account_id = ?2").run(winnerId, loserId);

  // Group membership: coalesce is_admin onto colliding winner rows, then move
  // the loser's remaining rows over and drop the leftovers.
  db.sql
    .prepare(
      `UPDATE participants SET is_admin = COALESCE(is_admin,
         (SELECT p2.is_admin FROM participants p2
          WHERE p2.chat_id = participants.chat_id AND p2.account_id = ?2))
       WHERE account_id = ?1`,
    )
    .run(winnerId, loserId);
  db.sql.prepare("UPDATE OR IGNORE participants SET account_id = ?1 WHERE account_id = ?2").run(winnerId, loserId);
  db.sql.prepare("DELETE FROM participants WHERE account_id = ?").run(loserId);

  db.sql.prepare("UPDATE OR REPLACE messages SET sender_account_id = ?1 WHERE sender_account_id = ?2").run(winnerId, loserId);
  db.sql.prepare("UPDATE OR REPLACE reactions SET sender_account_id = ?1 WHERE sender_account_id = ?2").run(winnerId, loserId);

  // Individual chats are UNIQUE per peer: when both accounts have one, fold
  // the loser's chat into the winner's.
  const chatOf = db.sql.prepare("SELECT id, jid FROM chats WHERE peer_account_id = ?");
  const winnerChat = chatOf.get(winnerId) as { id: number; jid: string } | undefined;
  const loserChat = chatOf.get(loserId) as { id: number; jid: string } | undefined;
  if (winnerChat && loserChat) {
    db.sql.prepare("UPDATE OR REPLACE messages SET chat_id = ?1 WHERE chat_id = ?2").run(winnerChat.id, loserChat.id);
    db.sql.prepare("UPDATE OR REPLACE reactions SET chat_id = ?1 WHERE chat_id = ?2").run(winnerChat.id, loserChat.id);
    db.sql.prepare("UPDATE OR IGNORE participants SET chat_id = ?1 WHERE chat_id = ?2").run(winnerChat.id, loserChat.id);
    db.sql.prepare("DELETE FROM participants WHERE chat_id = ?").run(loserChat.id);
    db.sql
      .prepare(
        `UPDATE chats SET
           last_activity = MAX(last_activity, (SELECT last_activity FROM chats WHERE id = ?2)),
           archived      = MAX(archived,      (SELECT archived      FROM chats WHERE id = ?2))
         WHERE id = ?1`,
      )
      .run(winnerChat.id, loserChat.id);
    db.sql.prepare("DELETE FROM chats WHERE id = ?").run(loserChat.id);
    getLogger().info(
      { winnerChat: winnerChat.jid, loserChat: loserChat.jid },
      "folded duplicate individual chat during account merge",
    );
  } else if (loserChat) {
    db.sql.prepare("UPDATE chats SET peer_account_id = ?1 WHERE id = ?2").run(winnerId, loserChat.id);
  }

  db.sql.prepare("DELETE FROM accounts WHERE id = ?").run(loserId);
}

/**
 * The one write primitive for account rows: land an observation, creating the
 * account, attaching newly-seen jids and merging accounts when the observation
 * proves two existing rows are the same person. Returns the account id, or
 * `UNKNOWN_ACCOUNT_ID` when the observation carries no usable jid.
 *
 * Field semantics: `pushName` latest-sighting-wins (never erased);
 * `contactName`/`verifiedName` only fill gaps; `phone_number` is derived from
 * any phone jid in the set.
 */
export function ensureAccount(db: AccountDb, obs: AccountObservation): number {
  const jids = [...new Set(obs.jids.filter((j): j is string => Boolean(j)))];
  if (jids.length === 0) return UNKNOWN_ACCOUNT_ID;

  return db.transaction(() => {
    const placeholders = jids.map(() => "?").join(", ");
    const matches = db.sql
      .prepare(`SELECT DISTINCT account_id FROM account_jids WHERE jid IN (${placeholders}) ORDER BY account_id`)
      .all(...jids) as { account_id: number }[];

    let id: number;
    if (matches.length === 0) {
      id = Number(db.sql.prepare("INSERT INTO accounts DEFAULT VALUES").run().lastInsertRowid);
    } else {
      // The observation links several existing accounts — they're one person.
      // Survivor: the account holding a phone jid (its chat row is the one
      // keyed canonically), lower id as tie-break.
      const ids = matches.map((m) => m.account_id);
      const phoneOwner = db.sql
        .prepare(
          `SELECT account_id FROM account_jids
           WHERE account_id IN (${ids.map(() => "?").join(", ")}) AND jid LIKE '%@s.whatsapp.net'
           ORDER BY account_id LIMIT 1`,
        )
        .get(...ids) as { account_id: number } | undefined;
      id = phoneOwner?.account_id ?? ids[0]!;
      for (const other of ids) {
        if (other !== id) mergeAccounts(db, id, other);
      }
    }

    const attach = db.sql.prepare("INSERT OR IGNORE INTO account_jids (jid, account_id) VALUES (?, ?)");
    for (const jid of jids) attach.run(jid, id);

    const phoneNumber = jids.map(phoneFromJid).find((p) => p != null) ?? null;
    db.sql
      .prepare(
        `UPDATE accounts SET
           push_name     = COALESCE(?, push_name),
           contact_name  = COALESCE(contact_name, ?),
           verified_name = COALESCE(verified_name, ?),
           phone_number  = COALESCE(phone_number, ?)
         WHERE id = ?`,
      )
      .run(obs.pushName ?? null, obs.contactName ?? null, obs.verifiedName ?? null, phoneNumber, id);

    rekeyPeerChat(db, id);

    return id;
  });
}

/**
 * Keep an individual chat keyed by its peer's phone jid: a chat created while
 * the peer was only known by `@lid` is re-keyed as soon as a pairing attaches
 * the phone jid, regardless of which event delivered the pairing.
 */
function rekeyPeerChat(db: AccountDb, accountId: number): void {
  const chat = db.sql.prepare("SELECT id, jid FROM chats WHERE peer_account_id = ?").get(accountId) as
    | { id: number; jid: string }
    | undefined;
  if (!chat || chat.jid.endsWith("@s.whatsapp.net")) return;
  const phone = db.sql
    .prepare("SELECT jid FROM account_jids WHERE account_id = ? AND jid LIKE '%@s.whatsapp.net' LIMIT 1")
    .get(accountId) as { jid: string } | undefined;
  if (!phone || phone.jid === chat.jid) return;
  db.sql.prepare("UPDATE OR IGNORE chats SET jid = ? WHERE id = ?").run(phone.jid, chat.id);
  getLogger().info({ from: chat.jid, to: phone.jid }, "re-keyed individual chat to phone jid");
}

/** Per-DB-file cache: the self account is looked up once per session. */
const selfIds = new Map<string, number>();

/**
 * The account row for ourselves — outbound messages reference it as sender.
 * The active account id *is* our own phone jid (it names the account dir);
 * our `@lid` joins the row at connection open like any other pairing.
 */
export function selfAccountId(db: AccountDb): number {
  const cached = selfIds.get(db.file);
  if (cached != null) return cached;
  const ownJid = getActiveAccount();
  if (!ownJid) return UNKNOWN_ACCOUNT_ID;
  const id = ensureAccount(db, { jids: [ownJid] });
  selfIds.set(db.file, id);
  return id;
}

/**
 * The single label rule: saved-contact name, else verified business name,
 * else push name with the phone in parens, else the phone, else the raw jid.
 */
export function senderLabel(account: AccountRecord | null, selfId: number): string {
  if (!account) return "Unknown";
  if (account.id === selfId && selfId !== UNKNOWN_ACCOUNT_ID) return "You";
  if (account.contactName) return account.contactName;
  if (account.verifiedName) return account.verifiedName;
  const phone = account.phoneNumber;
  if (account.pushName) return phone ? `${account.pushName} (${phone})` : account.pushName;
  return phone ?? preferredJid(account) ?? "Unknown";
}

/**
 * What an individual chat is titled by: only trustworthy names qualify (saved
 * contact or WhatsApp-verified business) — push names are deliberately
 * excluded so non-contacts render as "Not Contact", never as whatever the
 * peer typed into their profile. Null means "Not Contact" downstream.
 */
export function chatDisplayName(account: AccountRecord | null): string | null {
  if (!account) return null;
  if (account.jids.includes(WHATSAPP_SERVICE_JID)) return "WhatsApp";
  return account.contactName ?? account.verifiedName ?? null;
}
