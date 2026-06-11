import fs from "node:fs/promises";
import path from "node:path";
import {
  BufferJSON,
  initAuthCreds,
  proto,
  type AuthenticationCreds,
  type AuthenticationState,
  type SignalDataTypeMap,
} from "baileys";
import type { AccountDb } from "../persistence/db.js";

/**
 * DB-backed replacement for Baileys' `useMultiFileAuthState`: creds + signal
 * keys live as rows in the account database's `auth_kv` table instead of
 * thousands of tiny JSON files. Values are serialized with Baileys'
 * `BufferJSON` (same encoding the file store uses), and ids are sanitized
 * with the same character mapping (`/`→`__`, `:`→`-`) so rows imported from
 * a pending pairing's filenames stay addressable.
 */

function fixId(id: string): string {
  return id.replace(/\//g, "__").replace(/:/g, "-");
}

function readValue(db: AccountDb, key: string): unknown {
  const row = db.sql.prepare("SELECT value FROM auth_kv WHERE key = ?").get(key) as
    | { value: string }
    | undefined;
  if (!row) return null;
  return JSON.parse(row.value, BufferJSON.reviver);
}

function writeValue(db: AccountDb, key: string, value: unknown): void {
  db.sql
    .prepare("INSERT OR REPLACE INTO auth_kv (key, value) VALUES (?, ?)")
    .run(key, JSON.stringify(value, BufferJSON.replacer));
}

export interface DbAuthState {
  state: AuthenticationState;
  saveCreds: () => Promise<void>;
}

export function makeDbAuthState(db: AccountDb): DbAuthState {
  const creds: AuthenticationCreds = (readValue(db, "creds") as AuthenticationCreds | null) ?? initAuthCreds();

  return {
    state: {
      creds,
      keys: {
        get: async <T extends keyof SignalDataTypeMap>(type: T, ids: string[]) => {
          const data: { [id: string]: SignalDataTypeMap[T] } = {};
          for (const id of ids) {
            let value = readValue(db, `${type}-${fixId(id)}`);
            if (type === "app-state-sync-key" && value) {
              value = proto.Message.AppStateSyncKeyData.fromObject(value as object);
            }
            if (value != null) data[id] = value as SignalDataTypeMap[T];
          }
          return data;
        },
        set: async (data) => {
          db.transaction(() => {
            for (const category of Object.keys(data) as (keyof SignalDataTypeMap)[]) {
              const entries = data[category];
              if (!entries) continue;
              for (const id of Object.keys(entries)) {
                const key = `${category}-${fixId(id)}`;
                const value: unknown = entries[id];
                if (value == null) db.sql.prepare("DELETE FROM auth_kv WHERE key = ?").run(key);
                else writeValue(db, key, value);
              }
            }
          });
        },
      },
    },
    saveCreds: async () => writeValue(db, "creds", creds),
  };
}

export function readCredsMeFromDb(db: AccountDb): { id: string; name: string | null } | null {
  try {
    const creds = readValue(db, "creds") as { me?: { id?: string; name?: string } } | null;
    if (!creds?.me?.id) return null;
    return { id: creds.me.id, name: creds.me.name ?? null };
  } catch {
    return null;
  }
}

export function wipeAuth(db: AccountDb): void {
  db.sql.exec("DELETE FROM auth_kv");
}

/**
 * Import a pending pairing's multi-file auth dir into `auth_kv`, verbatim:
 * file contents are already BufferJSON-encoded and filenames are already
 * id-sanitized, so `<name>.json` maps 1:1 onto a row keyed `<name>`
 * (`creds.json` → `creds`). Unparseable files abort the import (nothing is
 * deleted). Returns the number of imported rows; the caller decides whether
 * to delete the source dir.
 */
export async function importAuthDir(db: AccountDb, authDir: string): Promise<number> {
  let files: string[];
  try {
    files = (await fs.readdir(authDir)).filter((f) => f.endsWith(".json"));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw err;
  }
  if (files.length === 0) return 0;

  const rows: { key: string; value: string }[] = [];
  for (const file of files) {
    const value = await fs.readFile(path.join(authDir, file), "utf8");
    JSON.parse(value); // verification: never import a row Baileys can't read back
    rows.push({ key: file === "creds.json" ? "creds" : file.slice(0, -".json".length), value });
  }

  db.transaction(() => {
    for (const row of rows) {
      db.sql.prepare("INSERT OR REPLACE INTO auth_kv (key, value) VALUES (?, ?)").run(row.key, row.value);
    }
  });
  return rows.length;
}
