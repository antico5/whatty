import type { AccountDb } from "./db.js";

function getSettingValue(db: AccountDb, key: string): string | null {
  const row = db.sql.prepare<{ value: string }>("SELECT value FROM settings WHERE key = ?").get(key);
  return row?.value ?? null;
}

function setSettingValue(db: AccountDb, key: string, value: string): void {
  db.sql.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").run(key, value);
}

export function getReadReceipts(db: AccountDb): boolean {
  return getSettingValue(db, "read_receipts") === "true";
}

export function setReadReceipts(db: AccountDb, enabled: boolean): void {
  setSettingValue(db, "read_receipts", enabled ? "true" : "false");
}
