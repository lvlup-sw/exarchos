/**
 * Node and vitest shim for `bun:sqlite`.
 *
 * Production code imports `bun:sqlite`, which resolves only under Bun. Vitest
 * runs under Node, so the tests alias `bun:sqlite` to this module over
 * `better-sqlite3`. The shim adds `db.query(sql)` as an alias of
 * `db.prepare(sql)`, and re-exports the better-sqlite3 `Statement` type.
 */

import BetterSqlite3, { type Statement as BetterSqlite3Statement } from 'better-sqlite3';

import { trackedDatabases } from './open-database-registry.js';

type SqliteDb = InstanceType<typeof BetterSqlite3> & {
  query: (sql: string) => BetterSqlite3Statement;
};

/** The better-sqlite3 prototype, which gets a `query` method equal to `prepare` once. */
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

/**
 * Close every tracked handle, and ignore a handle that is already closed.
 * Vitest workers call it from `tests/helpers/close-sqlite.ts`. Other Node entry
 * points use the process exit hooks, which the module skips under vitest.
 */
export function closeOpenDatabases(): void {
  for (const db of openDatabases) {
    try {
      db.close();
    } catch {
    }
  }
  openDatabases.clear();
}

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
 * The running meter lives on `globalThis`, for the same reason as the handle registry.
 * The alias and the `.js` specifier evaluate two copies of this module.
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
