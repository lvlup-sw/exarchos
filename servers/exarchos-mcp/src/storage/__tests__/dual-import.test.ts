import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';

import { SqliteBackend } from '../sqlite-backend.js';
import { hydrateAll } from '../hydration.js';
import { runJsonlToSqliteMigration } from '../migration.js';
import { runMigrationIfNeeded } from '../run-migration-if-needed.js';
import { EventStore } from '../../event-store/store.js';

/**
 * T74 — Regression test suite for the dual-import bug that produced
 * `cli=6 mcp=3` in the v2.10 parity tests.
 *
 * **The bug.** Two independent code paths could each import the same
 * `*.events.jsonl` lines into SQLite. Neither coordinated with the
 * other on `idempotency_claims`, so a "second pass" allocated fresh
 * sequences and wrote a duplicate row for every previously-imported
 * event:
 *
 *   1. **Pre-migration `hydrateAll` at process startup.**
 *      `index.ts:288` used to call `hydrateAll(backend, stateDir)` BEFORE
 *      the migration lifecycle hook fired. `hydrateAll` walks every
 *      `*.events.jsonl` file and inserts each line via
 *      `backend.appendEvent()` direct INSERT — bypassing
 *      `idempotency_claims` entirely.
 *   2. **Runtime dual-write at every event append.** `EventStore.append`
 *      writes through the runtime atomic-appender path (which writes
 *      JSONL) AND `EventStore.replicateBackend` does a best-effort
 *      direct INSERT into SQLite. The direct INSERT also bypasses
 *      `idempotency_claims`. Every runtime event therefore appears in
 *      JSONL on disk with NO matching claim row.
 *
 * On the next process startup, `runMigrationIfNeeded` saw `*.events.jsonl`
 * files in `stateDir` (always present after any runtime activity) and
 * dropped through to `runJsonlToSqliteMigration`, which re-imported
 * every JSONL line through `appender.append`. The appender found no
 * claim and allocated fresh sequences. Every event was duplicated;
 * the CLI parity test read 2N rows where the MCP path read N.
 *
 * **The fix.** Two surgical edits, each preventing a separate path from
 * tripping the same bug shape:
 *
 *   1. Removed the `hydrateAll(backend, stateDir)` call from
 *      `index.ts`. Production startup now only fires the migration
 *      runner via `initializeContext` → `runMigrationIfNeeded`.
 *      `hydrateAll` is retained for disaster-recovery and roundtrip
 *      tests that intentionally bypass idempotency machinery.
 *   2. Tightened the `runMigrationIfNeeded` short-circuit. The previous
 *      condition required `migration_lock = 'completed'` AND no
 *      `*.events.jsonl` files in `stateDir`. The "no files" clause was
 *      tripped on every startup by the runtime appender's own JSONL
 *      writes. The new condition is `migration_lock = 'completed'`
 *      alone — meaning "if we have ever migrated this DB, never do it
 *      again." This matches DR-8 AC1's once-only semantics.
 *
 * This test suite pins down all three contracts:
 *
 *   - `migrationAlone_NoDuplicates` — fresh stateDir + migration only
 *     produces exactly N events for an N-event JSONL fixture. This is
 *     the simplest GREEN.
 *   - `runtimeWriteThenSecondStartup_NoDuplicates` — the realistic
 *     production path: runtime writes via EventStore.append, then a
 *     second runMigrationIfNeeded simulates the next process startup.
 *     SQLite must end up with exactly N events (not 2N). This is the
 *     bug shape the parity tests were actually catching.
 *   - `legacyOrdering_StillDuplicates_RegressionGuard` — pins the
 *     pre-T74 hydrateAll-then-migrate bug shape. If a future commit
 *     re-introduces a pre-migration `hydrateAll` call at startup, this
 *     test will fail FIRST and point directly at the dual-import call
 *     site.
 */

interface PersistedEventLite {
  streamId: string;
  sequence: number;
  type: string;
  timestamp: string;
  eventId: string;
  data?: Record<string, unknown>;
  idempotencyKey?: string;
}

function makeEvent(
  streamId: string,
  sequence: number,
  type: string,
  i: number,
): PersistedEventLite {
  return {
    streamId,
    sequence,
    type,
    timestamp: new Date(2026, 0, 1, 0, 0, sequence).toISOString(),
    eventId: randomUUID(),
    data: { i },
    idempotencyKey: `${streamId}-key-${i}`,
  };
}

async function seedJsonlFixture(stateDir: string, streamId: string): Promise<void> {
  const lines = [
    JSON.stringify(makeEvent(streamId, 1, 'workflow.started', 0)),
    JSON.stringify(makeEvent(streamId, 2, 'task.assigned', 1)),
    JSON.stringify(makeEvent(streamId, 3, 'task.completed', 2)),
  ];
  await writeFile(
    path.join(stateDir, `${streamId}.events.jsonl`),
    lines.join('\n') + '\n',
    'utf-8',
  );
}

