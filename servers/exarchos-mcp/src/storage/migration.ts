import { readdir, rename, unlink } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { z } from 'zod';
import { WorkflowEventBase, type WorkflowEvent } from '../event-store/schemas.js';
import { WorkflowStateSchema } from '../workflow/schemas.js';
import { migrateState } from '../workflow/migration.js';
import type { WorkflowState } from '../workflow/types.js';
import type { StorageBackend } from './backend.js';
import { logger } from '../logger.js';
import type { SqliteBackend } from './sqlite-backend.js';
import { AtomicAppender } from '../event-store/atomic-appender.js';
import { importJsonlFile } from './jsonl-importer.js';
import {
  claimMigrationLock,
  releaseMigrationLock,
} from './migration-lock.js';

// ─── Legacy File Patterns ───────────────────────────────────────────────────

const LEGACY_CLEANUP_PATTERNS = [
  '.seq',
  '.snapshot.json',
  '.state.json.migrated',
  '.outbox.json.migrated',
];

// ─── State Migration ────────────────────────────────────────────────────────

/**
 * Imports `*.state.json` files into the StorageBackend.
 *
 * For each `*.state.json` file found:
 * - Skips if the featureId already exists in the backend (idempotent)
 * - Parses the JSON content
 * - Validates against WorkflowStateSchema
 * - Extracts the featureId from the filename (`{featureId}.state.json`)
 * - Inserts into the backend via `setState()`
 *
 * The `.state.json` file is kept on disk as a crash-recovery backup.
 * Corrupt or invalid files are skipped.
 */
