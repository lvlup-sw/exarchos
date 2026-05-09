import { readdir } from 'node:fs/promises';
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
 *   2. If there are no `*.events.jsonl` files in `stateDir` (excluding the
 *      `.archive-v210/` subdir, which `runJsonlToSqliteMigration` already
 *      filters out), AND the migration_lock row is in the `'completed'`
 *      state from a prior run, short-circuit to a strict no-op. This is
 *      the idempotency requirement of DR-8 AC1: re-launching the host on
 *      a state directory that was already migrated must NOT emit fresh
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
 * `migration_lock` row's `state` column plus the absence of remaining
 * legacy JSONL files.
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

  // Case 2: short-circuit when migration already completed AND no fresh
  // JSONL files have appeared in stateDir.
  if (await alreadyCompletedAndNoLegacyFiles(stateDir, sqliteBackend)) {
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

async function alreadyCompletedAndNoLegacyFiles(
  stateDir: string,
  backend: SqliteBackend,
): Promise<boolean> {
  // Probe the lock row directly. We avoid importing `readMigrationLockState`
  // here so this module only depends on the SQL surface we actually use,
  // keeping the cold-start import graph minimal.
  const db = (backend as unknown as BackendWithMigrationLockDb)._migrationLockDb;
  const row = db
    .prepare('SELECT state FROM migration_lock WHERE id = 1')
    .get() as { state?: string } | undefined;
  if (!row || row.state !== 'completed') return false;

  // Any `*.events.jsonl` in stateDir means a fresh batch arrived (operator
  // restored from backup, etc.) and the migration should re-run on that
  // new content. `runJsonlToSqliteMigration` filters out the
  // `.archive-v210/` subdirectory, but the simplest implementation here
  // mirrors that filter at the readdir layer so we don't need to peek
  // into the archive at all.
  let entries: string[];
  try {
    entries = await readdir(stateDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      // No state dir → nothing to migrate.
      return true;
    }
    throw err;
  }
  const jsonlFiles = entries.filter((f) => f.endsWith('.events.jsonl'));
  return jsonlFiles.length === 0;
}