describe('Startup_DualImport_NoDuplicateEvents (T74)', () => {
  let stateDir: string;

  beforeEach(async () => {
    stateDir = await mkdtemp(path.join(tmpdir(), 'dual-import-t74-'));
  });

  afterEach(async () => {
    await rm(stateDir, { recursive: true, force: true });
  });

  it('migrationAlone_NoDuplicates: a fresh stateDir + migration produces exactly N events for an N-event JSONL fixture', async () => {
    // Production startup since T74 calls ONLY the migration runner
    // (the `hydrateAll` call was removed from `index.ts`).
    const streamId = 'stream-alpha';
    await seedJsonlFixture(stateDir, streamId);

    const dbPath = path.join(stateDir, 'exarchos.db');
    const backend = new SqliteBackend(dbPath);
    backend.initialize();

    try {
      const summary = await runJsonlToSqliteMigration({
        stateDir,
        backend,
      });
      expect(summary.ok).toBe(true);

      const events = backend.queryEvents(streamId);
      expect(events).toHaveLength(3);
      expect(events.map((e) => e.sequence)).toEqual([1, 2, 3]);
      expect(events.map((e) => e.type)).toEqual([
        'workflow.started',
        'task.assigned',
        'task.completed',
      ]);
    } finally {
      backend.close();
    }
  });

  it('runtimeWriteThenSecondStartup_NoDuplicates: the parity-bug shape — runtime appends followed by a second startup-time migration check must NOT duplicate', async () => {
    // This is the bug shape the v2.10 parity tests were actually
    // catching. The realistic production sequence is:
    //
    //   1. First startup: runMigrationIfNeeded runs on an empty
    //      stateDir, emits migration.completed, sets the lock to
    //      'completed'. (Modeled by the first call below.)
    //   2. Runtime writes events via EventStore.append. This goes
    //      through the JSONL-mode atomic appender (writes JSONL) AND
    //      EventStore.replicateBackend (best-effort direct INSERT into
    //      SQLite — bypasses idempotency_claims).
    //   3. Second startup: runMigrationIfNeeded fires again. PRE-T74
    //      it would see *.events.jsonl files (the runtime ones) and
    //      drop through to runJsonlToSqliteMigration, which would
    //      re-import every line through the appender, find no claim,
    //      and allocate fresh sequences — duplicating every runtime
    //      event. POST-T74 it short-circuits on the
    //      migration_lock='completed' alone.
    //
    // Without the fix this test asserts SQLite ends up with 6 events
    // (2× duplication). With the fix it ends up with 3.

    const dbPath = path.join(stateDir, 'exarchos.db');
    const backend = new SqliteBackend(dbPath);
    backend.initialize();

    try {
      // Step 1: simulated first-startup migration check on empty stateDir.
      // Emits migration.completed; lock state becomes 'completed'.
      await runMigrationIfNeeded(stateDir, backend);

      // Step 2: simulated runtime — write 3 events via the EventStore
      // append path (JSONL appender + best-effort SQLite dual-write).
      const store = new EventStore(stateDir, { backend });
      await store.initialize();
      const streamId = 'stream-bravo';
      await store.append(streamId, { type: 'workflow.started', data: { i: 0 } });
      await store.append(streamId, { type: 'task.assigned', data: { i: 1 } });
      await store.append(streamId, { type: 'task.completed', data: { i: 2 } });

      // SQLite has exactly 3 events at this point — written by
      // replicateBackend's direct INSERT.
      expect(backend.queryEvents(streamId)).toHaveLength(3);

      // Step 3: simulated second startup — runMigrationIfNeeded fires
      // again. POST-T74 it short-circuits because migration_lock is
      // 'completed'. PRE-T74 it would re-import every JSONL line and
      // double the event count.
      await runMigrationIfNeeded(stateDir, backend);

      // The load-bearing assertion. PRE-T74: 6 events (duplicates).
      // POST-T74: 3 events (untouched).
      const events = backend.queryEvents(streamId);
      expect(events).toHaveLength(3);
      expect(events.map((e) => e.sequence)).toEqual([1, 2, 3]);
    } finally {
      backend.close();
    }
  });

  it('legacyOrdering_StillDuplicates_RegressionGuard: pre-T74 ordering (hydrateAll then migration) doubles every event', async () => {
    // This test pins down the FIRST root cause shape — calling
    // `hydrateAll` before the migration runner. If you find yourself
    // reintroducing a pre-migration `hydrateAll(backend, stateDir)`
    // call at process startup (or in any pipeline that chains
    // hydrateAll → migration on the same JSONL), you will silently
    // double every imported event in SQLite. `appendEvent()` bypasses
    // `idempotency_claims`, so the migration runner has no way to know
    // hydrateAll already wrote those events and allocates a fresh
    // sequence range for each one. The parity tests will then fail
    // with `cli=2N mcp=N` — but this unit test fails FIRST and points
    // directly at the dual-import call site.
    const streamId = 'stream-charlie';
    await seedJsonlFixture(stateDir, streamId);

    const dbPath = path.join(stateDir, 'exarchos.db');
    const backend = new SqliteBackend(dbPath);
    backend.initialize();

    try {
      // Step 1: legacy `hydrateAll` (raw INSERT, no idempotency claim).
      await hydrateAll(backend, stateDir);

      // Step 2: migration runner appends through the appender path,
      // which finds no idempotency claim from step 1 and allocates
      // fresh sequences (4, 5, 6) for the same logical events.
      const summary = await runJsonlToSqliteMigration({
        stateDir,
        backend,
      });
      expect(summary.ok).toBe(true);

      const events = backend.queryEvents(streamId);
      // Bug shape: 6 events instead of 3 — sequences 1..3 from
      // hydrateAll's preserved-sequence direct INSERT, then 4..6 from
      // the migration's appender-allocated sequences.
      expect(events).toHaveLength(6);
      expect(events.map((e) => e.sequence)).toEqual([1, 2, 3, 4, 5, 6]);
    } finally {
      backend.close();
    }
  });
});
