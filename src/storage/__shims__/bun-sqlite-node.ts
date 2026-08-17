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

type SqliteDb = InstanceType<typeof BetterSqlite3> & {
  query: (sql: string) => BetterSqlite3Statement;
};

// Extend the better-sqlite3 Database prototype once with a `query` method
// that mirrors `bun:sqlite`'s API (identical to `prepare`).
const proto = (BetterSqlite3 as unknown as { prototype: Record<string, unknown> }).prototype;
if (proto && typeof proto.query !== 'function') {
  proto.query = function query(this: InstanceType<typeof BetterSqlite3>, sql: string) {
    return this.prepare(sql);
  };
}

// Node 24 tears down the isolate before better-sqlite3 finalizes statements,
// which aborts the worker (`Assertion failed: (env) != nullptr`). Track every
// opened handle and close it before the isolate dies.
//
// The set lives on globalThis so every evaluated copy of this module (the
// `bun:sqlite` alias points at the `.ts` source; setupFiles import the `.js`
// specifier) shares one registry. A per-module Set would leave the handles
// the tests opened invisible to `closeOpenDatabases()`.
const OPEN_DATABASES_KEY = '__exarchosOpenSqliteDatabases' as const;
type SqliteRegistry = typeof globalThis & {
  [OPEN_DATABASES_KEY]?: Set<InstanceType<typeof BetterSqlite3>>;
};
const openDatabases = ((globalThis as SqliteRegistry)[OPEN_DATABASES_KEY] ??=
  new Set<InstanceType<typeof BetterSqlite3>>());

export function closeOpenDatabases(): void {
  for (const db of openDatabases) {
    try {
      db.close();
    } catch {
      // Already closed or unusable — the point is to not leave native
      // statements alive into isolate teardown.
    }
  }
  openDatabases.clear();
}

// Vitest workers close handles from `tests/helpers/close-sqlite.ts` (afterAll)
// while the isolate is still alive. Process hooks are the fallback for
// non-vitest Node entrypoints; skip them under vitest so a singleFork
// worker does not accumulate a listener per loaded copy of this module.
if (process.env.VITEST === undefined) {
  process.once('beforeExit', closeOpenDatabases);
  process.once('exit', closeOpenDatabases);
}

export const Database = class TrackingDatabase extends BetterSqlite3 {
  constructor(filename: string, options?: ConstructorParameters<typeof BetterSqlite3>[1]) {
    super(filename, options);
    openDatabases.add(this);
  }

  override close(): this {
    openDatabases.delete(this);
    return super.close();
  }
} as unknown as new (path: string) => SqliteDb;

export type Statement = BetterSqlite3Statement;
