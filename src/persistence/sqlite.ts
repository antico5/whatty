import { createRequire } from "node:module";

/**
 * Runtime-adaptive synchronous SQLite driver. The app runs under Bun
 * (`bun:sqlite`) while vitest runs under Node (`node:sqlite`); both expose a
 * near-identical synchronous API, so this module narrows them to one tiny
 * interface and papers over the differences (parameter coercion, `get()`
 * returning null vs undefined, constructor names).
 */

export type SqlValue = string | number | bigint | null | Uint8Array;
/** Accepted on the way in; booleans/undefined are coerced (SQLite has neither). */
export type SqlParam = SqlValue | boolean | undefined;

export interface SqlRunResult {
  changes: number;
}

export interface SqlStatement {
  run(...params: SqlParam[]): SqlRunResult;
  get(...params: SqlParam[]): Record<string, unknown> | undefined;
  all(...params: SqlParam[]): Record<string, unknown>[];
}

export interface SqlDatabase {
  /** Execute a single statement with no result (DDL, PRAGMA, BEGIN/COMMIT). */
  exec(sql: string): void;
  prepare(sql: string): SqlStatement;
  close(): void;
}

function coerce(params: SqlParam[]): SqlValue[] {
  return params.map((p) => {
    if (p === undefined) return null;
    if (typeof p === "boolean") return p ? 1 : 0;
    return p;
  });
}

interface RawStatement {
  run(...params: SqlValue[]): { changes: number | bigint };
  get(...params: SqlValue[]): Record<string, unknown> | null | undefined;
  all(...params: SqlValue[]): Record<string, unknown>[];
}

interface RawDatabase {
  prepare(sql: string): RawStatement;
  exec(sql: string): void;
  close(): void;
}

function wrap(raw: RawDatabase): SqlDatabase {
  return {
    exec: (sql) => raw.exec(sql),
    close: () => raw.close(),
    prepare(sql) {
      const stmt = raw.prepare(sql);
      return {
        run: (...params) => ({ changes: Number(stmt.run(...coerce(params)).changes) }),
        get: (...params) => stmt.get(...coerce(params)) ?? undefined,
        all: (...params) => stmt.all(...coerce(params)),
      };
    },
  };
}

// `createRequire` instead of dynamic import: bundlers (vite under vitest)
// try to resolve dynamic-import specifiers at transform time and choke on
// runtime-only modules; require() goes straight to the runtime loader. Bun
// supports require() of its builtin modules as well.
const nativeRequire = createRequire(import.meta.url);

export async function openSqlite(file: string): Promise<SqlDatabase> {
  if (process.versions.bun) {
    const mod = nativeRequire("bun:sqlite") as { Database: new (f: string, o: object) => RawDatabase };
    return wrap(new mod.Database(file, { create: true }));
  }
  const mod = nativeRequire("node:sqlite") as { DatabaseSync: new (f: string) => RawDatabase };
  return wrap(new mod.DatabaseSync(file));
}
