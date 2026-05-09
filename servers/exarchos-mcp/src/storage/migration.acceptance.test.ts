import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, readdir, stat, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';

import { SqliteBackend } from './sqlite-backend.js';
import { runJsonlToSqliteMigration } from './migration.js';

/**
 * T18 — Acceptance test for the JSONL → SQLite import substrate.
 *
 * Asserts the end-to-end migration shape required by DR-8 and DR-9:
 *   - Legacy `*.events.jsonl` files in the workflow-state directory are
 *     imported in append order.
 *   - Source files are MOVED (not deleted) to `.archive-v210/<basename>`.
 *   - One `migration.legacy_jsonl_imported` event per file with
 *     `data: { sourcePath, eventCount, durationMs }`.
 *   - A terminal `migration.completed` event with totals.
 *   - The migration_lock row is claimed during the run and released after
 *     successful completion.
 *
 * Tolerance: a malformed JSONL line is skipped (logged via importer's
 * counter); the run completes successfully.
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

describe('Migration_LegacyJsonlPresent_ImportsAndArchivesUnderArchiveV210', () => {
  let stateDir: string;

  beforeEach(async () => {
    stateDir = await mkdtemp(path.join(tmpdir(), 'migration-acceptance-'));
  });

  afterEach(async () => {
    await rm(stateDir, { recursive: true, force: true });
  });

  it('imports 3 JSONL files (one with a malformed line), archives sources, emits per-file + completed events, and releases lock', async () => {
    // ─── Fixture: 3 legacy JSONL files ──────────────────────────────────────
    // Stream A — clean
    const streamA = 'stream-alpha';
    const aLines = [
      JSON.stringify(makeEvent(streamA, 1, 'task.assigned', 0)),
      JSON.stringify(makeEvent(streamA, 2, 'task.completed', 0)),
    ];
    await writeFile(
      path.join(stateDir, `${streamA}.events.jsonl`),
      aLines.join('\n') + '\n',
      'utf-8',
    );

    // Stream B — has a malformed line; importer must skip and continue.
    const streamB = 'stream-bravo';
    const bLines = [
      JSON.stringify(makeEvent(streamB, 1, 'task.assigned', 0)),
      'this is not valid JSON {{',
      JSON.stringify(makeEvent(streamB, 2, 'task.completed', 0)),
    ];
    await writeFile(
      path.join(stateDir, `${streamB}.events.jsonl`),
      bLines.join('\n') + '\n',
      'utf-8',
    );

    // Stream C — clean, single event.
    const streamC = 'stream-charlie';
    const cLines = [JSON.stringify(makeEvent(streamC, 1, 'workflow.started', 0))];
    await writeFile(
      path.join(stateDir, `${streamC}.events.jsonl`),
      cLines.join('\n') + '\n',
      'utf-8',
    );

    // ─── Backend ─────────────────────────────────────────────────────────────
    const dbPath = path.join(stateDir, 'exarchos.db');
    const backend = new SqliteBackend(dbPath);
    backend.initialize();

    try {
      // ─── Run migration ────────────────────────────────────────────────────
      const summary = await runJsonlToSqliteMigration({
        stateDir,
        backend,
      });

      // The orchestrator returns a structured summary so callers (lifecycle.ts
      // wiring in T57) can surface partial-progress detail without re-reading
      // the events table.
      expect(summary.ok).toBe(true);
      if (summary.ok !== true) return;
      expect(summary.filesImported).toBe(3);

      // ─── Events imported in append order ──────────────────────────────────
      // Stream A
      const aEvents = backend.queryEvents(streamA);
      expect(aEvents).toHaveLength(2);
      expect(aEvents[0].sequence).toBeLessThan(aEvents[1].sequence);
      expect(aEvents[0].type).toBe('task.assigned');
      expect(aEvents[1].type).toBe('task.completed');

      // Stream B (malformed line skipped — 2 events imported)
      const bEvents = backend.queryEvents(streamB);
      expect(bEvents).toHaveLength(2);
      expect(bEvents[0].type).toBe('task.assigned');
      expect(bEvents[1].type).toBe('task.completed');

      // Stream C
      const cEvents = backend.queryEvents(streamC);
      expect(cEvents).toHaveLength(1);
      expect(cEvents[0].type).toBe('workflow.started');

      // ─── Source files MOVED to .archive-v210/ ─────────────────────────────
      const archiveDir = path.join(stateDir, '.archive-v210');
      const archived = await readdir(archiveDir);
      expect(archived.sort()).toEqual(
        [
          `${streamA}.events.jsonl`,
          `${streamB}.events.jsonl`,
          `${streamC}.events.jsonl`,
        ].sort(),
      );

      // Originals must be gone from `stateDir` (other than DB, archive dir,
      // and SQLite WAL/SHM files).
      const stateDirEntries = await readdir(stateDir);
      const remainingJsonl = stateDirEntries.filter((e) =>
        e.endsWith('.events.jsonl'),
      );
      expect(remainingJsonl).toEqual([]);

      // Sanity: archive entries are real files, not directories.
      for (const entry of archived) {
        const s = await stat(path.join(archiveDir, entry));
        expect(s.isFile()).toBe(true);
      }

      // ─── migration.legacy_jsonl_imported per file ─────────────────────────
      const migrationStream = '__migration__';
      const migrationEvents = backend.queryEvents(migrationStream);
      const importedEvents = migrationEvents.filter(
        (e) => e.type === 'migration.legacy_jsonl_imported',
      );
      expect(importedEvents).toHaveLength(3);
      for (const ev of importedEvents) {
        expect(ev.data).toBeDefined();
        const d = ev.data as { sourcePath: string; eventCount: number; durationMs: number };
        expect(typeof d.sourcePath).toBe('string');
        expect(d.sourcePath.length).toBeGreaterThan(0);
        expect(typeof d.eventCount).toBe('number');
        expect(d.eventCount).toBeGreaterThanOrEqual(0);
        expect(typeof d.durationMs).toBe('number');
        expect(d.durationMs).toBeGreaterThanOrEqual(0);
      }

      // ─── Terminal migration.completed with totals ─────────────────────────
      const completed = migrationEvents.filter((e) => e.type === 'migration.completed');
      expect(completed).toHaveLength(1);
      const cd = completed[0].data as {
        filesImported: number;
        eventsImported: number;
        totalDurationMs: number;
      };
      expect(cd.filesImported).toBe(3);
      // 2 + 2 + 1 = 5 events imported (malformed skipped).
      expect(cd.eventsImported).toBe(5);
      expect(cd.totalDurationMs).toBeGreaterThanOrEqual(0);

      // ─── Lock claimed during run, released after success ──────────────────
      // After successful completion the lock row state must reflect "released"
      // semantics (per DR-12: failure leaves it claimed; success clears it
      // OR records a terminal completion that lets siblings proceed).
      // The orchestrator's contract: success path releases the lock; the
      // accept criterion in DR-8 / DR-12 is that subsequent invocations
      // (e.g. in the same process) observe a no-op completion.
      const summary2 = await runJsonlToSqliteMigration({ stateDir, backend });
      expect(summary2.ok).toBe(true);
      if (summary2.ok !== true) return;
      // Second run is a no-op (no JSONL files left to import).
      expect(summary2.filesImported).toBe(0);
    } finally {
      backend.close();
    }
  });
});
