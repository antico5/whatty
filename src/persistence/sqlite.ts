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
  lastInsertRowid: number;
}

export interface SqlStatement<T extends object = Record<string, unknown>> {
  run(...params: SqlParam[]): SqlRunResult;
  get(...params: SqlParam[]): T | undefined;
  all(...params: SqlParam[]): T[];
}

export interface SqlDatabase {
  /** Execute a single statement with no result (DDL, PRAGMA, BEGIN/COMMIT). */
  exec(sql: string): void;
  /** `T` is the caller's asserted row shape — declared once, next to the SQL. */
  prepare<T extends object = Record<string, unknown>>(sql: string): SqlStatement<T>;
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
  run(...params: SqlValue[]): { changes: number | bigint; lastInsertRowid: number | bigint };
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
    prepare<T extends object>(sql: string) {
      const stmt = raw.prepare(sql);
      // The sole row-shape assertion: callers declare T at the prepare() site.
      return {
        run: (...params) => {
          const r = stmt.run(...coerce(params));
          return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) };
        },
        get: (...params) => (stmt.get(...coerce(params)) ?? undefined) as unknown as T | undefined,
        all: (...params) => stmt.all(...coerce(params)) as unknown as T[],
      } satisfies SqlStatement<T>;
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
