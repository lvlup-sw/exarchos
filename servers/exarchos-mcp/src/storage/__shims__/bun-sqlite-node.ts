/**
 * Node/vitest shim for `bun:sqlite`.
 *
 * The production code imports from `bun:sqlite`, which only resolves when
 * running under Bun. vitest runs under Node (see vitest.config.ts) — so we
 * alias `bun:sqlite` to this module during tests, re-exporting the near-
 * identical API surface over `better-sqlite3`.
 *
 * API deltas between `bun:sqlite` and `better-sqlite3` that this shim
 * papers over:
 *   - `db.query(sql)` → aliased to `db.prepare(sql)` (better-sqlite3 only
 *     exposes `prepare`, but the API shape of the returned statement is
 *     identical for `.all()`, `.get()`, `.run()`).
 *   - `Statement` class export → re-exported as the better-sqlite3 Statement
 *     interface (structural type match is enough at the test boundary).
 *
 * All write-pragma calls use `db.exec('PRAGMA …')`, which both engines
 * support identically. Read-pragmas use `db.query('PRAGMA …').all()`, which
 * the `query` alias above translates to `db.prepare('PRAGMA …').all()`.
 */

import BetterSqlite3, { type Statement as BetterSqlite3Statement } from 'better-sqlite3';

// Extend the better-sqlite3 Database prototype once with a `query` method
// that mirrors `bun:sqlite`'s API (identical to `prepare`).
const proto = (BetterSqlite3 as unknown as { prototype: Record<string, unknown> }).prototype;
if (proto && typeof proto.query !== 'function') {
  proto.query = function query(this: InstanceType<typeof BetterSqlite3>, sql: string) {
    return this.prepare(sql);
  };
}

export const Database = BetterSqlite3 as unknown as new (
  path: string,
) => InstanceType<typeof BetterSqlite3> & {
  query: (sql: string) => BetterSqlite3Statement;
};

export type Statement = BetterSqlite3Statement;
