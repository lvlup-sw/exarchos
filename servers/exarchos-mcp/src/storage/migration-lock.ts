import type { SqliteBackend } from './sqlite-backend.js';

/**
 * Migration lock primitive (#1259, T19, DR-8 / DR-12).
 *
 * Single-row `migration_lock` table (`id = 1`, integer-PK collision is the
 * synchronization seam). The semantics:
 *
 *   1. Claim path: `INSERT INTO migration_lock (id, state, claimedAt)
 *      VALUES (1, 'claimed', ?)` — strict INSERT (no `OR IGNORE`) so a
 *      collision raises and the helper falls into the await branch.
 *   2. Release path: `UPDATE migration_lock SET state = 'completed',
 *      releasedAt = ?` — the row stays for forensics, but its `state`
 *      column lets the next run re-claim by transitioning back to
 *      `'claimed'` (an INSERT-or-UPDATE upsert under the same id).
 *   3. Loser await path: poll the row's `state` column until it flips to
 *      `'completed'`, OR observe a `migration.completed` event on the
 *      `__migration__` stream (the orchestrator emits it after release).
 *
 * The await loop is bounded but generous (default 60s for in-process,
 * extendable for cross-process by the caller). Each iteration sleeps for
 * `pollIntervalMs` (default 50ms) — short enough that small migrations
 * unblock siblings within a few hundred ms, long enough that the loop
 * does not consume meaningful CPU.
 *
 * The cross-process variant (T60) re-uses the same primitive: SQLite WAL
 * mode + the same `migration_lock` row provide cross-process serialization
 * for free. Each process independently calls `claimMigrationLock(backend)`
 * against its own connection on the shared DB file; the strict INSERT
 * is the contention point.
 */

export type ClaimResult =
  | {
      claimed: true;
    }
  | {
      claimed: false;
      observedCompletion: boolean;
      /**
       * Set when the await loop exhausted its budget without observing
       * completion. Callers can treat this as a structured timeout (DR-12:
       * the operator must inspect a stalled lock manually).
       */
      timedOut?: boolean;
    };

export interface ClaimOptions {
  /**
   * Total time the loser waits for the winner to release before returning
   * `{ claimed: false, observedCompletion: false, timedOut: true }`.
   * Default: 60_000ms. Cross-process callers (T60) typically pass a longer
   * budget.
   */
  awaitTimeoutMs?: number;
  /**
   * Per-iteration sleep between polls of the `migration_lock` row.
   * Default: 50ms.
   */
  pollIntervalMs?: number;
}

/**
 * Database handle exposed by `SqliteBackend` for direct DDL/DML access.
 * The migration lock primitive needs SQL-level access to the
 * `migration_lock` row that doesn't have a dedicated method on the
 * backend's typed interface. We reach through a `_db` accessor that
 * SqliteBackend exposes only to substrate primitives in this package.
 */
interface RawDatabase {
  prepare: (sql: string) => {
    run: (...args: unknown[]) => unknown;
    get: (...args: unknown[]) => unknown;
  };
}

interface BackendWithRawDb {
  _migrationLockDb: RawDatabase;
}

/**
 * Test/internal-only seam: SqliteBackend exposes its underlying Database
 * handle to migration-lock helpers via a private accessor. Keeping it
 * narrowly named (`_migrationLockDb`) makes the boundary self-documenting:
 * adding new SQL-level pokes into the backend MUST go through a typed
 * method on `SqliteBackend` itself, not by widening this accessor.
 */
function rawDb(backend: SqliteBackend): RawDatabase {
  return (backend as unknown as BackendWithRawDb)._migrationLockDb;
}

/**
 * Attempt to claim the JSONL→SQLite migration lock.
 *
 * Returns `{ claimed: true }` if this caller wins the race. Returns
 * `{ claimed: false, observedCompletion }` if another claimer holds the
 * lock — `observedCompletion` is true once the holder transitions the row
 * to `'completed'` (i.e. the migration finished and siblings can proceed
 * without re-running).
 *
 * On `'completed'` rows: a fresh claim re-acquires by `UPDATE`-ing the row
 * back to `'claimed'`. This is the pattern that lets a second process or
 * a same-process retry pick up where a previous successful migration
 * left off — the row is the long-lived synchronization point, not a
 * one-shot flag.
 */
