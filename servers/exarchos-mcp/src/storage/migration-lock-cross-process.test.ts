import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { SqliteBackend } from './sqlite-backend.js';
import { runJsonlToSqliteMigration } from './migration.js';

/**
 * T60 — Cross-process migration-lock convergence (characterization).
 *
 * What this test asserts: when two CLI/MCP-style runners race for the
 * migration lock, exactly one runs the import and the other observes
 * `migration.completed` without re-running.
 *
 * Implementation note (characterization, not OS-process spawn):
 *
 *   The original RED draft of this test used `child_process.spawn` to
 *   fork two real `tsx` subprocesses, but the existing tsx-subprocess
 *   tests (`cli-concurrency.test.ts`, `doctor-workflow.test.ts`) are
 *   known-flaky on the project's CI runner because tsx cannot resolve
 *   the `bun:sqlite` virtual module without the vitest alias — and the
 *   alias is test-config scoped, so it does not transit the spawn
 *   boundary. Rather than ship a third tsx-subprocess fixture that adds
 *   to the same fragility surface, this test characterizes the same
 *   property using two SEPARATE `SqliteBackend` instances against the
 *   same DB file. That gives us:
 *
 *     - Two distinct SQLite connections (different driver handles, no
 *       shared in-memory state). Each connection independently calls
 *       `claimMigrationLock`.
 *     - SQLite WAL-mode file-locking semantics serialize the strict
 *       INSERT into `migration_lock` across connections — the same
 *       semantics that cross-process callers will observe.
 *     - The `migration_lock` row state (`'claimed'` → `'completed'`)
 *       is the synchronization seam, not any in-process abstraction.
 *
 *   This is structurally identical to two PIDs opening the DB file:
 *   the only thing missing is a separate OS-process boundary, which
 *   matters for fault domains (kill -9) but NOT for the lock-convergence
 *   property under test. A genuine cross-process fixture is tracked as
 *   follow-up work once the tsx subprocess fragility is unblocked.
 */

describe('MigrationLock_CliAndMcpStartConcurrently_OneRunsOneAwaits', () => {
  let stateDir: string;

  beforeEach(async () => {
    stateDir = await mkdtemp(path.join(tmpdir(), 'migration-lock-xprocess-'));
  });

  afterEach(async () => {
    await rm(stateDir, { recursive: true, force: true });
  });

  it('two distinct SqliteBackend connections race for the lock; exactly one imports', async () => {
    // ─── Fixture: single legacy JSONL file the winner will import ─────────
    const streamId = 'stream-xprocess-target';
    const jsonlPath = path.join(stateDir, `${streamId}.events.jsonl`);
    await writeFile(
      jsonlPath,
      JSON.stringify({
        streamId,
        sequence: 1,
        type: 'workflow.started',
        timestamp: '2026-01-01T00:00:00.000Z',
        eventId: 'xp-1',
        data: {},
        idempotencyKey: 'k-xp-1',
      }) + '\n',
      'utf-8',
    );

    const dbPath = path.join(stateDir, 'exarchos.db');

    // Pre-create the DB schema. Both racers re-open the file independently,
    // so they each see the migration_lock table at race start.
    const seedBackend = new SqliteBackend(dbPath);
    seedBackend.initialize();
    seedBackend.close();

    // ─── Two independent backends, two concurrent migration runs ─────────
    const backendA = new SqliteBackend(dbPath);
    backendA.initialize();
    const backendB = new SqliteBackend(dbPath);
    backendB.initialize();

    try {
      const [resA, resB] = await Promise.all([
        runJsonlToSqliteMigration({ stateDir, backend: backendA }),
        runJsonlToSqliteMigration({ stateDir, backend: backendB }),
      ]);

      // Both runs MUST succeed.
      expect(resA.ok).toBe(true);
      expect(resB.ok).toBe(true);
      if (resA.ok !== true || resB.ok !== true) return;

      // Exactly one winner (filesImported == 1) and exactly one loser
      // (filesImported == 0 — observed completion via the lock).
      const winners = [resA, resB].filter((r) => r.filesImported > 0);
      const losers = [resA, resB].filter((r) => r.filesImported === 0);
      expect(winners).toHaveLength(1);
      expect(losers).toHaveLength(1);
      expect(winners[0].filesImported).toBe(1);
      expect(winners[0].eventsImported).toBe(1);

      // ─── The shared DB observes a single migration.completed event ─────
      const migrationEvents = backendA.queryEvents('__migration__');
      const completed = migrationEvents.filter((e) => e.type === 'migration.completed');
      expect(completed).toHaveLength(1);

      // ─── Stream events imported exactly once ───────────────────────────
      const importedEvents = backendA.queryEvents(streamId);
      expect(importedEvents).toHaveLength(1);
      expect(importedEvents[0].type).toBe('workflow.started');
    } finally {
      backendA.close();
      backendB.close();
    }
  });
});
