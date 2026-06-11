import { jidNormalizedUser } from "baileys";
import fs from "node:fs/promises";
import path from "node:path";
import { getLogger } from "../logger.js";
import { importAuthDir, readCredsMeFromDb } from "../whatsapp/authState.js";
import type { Chat } from "../types/index.js";
import { chatTypeOf } from "../types/index.js";
import { getActiveDb, pruneEvents, type AccountDb } from "./db.js";
import { internal as chatStoreInternal } from "./chatStore.js";
import { sanitizeForFilename } from "./mediaStore.js";
import { accountAuthDir, accountChatsDir, accountMediaDir, getActiveAccount } from "./paths.js";
import { upsertChat } from "./reconcile.js";

/**
 * One-time, idempotent migration of an account's legacy on-disk layout into
 * its SQLite database:
 *
 * - `auth/` (multi-file Baileys creds + signal keys) → `auth_kv` rows
 * - `chats/<jid>/chats.json` → relational rows; `@lid` folders whose phone
 *   number is known from the signal lid-mappings are imported under the
 *   canonical phone jid with an `aliases` row (this folds split chats — the
 *   "Not Contact" duplicate — back into one)
 * - `chats/<jid>/media/*` → the flat account `media/` dir, refs rewritten
 * - `status@broadcast` (WhatsApp Status updates, never a real chat) is
 *   dropped entirely
 *
 * Sources are deleted only after verification (every message id queryable,
 * every moved media file present). Anything unverifiable stays on disk and is
 * retried on the next run.
 */

const STATUS_BROADCAST = "status@broadcast";

export async function prepareActiveAccount(): Promise<void> {
  const accountId = getActiveAccount();
  if (!accountId) throw new Error("no active account to prepare");
  const db = await getActiveDb();
  await importLegacyAuth(db, accountAuthDir(accountId));
  await importLegacyChats(db, accountId);
  pruneEvents(db);
}

export async function importLegacyAuth(db: AccountDb, authDir: string): Promise<void> {
  const log = getLogger().child({ module: "importer" });
  const hasDir = await fs.stat(authDir).then((s) => s.isDirectory()).catch(() => false);
  if (!hasDir) return;

  if (readCredsMeFromDb(db)) {
    log.warn({ authDir }, "auth dir present but DB already has creds — leaving dir untouched");
    return;
  }

  const imported = await importAuthDir(db, authDir);
  if (imported === 0) return;
  // Verify before deleting: row count matches the file count we just read.
  const row = db.sql.prepare("SELECT COUNT(*) AS n FROM auth_kv").get() as { n: number };
  if (row.n < imported) {
    log.error({ imported, rows: row.n }, "auth import verification failed — keeping auth dir");
    return;
  }
  await fs.rm(authDir, { recursive: true, force: true });
  log.info({ imported }, "imported legacy auth dir into auth_kv and removed it");
}

/** lid user → phone user, from the signal lid-mapping rows imported with auth. */
function lidToPhoneMap(db: AccountDb): Map<string, string> {
  const rows = db.sql
    .prepare("SELECT key, value FROM auth_kv WHERE key LIKE 'lid-mapping-%\\_reverse' ESCAPE '\\'")
    .all() as { key: string; value: string }[];
  const map = new Map<string, string>();
  for (const r of rows) {
    const lid = r.key.slice("lid-mapping-".length, -"_reverse".length);
    try {
      const pn = JSON.parse(r.value) as unknown;
      if (typeof pn === "string" && pn.length > 0) map.set(lid, pn);
    } catch {
      // unreadable mapping — that lid folder simply stays lid-keyed
    }
  }
  return map;
}

interface FolderImport {
  jid: string;
  canonical: string;
  messageIds: string[];
  movedMedia: string[]; // absolute target paths
}

async function moveFolderMedia(
  folder: string,
  canonical: string,
  mediaTarget: string,
): Promise<{ refMap: Map<string, string>; moved: string[] }> {
  const refMap = new Map<string, string>();
  const moved: string[] = [];
  const sourceDir = path.join(folder, "media");
  let files: string[];
  try {
    files = await fs.readdir(sourceDir);
  } catch {
    return { refMap, moved };
  }
  if (files.length > 0) await fs.mkdir(mediaTarget, { recursive: true });
  for (const file of files) {
    const newName = `${sanitizeForFilename(canonical)}__${file}`;
    const target = path.join(mediaTarget, newName);
    const exists = await fs.stat(target).then(() => true).catch(() => false);
    if (!exists) await fs.rename(path.join(sourceDir, file), target);
    refMap.set(path.posix.join("media", file), path.posix.join("media", newName));
    moved.push(target);
  }
  return { refMap, moved };
}

