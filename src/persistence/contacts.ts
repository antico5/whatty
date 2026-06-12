/**
 * Sender label resolver — the single source of truth for turning a raw
 * `senderJid` + push name into the human-readable label shown in group messages
 * and quoted-reply lines (req 4 & 5).
 *
 * Resolution rules (in priority order):
 * 1. If the sender's individual chat row has a saved-contact name → return it.
 * 2. Push name known → `"<pushName> (<phone>)"`.
 * 3. Phone extractable from JID → `"(<phone>)"`.
 * 4. Last resort → the raw JID string.
 *
 * The caller provides a `Map<string, string>` cache that lives for one chat
 * load — so a 500-message group does one DB lookup per distinct sender, not
 * per message.
 */

import type { AccountDb } from "./db.js";

interface ChatNameRow {
  display_name: string | null;
  phone_number: string | null;
}

function resolveAlias(db: AccountDb, jid: string): string {
  const row = db.sql.prepare("SELECT chat_jid FROM aliases WHERE alias_jid = ?").get(jid) as
    | { chat_jid: string }
    | undefined;
  return row?.chat_jid ?? jid;
}

function phoneFromJid(jid: string): string | null {
  if (!jid.endsWith("@s.whatsapp.net")) return null;
  const user = jid.split("@")[0];
  return user ? `+${user}` : null;
}

/**
 * Resolve the human-readable label for a group message sender or a quoted
 * message's sender (req 4 & 5).
 *
 * @param senderJid  Raw sender JID as stored in `messages.sender_jid` or
 *                   `QuotedRef.sender`.
 * @param pushName   Push name as stored in `messages.sender_name` (may be null;
 *                   not available for quoted refs — pass null).
 * @param db         Active account database handle.
 * @param cache      Per-load cache; keyed on the **canonical** JID + push name
 *                   to avoid redundant lookups across messages from the same
 *                   sender. Pass the same map instance for all messages in one
 *                   chat load.
 * @param ownJid     The active account's own JID. When the resolved canonical
 *                   JID matches this, returns "You" immediately (quoted-reply
 *                   messages addressed to ourselves).
 */
export function resolveSenderLabel(
  senderJid: string,
  pushName: string | null,
  db: AccountDb,
  cache: Map<string, string> = new Map(),
  ownJid?: string | null,
): string {
  // Normalize through the alias table (e.g. @lid → @s.whatsapp.net).
  const canonical = resolveAlias(db, senderJid);

  // Own messages quoted back to us — show "You" rather than our phone number.
  if (ownJid && canonical === ownJid) return "You";

  // Key the cache on the push name too: a message that carries one must not be
  // served a label cached from an earlier message of the same sender without one.
  const cacheKey = `${canonical}\0${pushName ?? ""}`;
  const cached = cache.get(cacheKey);
  if (cached !== undefined) return cached;

  // Look up the individual chat row for this sender.
  const row = db.sql
    .prepare("SELECT display_name, phone_number FROM chats WHERE jid = ? AND type = 'individual'")
    .get(canonical) as ChatNameRow | undefined;

  let label: string;
  if (row?.display_name) {
    // Saved contact — use the contact name alone.
    label = row.display_name;
  } else {
    // Not a saved contact — combine push name + phone number.
    // For @lid senders with no push name in the message (common in history-
    // synced group messages), fall back to the display_name stored in the
    // participants table from group metadata sync. Participant rows may be
    // keyed by either address space, so match the raw and canonical jid.
    const effectivePushName =
      pushName ??
      (db.sql
        .prepare(
          "SELECT display_name FROM participants WHERE jid IN (?, ?) AND display_name IS NOT NULL LIMIT 1",
        )
        .get(senderJid, canonical) as { display_name: string } | undefined)?.display_name ??
      null;
    const phone = row?.phone_number ?? phoneFromJid(canonical);
    if (effectivePushName && phone) {
      label = `${effectivePushName} (${phone})`;
    } else if (effectivePushName) {
      label = effectivePushName;
    } else if (phone) {
      label = phone;
    } else {
      label = canonical;
    }
  }

  cache.set(cacheKey, label);
  return label;
}
