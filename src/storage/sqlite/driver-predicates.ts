/**
 * Narrow a driver transaction wrapper to the explicit `BEGIN IMMEDIATE` form.
 *
 * `bun:sqlite` and the shimmed `better-sqlite3` driver both expose
 * `transaction(fn).immediate(args)`, but neither ships a type for it. This
 * guard is the single narrowing boundary — callers get a typed `immediate()`
 * instead of double-widening the wrapper at each use site.
 */
export function hasImmediateTransaction(
  txn: unknown,
): txn is { immediate: (...args: unknown[]) => void } {
  if (typeof txn !== 'function' && (typeof txn !== 'object' || txn === null)) {
    return false;
  }
  if (!('immediate' in txn)) return false;
  return typeof txn.immediate === 'function';
}

/**
 * Detect SQLITE_BUSY in a thrown driver error. `bun:sqlite` and `better-sqlite3`
 * both put the SQLite error code in `.code`. A non-object throw gives `false`.
 */
export function isSqliteBusy(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const code = (err as { code?: unknown }).code;
  return code === 'SQLITE_BUSY';
}

/**
 * Detect SQLITE_CORRUPT and SQLITE_NOTADB. Both surface in `initialize()` for a
 * malformed file, and both are fatal, because the substrate refuses auto-recovery.
 */
export function isSqliteCorrupt(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const code = (err as { code?: unknown }).code;
  return code === 'SQLITE_CORRUPT' || code === 'SQLITE_NOTADB';
}

/** Sleep helper used by the BUSY retry layer. Resolves after `ms` milliseconds. */
export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