function metaForMerge(chat: Chat, canonical: string, existing: Chat | null): Partial<Chat> {
  // The already-imported canonical chat's fields win; the folder fills gaps.
  return {
    jid: canonical,
    type: chatTypeOf(canonical),
    displayName: existing?.displayName ?? chat.displayName ?? undefined,
    phoneNumber: existing?.phoneNumber ?? chat.phoneNumber ?? undefined,
    groupSubject: existing?.groupSubject ?? chat.groupSubject ?? undefined,
    archived: chat.archived ? true : undefined,
    lastActivity: chat.lastActivity,
    participants: chat.participants.length > 0 ? chat.participants : undefined,
  };
}

export async function importLegacyChats(db: AccountDb, accountId: string): Promise<void> {
  const log = getLogger().child({ module: "importer" });
  const chatsDir = accountChatsDir(accountId);
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(chatsDir, { withFileTypes: true });
  } catch {
    return;
  }
  const folders = entries.filter((e) => e.isDirectory()).map((e) => e.name);
  if (folders.length === 0) return;

  const lidMap = lidToPhoneMap(db);
  const mediaTarget = accountMediaDir(accountId);
  // Phone/group folders first so @lid folders merge into existing canonicals.
  const ordered = [...folders.filter((j) => !j.endsWith("@lid")), ...folders.filter((j) => j.endsWith("@lid"))];

  let imported = 0;
  for (const jid of ordered) {
    const folder = path.join(chatsDir, jid);

    if (jid === STATUS_BROADCAST) {
      await fs.rm(folder, { recursive: true, force: true });
      log.info("dropped status@broadcast pseudo-chat");
      continue;
    }

    let chat: Chat | null = null;
    const chatFile = path.join(folder, "chats.json");
    const rawJson = await fs.readFile(chatFile, "utf8").catch(() => null);
    if (rawJson != null) {
      try {
        chat = JSON.parse(rawJson) as Chat;
      } catch (err) {
        log.error({ err, jid }, "unparseable legacy chats.json — keeping folder, not imported");
        continue;
      }
    }

    let canonical = jid;
    if (jid.endsWith("@lid")) {
      const pn = lidMap.get(jid.slice(0, jid.indexOf("@")));
      if (pn) {
        // mapping values are bare users, possibly device-suffixed (`:N`)
        canonical = jidNormalizedUser(pn.includes("@") ? pn : `${pn}@s.whatsapp.net`);
        db.sql.prepare("INSERT OR IGNORE INTO aliases (alias_jid, chat_jid) VALUES (?, ?)").run(jid, canonical);
      }
    }

    const { refMap, moved } = await moveFolderMedia(folder, canonical, mediaTarget);

    const result: FolderImport = { jid, canonical, messageIds: [], movedMedia: moved };
    if (chat) {
      for (const m of chat.messages) {
        if (m.media?.relativePath) {
          const mapped = refMap.get(m.media.relativePath);
          if (mapped) m.media = { ...m.media, relativePath: mapped };
        }
      }
      const existing = chatStoreInternal.loadChatFrom(db, canonical);
      const merged = upsertChat(existing, metaForMerge(chat, canonical, existing), chat.messages);
      chatStoreInternal.saveChatTo(db, merged);
      result.messageIds = chat.messages.map((m) => m.id);
    }

    if (await verifyFolderImport(db, result)) {
      await fs.rm(folder, { recursive: true, force: true });
      imported += 1;
    } else {
      log.error({ jid, canonical }, "import verification failed — keeping legacy folder");
    }
  }

  // Drop the legacy root once it holds nothing but verified-imported leftovers.
  await fs.rmdir(chatsDir).catch(() => undefined);
  log.info({ imported, total: folders.length }, "legacy chat import finished");
}

async function verifyFolderImport(db: AccountDb, result: FolderImport): Promise<boolean> {
  const stmt = db.sql.prepare("SELECT 1 AS ok FROM messages WHERE chat_jid = ? AND id = ?");
  for (const id of result.messageIds) {
    if (!stmt.get(result.canonical, id)) return false;
  }
  for (const file of result.movedMedia) {
    const ok = await fs.stat(file).then(() => true).catch(() => false);
    if (!ok) return false;
  }
  return true;
}
