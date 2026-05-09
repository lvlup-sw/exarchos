import type { StorageBackend } from './backend.js';
import type { SqliteBackend } from './sqlite-backend.js';
import { runJsonlToSqliteMigration } from './migration.js';
import { logger } from '../logger.js';

/**
 * Lifecycle wiring for the JSONL → SQLite migration runner (#1259, T57,
 * DR-8 AC1).
 *
 * `initializeContext` calls this once after `eventStore.initialize()` so the
 * substrate hits its post-migration steady state BEFORE any tool dispatch
 * can fire its first runtime append. The contract is:
 *
 *   1. If the host did not open a SQLite-capable backend (JSONL-only mode,
 *      or `better-sqlite3` not available), do nothing — the migration
 *      cannot run without a SqliteBackend, and JSONL-only callers continue
 *      operating on legacy bodies.
 *   2. If the `migration_lock` row is in the `'completed'` state from a
 *      prior run, short-circuit to a strict no-op. This is the
 *      idempotency requirement of DR-8 AC1: re-launching the host on a
 *      state directory that was already migrated must NOT emit fresh
 *      `migration.completed` events.
 *   3. Otherwise call `runJsonlToSqliteMigration` and surface any failure
 *      via a structured warning. The runner itself acquires/releases the
 *      cross-process migration lock (T60), so we do not duplicate that
 *      work here.
 *
 * Why does the function look at the lock state instead of `schema_version
 * < 3`? — `SqliteBackend.initialize()` always inserts SCHEMA_VERSION=3 the
 * first time it sees a fresh DB, so by the time this function runs the
 * row is always present. The DR-8 sentinel that actually distinguishes
 * "first run on this stateDir" from "already migrated" is the
 * `migration_lock` row's `state` column.
 *
 * **T74 — why not also check for absent JSONL files.** A previous
 * iteration also required `no *.events.jsonl files in stateDir` before
 * short-circuiting (so an operator restoring from backup with fresh
 * legacy JSONL would re-trigger the migration). That extra clause is
 * load-bearing in theory but produces a duplicate-event bug in practice:
 * the runtime atomic-appender path (in `backend: 'jsonl'` mode plus
 * `EventStore.replicateBackend`) writes JSONL files for every runtime
 * event, but those JSONL writes do NOT record `idempotency_claims` rows
 * in SQLite. On the next process startup, the migration runner sees the
 * runtime-written JSONL, tries to import it through the SQLite-backed
 * appender path, finds no claim, allocates fresh sequences, and writes
 * a duplicate row for every runtime event. The CLI parity tests then
 * fail with `cli=2N mcp=N`. Dropping the file-presence check makes the
 * short-circuit "if it ran once on this DB, never run again" — which
 * matches the DR-8 AC1 wording. Operator restore-from-backup is a
 * separate (rare) workflow that can be triggered explicitly via tooling
 * if that need ever materializes.
 */
export async function runMigrationIfNeeded(
  stateDir: string,
  backend: StorageBackend | undefined,
): Promise<void> {
  // Case 1: no backend → JSONL-only mode → nothing to do.
  if (!backend) return;

  // Detect SqliteBackend via the typed `_migrationLockDb` accessor —
  // matching the duck-typing convention used by `migration-lock.ts` so we
  // don't drag a `SqliteBackend` import into the lifecycle hook.
  const sqliteBackend = asSqliteBackend(backend);
  if (!sqliteBackend) return;

  // Case 2: short-circuit when migration already completed.
  //
  // T74 — see header doc for why we no longer also require "no JSONL
  // files in stateDir": that condition was tripped on every startup by
  // the runtime appender's own JSONL writes, which made the migration
  // re-import (and duplicate) every runtime event because runtime
  // dual-write doesn't record `idempotency_claims`.
  if (alreadyCompleted(sqliteBackend)) {
    return;
  }

  // Case 3: run the migration. The runner owns the lock + per-file event
  // emission + archive moves; this lifecycle hook just kicks it off and
  // surfaces failures non-fatally so the host can still come up in
  // degraded mode (legacy JSONL stays on disk; operator can intervene).
  const result = await runJsonlToSqliteMigration({
    stateDir,
    backend: sqliteBackend,
  });
  if (!result.ok) {
    logger.warn(
      {
        reason: result.reason,
        partialFilesImported: result.partialFilesImported,
        partialEventsImported: result.partialEventsImported,
      },
      'startup migration failed — proceeding with backend in mixed state; operator inspection required',
    );
  }
}

interface BackendWithMigrationLockDb {
  _migrationLockDb: {
    prepare: (sql: string) => {
      get: () => unknown;
    };
  };
}

function asSqliteBackend(backend: StorageBackend): SqliteBackend | undefined {
  // Duck-type: every SqliteBackend exposes the narrow `_migrationLockDb`
  // accessor; the in-memory backend does not. This lets the lifecycle
  // hook stay agnostic of the concrete backend class without dragging
  // `bun:sqlite` into the cold-start import graph.
  if (
    typeof (backend as unknown as Partial<BackendWithMigrationLockDb>)
      ._migrationLockDb === 'object' &&
    (backend as unknown as Partial<BackendWithMigrationLockDb>)
      ._migrationLockDb !== null
  ) {
    return backend as unknown as SqliteBackend;
  }
  return undefined;
}

function alreadyCompleted(backend: SqliteBackend): boolean {
  // Probe the lock row directly. We avoid importing `readMigrationLockState`
  // here so this module only depends on the SQL surface we actually use,
  // keeping the cold-start import graph minimal.
  const db = (backend as unknown as BackendWithMigrationLockDb)._migrationLockDb;
  const row = db
    .prepare('SELECT state FROM migration_lock WHERE id = 1')
    .get() as { state?: string } | undefined;
  return row?.state === 'completed';
}