export async function migrateLegacyStateFiles(
  backend: StorageBackend,
  stateDir: string,
): Promise<void> {
  let files: string[];
  try {
    files = await readdir(stateDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw err;
  }

  const stateFiles = files.filter(
    (f) => f.endsWith('.state.json') && !f.endsWith('.state.json.migrated'),
  );

  for (const file of stateFiles) {
    const filePath = path.join(stateDir, file);
    const featureId = file.replace('.state.json', '');

    // Idempotent: skip if backend already has this state
    if (backend.getState(featureId) != null) continue;

    let raw: unknown;
    try {
      const content = readFileSync(filePath, 'utf-8');
      raw = JSON.parse(content);
    } catch (err) {
      logger.warn({ file, err: err instanceof Error ? err.message : String(err) }, 'Skipping corrupt legacy state file');
      continue;
    }

    let migrated: unknown;
    try {
      migrated = migrateState(raw);
    } catch (err) {
      logger.warn({ file, err: err instanceof Error ? err.message : String(err) }, 'Skipping legacy state file: migration failed');
      continue;
    }

    const parsed = WorkflowStateSchema.safeParse(migrated);
    if (!parsed.success) {
      logger.warn({ file, error: parsed.error.message }, 'Skipping invalid legacy state file');
      continue;
    }
    const state: WorkflowState = parsed.data;

    backend.setState(featureId, state);
  }
}

// ─── Outbox Migration ───────────────────────────────────────────────────────

/**
 * Migrates legacy `*.outbox.json` files into the StorageBackend outbox.
 *
 * Each file is expected to contain a JSON array of WorkflowEvent objects.
 * Events are validated via WorkflowEventBase and inserted via `backend.addOutboxEntry()`.
 */
export async function migrateLegacyOutbox(
  backend: StorageBackend,
  stateDir: string,
): Promise<void> {
  let files: string[];
  try {
    files = await readdir(stateDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw err;
  }

  const outboxFiles = files.filter((f) => f.endsWith('.outbox.json'));

  for (const file of outboxFiles) {
    const filePath = path.join(stateDir, file);
    const streamId = file.replace('.outbox.json', '');

    let raw: unknown;
    try {
      const content = readFileSync(filePath, 'utf-8');
      raw = JSON.parse(content);
    } catch (err) {
      logger.warn({ file, err: err instanceof Error ? err.message : String(err) }, 'Skipping corrupt legacy outbox file');
      continue;
    }

    const parsed = z.array(WorkflowEventBase).safeParse(raw);
    if (!parsed.success) {
      logger.warn({ file, error: parsed.error.message }, 'Skipping invalid legacy outbox file');
      continue;
    }

    for (const event of parsed.data) {
      backend.addOutboxEntry(streamId, event);
    }

    // Mark as migrated to prevent duplicate replays
    await rename(filePath, filePath + '.migrated');
  }
}

// ─── Legacy File Cleanup ────────────────────────────────────────────────────

/**
 * Removes legacy files that are no longer needed after migration:
 * - `*.seq` (sequence cache files)
 * - `*.snapshot.json` (snapshot files)
 * - `*.state.json.migrated` (already-migrated state files)
 * - `*.outbox.json` (outbox files)
 */
export async function cleanupLegacyFiles(stateDir: string): Promise<void> {
  let files: string[];
  try {
    files = await readdir(stateDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw err;
  }

  for (const file of files) {
    const shouldRemove = LEGACY_CLEANUP_PATTERNS.some((pattern) =>
      file.endsWith(pattern),
    );

    if (shouldRemove) {
      try {
        await unlink(path.join(stateDir, file));
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw err;
      }
    }
  }
}

// ─── JSONL → SQLite Migration Orchestrator (#1259, T22, DR-8 / DR-9 / DR-12)

const MIGRATION_STREAM_ID = '__migration__';

/**
 * Successful run summary (orchestrator-level — per-file telemetry is
 * surfaced separately via `migration.legacy_jsonl_imported` events).
 */
export interface MigrationRunSummary {
  ok: true;
  filesImported: number;
  eventsImported: number;
  totalDurationMs: number;
}

/**
 * Failure summary. The lock row is left in `'claimed'` state (DR-12)
 * so operators can inspect it before re-running.
 */
export interface MigrationRunFailure {
  ok: false;
  reason: string;
  partialFilesImported: number;
  partialEventsImported: number;
  cause?: Error;
}

export interface MigrationRunOptions {
  stateDir: string;
  backend: SqliteBackend;
  /**
   * Test-only fault hook. Invoked once per file path BEFORE that file
   * is handed to `importJsonlFile`. Throwing from the hook simulates
   * an unrecoverable mid-import fault. Production code never sets this.
   */
  _testOnlyFaultHook?: (filePath: string) => void;
}

/**
 * Run the JSONL → SQLite migration end-to-end:
 *   1. Claim the migration_lock (loser short-circuits as a no-op).
 *   2. Enumerate `*.events.jsonl` files in `stateDir` (skipping the
 *      `.archive-v210/` subdirectory).
 *   3. For each file, run `importJsonlFile` through a freshly-constructed
 *      AtomicAppender bound to the SQLite backend.
 *   4. On success: emit `migration.completed` and release the lock.
 *      On failure: emit `migration.failed`, leave the lock claimed,
 *      and return a structured failure to the caller.
 *
 * The orchestrator does NOT wire itself into lifecycle.ts — that is the
 * scope of T57 (Phase 8). This function is a pure substrate primitive
 * the lifecycle layer can call once at startup.
 */
export async function runJsonlToSqliteMigration(
  options: MigrationRunOptions,
): Promise<MigrationRunSummary | MigrationRunFailure> {
  const start = Date.now();
  const { stateDir, backend } = options;

  // ─── Step 1: claim the lock ───────────────────────────────────────────
  const claim = await claimMigrationLock(backend);
  if (!claim.claimed) {
    // Loser path: another runner already executed (or is currently
    // executing) the migration. We return the success shape with zero
    // counters because the loser observed completion without doing
    // additional work. If the await timed out the caller surfaces
    // a separate timeout — DR-12 explicitly accepts this as an operator
    // signal.
    if (claim.observedCompletion) {
      return { ok: true, filesImported: 0, eventsImported: 0, totalDurationMs: 0 };
    }
    return {
      ok: false,
      reason: 'migration-lock timed out without observing completion',
      partialFilesImported: 0,
      partialEventsImported: 0,
    };
  }

  // ─── Step 2: build an appender bound to the shared SQLite backend ─────
  // We construct a fresh AtomicAppender here rather than asking the caller
  // to pass one in. The orchestrator is the canonical entry point for
  // the migration; the appender is its dependency, not the lifecycle's.
  const appender = new AtomicAppender({
    stateDir,
    backend: 'sqlite',
    sqliteBackend: backend,
  });

  // ─── Step 3: enumerate JSONL files in stateDir ────────────────────────
  let filesInDir: string[];
  try {
    filesInDir = await readdir(stateDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      // No state dir → no files to migrate. Emit completion + release.
      await emitMigrationCompletedAndRelease(appender, backend, 0, 0, Date.now() - start);
      return { ok: true, filesImported: 0, eventsImported: 0, totalDurationMs: Date.now() - start };
    }
    return failAndKeepLock(
      appender,
      backend,
      err instanceof Error ? err.message : String(err),
      0,
      0,
      err,
    );
  }
  const jsonlFiles = filesInDir
    .filter((f) => f.endsWith('.events.jsonl'))
    .map((f) => path.join(stateDir, f));

  // ─── Step 4: import each file ────────────────────────────────────────
  let filesImported = 0;
  let eventsImported = 0;
  for (const filePath of jsonlFiles) {
    try {
      // Test-only fault hook (T22): throws to simulate mid-import faults.
      if (options._testOnlyFaultHook) {
        options._testOnlyFaultHook(filePath);
      }

      const result = await importJsonlFile(filePath, appender, backend);
      if (!result.ok) {
        return failAndKeepLock(
          appender,
          backend,
          result.reason,
          filesImported,
          eventsImported + result.eventCount,
          result.cause,
        );
      }
      filesImported += 1;
      eventsImported += result.eventCount;
    } catch (err) {
      return failAndKeepLock(
        appender,
        backend,
        err instanceof Error ? err.message : String(err),
        filesImported,
        eventsImported,
        err,
      );
    }
  }

  // ─── Step 5: emit completed + release lock ────────────────────────────
  const totalDurationMs = Date.now() - start;
  try {
    await emitMigrationCompletedAndRelease(
      appender,
      backend,
      filesImported,
      eventsImported,
      totalDurationMs,
    );
  } catch (err) {
    return failAndKeepLock(
      appender,
      backend,
      `Failed to emit migration.completed: ${err instanceof Error ? err.message : String(err)}`,
      filesImported,
      eventsImported,
      err,
    );
  }

  return { ok: true, filesImported, eventsImported, totalDurationMs };
}

async function emitMigrationCompletedAndRelease(
  appender: AtomicAppender,
  backend: SqliteBackend,
  filesImported: number,
  eventsImported: number,
  totalDurationMs: number,
): Promise<void> {
  const result = await appender.appendUnkeyed(MIGRATION_STREAM_ID, [
    {
      type: 'migration.completed',
      data: { filesImported, eventsImported, totalDurationMs },
    },
  ]);
  if (!result.ok) {
    throw new Error(`Failed to emit migration.completed: reason=${result.reason}`);
  }
  await releaseMigrationLock(backend);
}

async function failAndKeepLock(
  appender: AtomicAppender,
  _backend: SqliteBackend,
  reason: string,
  partialFilesImported: number,
  partialEventsImported: number,
  cause?: unknown,
): Promise<MigrationRunFailure> {
  // Best-effort: emit migration.failed. If the emit itself fails the lock
  // still stays claimed (DR-12 — failure path keeps the row), and the
  // caller's structured failure carries the original reason.
  try {
    await appender.appendUnkeyed(MIGRATION_STREAM_ID, [
      {
        type: 'migration.failed',
        data: {
          reason,
          partialFilesImported,
          partialEventsImported,
        },
      },
    ]);
  } catch (emitErr) {
    logger.warn(
      { err: emitErr instanceof Error ? emitErr.message : String(emitErr) },
      'migration: failed to emit migration.failed event; lock remains claimed',
    );
  }
  return {
    ok: false,
    reason,
    partialFilesImported,
    partialEventsImported,
    ...(cause instanceof Error ? { cause } : {}),
  };
}
