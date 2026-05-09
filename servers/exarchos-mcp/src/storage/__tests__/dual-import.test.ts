import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';

import { SqliteBackend } from '../sqlite-backend.js';
import { hydrateAll } from '../hydration.js';
import { runJsonlToSqliteMigration } from '../migration.js';

/**
 * T74 — RED test for the dual-import bug.
 *
 * Reproduces the parity-test failure mode in isolation. On every CLI
 * process startup, BOTH `hydrateAll()` (called from `index.ts`) AND the
 * `runMigrationIfNeeded` lifecycle hook (called from `core/context.ts`)
 * see the same legacy `*.events.jsonl` file and import it into SQLite —
 * but they take different code paths with no coordination on
 * idempotency:
 *
 *   1. `hydrateAll` calls `backend.appendEvent()` directly. This is a
 *      raw INSERT into the `events` table; it bypasses
 *      `idempotency_claims` entirely.
 *   2. `runJsonlToSqliteMigration` then re-imports the same JSONL via
 *      `appender.append(streamId, [...], idempotencyKey)`. The appender
 *      checks `idempotency_claims`, finds nothing (because step 1 did
 *      not record claims), and writes a NEW event with a NEW sequence
 *      and NEW eventId.
 *
 * Result: SQLite contains DUPLICATES of every event. The CLI test reads
 * SQLite and sees duplicates; the parity tests fail with `cli=6 mcp=3`.
 *
 * This test mirrors the startup ordering from `index.ts:288` /
 * `context.ts:119` against a fresh stateDir holding a single 3-event
 * JSONL file. Currently the assertion fails: SQLite contains 6 events
 * for the stream (3 from hydrateAll + 3 fresh from the migration).
 *
 * Sibling: `migration.acceptance.test.ts` (T18, runs migration only) and
 * `hydration.test.ts` (runs hydrateAll only). Neither exercises the
 * dual-call sequence that the real startup path runs.
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

describe('Startup_DualImport_NoDuplicateEvents', () => {
  let stateDir: string;

  beforeEach(async () => {
    stateDir = await mkdtemp(path.join(tmpdir(), 'dual-import-t74-'));
  });

  afterEach(async () => {
    await rm(stateDir, { recursive: true, force: true });
  });

  it('hydrateAll then runMigration on a 3-event JSONL leaves exactly 3 events in SQLite (no duplicates)', async () => {
    // ─── Fixture: one 3-event legacy JSONL file ─────────────────────────
    const streamId = 'stream-alpha';
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

    // ─── Backend (mirrors `initializeBackend` in index.ts) ──────────────
    const dbPath = path.join(stateDir, 'exarchos.db');
    const backend = new SqliteBackend(dbPath);
    backend.initialize();

    try {
      // ─── Step 1: hydrateAll (mirrors index.ts:288) ───────────────────
      // Currently this performs raw `backend.appendEvent()` INSERTs —
      // bypassing `idempotency_claims`.
      await hydrateAll(backend, stateDir);

      // ─── Step 2: runJsonlToSqliteMigration (mirrors context.ts:119
      // → run-migration-if-needed.ts → migration.ts) ───────────────────
      // The appender finds no idempotency claim (step 1 did not record
      // any) and re-imports the same JSONL with NEW sequences/eventIds.
      const summary = await runJsonlToSqliteMigration({
        stateDir,
        backend,
      });
      expect(summary.ok).toBe(true);

      // ─── Assertion: exactly 3 events for this stream ─────────────────
      // Bug shape: SQLite contains 6 events (the 3 hydrated + 3 fresh
      // from the migration's appender path). After T74 GREEN this MUST
      // collapse back to 3.
      const events = backend.queryEvents(streamId);
      expect(events).toHaveLength(3);

      // Sequences must be the originals from the JSONL (1, 2, 3),
      // not the migration-allocated 4, 5, 6.
      expect(events.map((e) => e.sequence)).toEqual([1, 2, 3]);

      // Types must match the JSONL in order (further guard against the
      // migration path silently re-creating events with derived data).
      expect(events.map((e) => e.type)).toEqual([
        'workflow.started',
        'task.assigned',
        'task.completed',
      ]);
    } finally {
      backend.close();
    }
  });
});
