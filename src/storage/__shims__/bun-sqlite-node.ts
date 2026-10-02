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

import { trackedDatabases } from './open-database-registry.js';

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

/**
 * Every open connection. Node 24 tears down the isolate before better-sqlite3
 * finalizes statements, which aborts the worker, so each tracked handle is
 * closed before the isolate dies. The registry is shared by every evaluated
 * copy of this module, and the temp-dir helper reads it to find leaks.
 */
const openDatabases = trackedDatabases();

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

/**
 * The SQLite work of the connections opened while a meter runs. The append
 * cost budget test reads it to count what one store operation asks of SQLite.
 */
export interface SqliteWorkMeter {
  /** Each statement SQLite ran, as the driver logged it, BEGIN and COMMIT included. */
  readonly executed: string[];
  /** Each SQL text compiled through `prepare` or `query`. */
  readonly prepared: string[];
}

/**
 * The running meter lives on globalThis for the same reason as the handle
 * registry: the alias and the `.js` specifier evaluate two copies of this module.
 */
const ACTIVE_METER_KEY = '__exarchosSqliteWorkMeter' as const;
type MeterSlot = typeof globalThis & { [ACTIVE_METER_KEY]?: SqliteWorkMeter | undefined };

/**
 * Start a meter. Every connection opened while it runs records into it for
 * the rest of its life. Only one meter runs at a time.
 */
export function startSqliteWorkMeter(): SqliteWorkMeter {
  const slot: MeterSlot = globalThis;
  if (slot[ACTIVE_METER_KEY] !== undefined) {
    throw new Error('a SQLite work meter is already running');
  }
  const meter: SqliteWorkMeter = { executed: [], prepared: [] };
  slot[ACTIVE_METER_KEY] = meter;
  return meter;
}

/** Stop the running meter. Connections opened after this are not metered. */
export function stopSqliteWorkMeter(): void {
  const slot: MeterSlot = globalThis;
  slot[ACTIVE_METER_KEY] = undefined;
}

/** Record each SQL text the connection compiles, then compile it as before. */
function meterPrepare(db: InstanceType<typeof BetterSqlite3>, meter: SqliteWorkMeter): void {
  const prepare = db.prepare.bind(db);
  Object.defineProperty(db, 'prepare', {
    configurable: true,
    writable: true,
    value: (source: string) => {
      meter.prepared.push(source);
      return prepare(source);
    },
  });
}

export const Database = class TrackingDatabase extends BetterSqlite3 {
  constructor(filename: string, options?: ConstructorParameters<typeof BetterSqlite3>[1]) {
    const slot: MeterSlot = globalThis;
    const meter = slot[ACTIVE_METER_KEY];
    super(
      filename,
      meter === undefined
        ? options
        : { ...options, verbose: (sql: unknown) => meter.executed.push(String(sql)) },
    );
    openDatabases.add(this);
    if (meter !== undefined) meterPrepare(this, meter);
  }

  /** Deregisters only after the driver closes, so a refused close stays visible. */
  override close(): this {
    super.close();
    openDatabases.delete(this);
    return this;
  }
} as unknown as new (path: string) => SqliteDb;

export type Statement = BetterSqlite3Statement;