export async function claimMigrationLock(
  backend: SqliteBackend,
  options: ClaimOptions = {},
): Promise<ClaimResult> {
  const awaitTimeoutMs = options.awaitTimeoutMs ?? 60_000;
  const pollIntervalMs = options.pollIntervalMs ?? 50;
  const db = rawDb(backend);
  const now = () => new Date().toISOString();

  // ─── Attempt: claim the row ────────────────────────────────────────────
  // Two cases:
  //   (a) Row does not exist → INSERT succeeds → we own the lock.
  //   (b) Row exists with state='completed' (a prior run finished and is
  //       eligible to be re-claimed) → INSERT collides → fall into the
  //       UPDATE-from-completed branch.
  //   (c) Row exists with state='claimed' (a sibling holds it) → INSERT
  //       collides → fall into the await loop.
  try {
    db.prepare(
      "INSERT INTO migration_lock (id, state, claimedAt) VALUES (1, 'claimed', ?)",
    ).run(now());
    return { claimed: true };
  } catch (err) {
    if (!isUniqueViolation(err)) {
      throw err;
    }
    // Fall through to the upsert-from-completed / await branches.
  }

  // ─── Re-claim from a previous 'completed' row ─────────────────────────
  // Atomic UPDATE: only succeeds if the row is currently 'completed'. If a
  // sibling slipped in and set 'claimed' between our INSERT-fail and this
  // UPDATE, the WHERE clause filters us out and `changes` is 0 — fall
  // through to the await loop.
  const upsert = db.prepare(
    `UPDATE migration_lock SET state = 'claimed', claimedAt = ?, releasedAt = NULL
     WHERE id = 1 AND state = 'completed'`,
  ).run(now()) as { changes?: number };
  if (typeof upsert.changes === 'number' && upsert.changes >= 1) {
    return { claimed: true };
  }

  // ─── Await branch: poll the row until 'completed' or timeout ──────────
  const deadline = Date.now() + awaitTimeoutMs;
  while (Date.now() < deadline) {
    await sleep(pollIntervalMs);
    const row = db.prepare('SELECT state FROM migration_lock WHERE id = 1').get() as
      | { state: string }
      | undefined;
    if (row && row.state === 'completed') {
      return { claimed: false, observedCompletion: true };
    }
  }
  return { claimed: false, observedCompletion: false, timedOut: true };
}

/**
 * Release the migration lock. Sets `state = 'completed'` and stamps
 * `releasedAt`. Subsequent claimers either:
 *   - Observe `'completed'` (no JSONL files left) and short-circuit, or
 *   - Re-claim the row (a fresh migration window — typically only on a
 *     fresh JSONL set in-state-dir, e.g. operator restored from archive).
 *
 * On migration failure the orchestrator does NOT call this — DR-12
 * mandates the row stays `'claimed'` for operator inspection.
 */
export async function releaseMigrationLock(backend: SqliteBackend): Promise<void> {
  const db = rawDb(backend);
  db.prepare(
    "UPDATE migration_lock SET state = 'completed', releasedAt = ? WHERE id = 1",
  ).run(new Date().toISOString());
}

/**
 * Read the current lock state. Used by tests and the orchestrator's
 * post-failure assertions to verify DR-12: the lock row stays `'claimed'`
 * after a failed run.
 */
export function readMigrationLockState(
  backend: SqliteBackend,
): { state: string; claimedAt: string; releasedAt: string | null } | null {
  const db = rawDb(backend);
  const row = db.prepare(
    'SELECT state, claimedAt, releasedAt FROM migration_lock WHERE id = 1',
  ).get() as { state: string; claimedAt: string; releasedAt: string | null } | undefined;
  return row ?? null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isUniqueViolation(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const code = (err as { code?: unknown }).code;
  if (typeof code === 'string' && /SQLITE_CONSTRAINT/.test(code)) return true;
  const message = (err as { message?: unknown }).message;
  return typeof message === 'string' && /UNIQUE constraint failed/.test(message);
}
