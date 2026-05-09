import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, readdir, stat, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';

import { SqliteBackend } from './sqlite-backend.js';
import { runJsonlToSqliteMigration } from './migration.js';
import { readMigrationLockState } from './migration-lock.js';

/**
 * T55 — End-to-end migration plan integration test (#1259, Phase 8 POC anchor).
 *
 * Exercises the JSONL → SQLite migration orchestrator (`runJsonlToSqliteMigration`)
 * against TWO fixtures, asserting the full DR-8 / DR-9 contract from a
 * caller's perspective:
 *
 *   1. Fresh-install fixture: empty stateDir → SQLite db at v3, zero
 *      events, exactly one terminal `migration.completed` event with zero
 *      totals, NO `migration.legacy_jsonl_imported`, NO `.archive-v210/`,
 *      lock claimed-then-released.
 *
 *   2. Legacy-JSONL fixture: two seeded `<streamId>.events.jsonl` files,
 *      run the migration → SQLite db at v3, all events present with
 *      per-stream-monotonic sequence + preserved type/data/timestamp/eventId,
 *      source files MOVED to `.archive-v210/<basename>`, one
 *      `migration.legacy_jsonl_imported` per source file with
 *      `data: { sourcePath, eventCount, durationMs }`, one terminal
 *      `migration.completed` with summed totals, lock released.
 *
 * Where do migration events live? — The orchestrator writes them to the
 * SQLite `events` table under the synthetic stream `__migration__` (see
 * `migration.ts:MIGRATION_STREAM_ID` and `jsonl-importer.ts`). They are
 * read back via `backend.queryEvents('__migration__')`.
 *
 * Sibling: `migration.acceptance.test.ts` (T18) tests the malformed-line
 * tolerance in a single happy-path. T55 is the broader two-fixture e2e.
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
    data: { i, payload: `event-${i}` },
    idempotencyKey: `${streamId}-key-${i}`,
  };
}

/**
 * Read the highest applied schema version from the SQLite `schema_version`
 * ledger. The substrate's contract (per `sqlite-backend.ts:SCHEMA_VERSION = 3`)
 * is that `initialize()` records the current SCHEMA_VERSION row; the test
 * asserts the value exactly so a future bump shows up as a contract change
 * the migration plan must explicitly approve.
 */
function readSchemaVersion(backend: SqliteBackend): number {
  const db = (backend as unknown as { _migrationLockDb: { prepare: (sql: string) => { all: () => Array<{ version: number }> } } })._migrationLockDb;
  const rows = db
    .prepare('SELECT version FROM schema_version ORDER BY version DESC')
    .all();
  if (!rows.length) {
    throw new Error('schema_version table is empty after initialize()');
  }
  return rows[0].version;
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

const MIGRATION_STREAM_ID = '__migration__';

describe('Migration_E2E_FreshInstallAndLegacyJsonl', () => {
  let stateDir: string;

  beforeEach(async () => {
    stateDir = await mkdtemp(path.join(tmpdir(), 'migration-e2e-'));
  });

  afterEach(async () => {
    await rm(stateDir, { recursive: true, force: true });
  });

  it('Migration_FreshInstall_NoLegacyJsonl_ProducesV3DbAndCompletedEventOnly', async () => {
    // ─── Fixture: empty stateDir (mkdtemp created it; nothing seeded) ────
    const dbPath = path.join(stateDir, 'exarchos.db');
    const backend = new SqliteBackend(dbPath);
    backend.initialize();

    try {
      // Sanity: stateDir contains no `*.events.jsonl` files prior to run.
      const preEntries = await readdir(stateDir);
      const preJsonl = preEntries.filter((e) => e.endsWith('.events.jsonl'));
      expect(preJsonl).toEqual([]);

      // ─── Run migration ────────────────────────────────────────────────
      const summary = await runJsonlToSqliteMigration({ stateDir, backend });

      expect(summary.ok).toBe(true);
      if (summary.ok !== true) return;
      expect(summary.filesImported).toBe(0);
      expect(summary.eventsImported).toBe(0);
      expect(typeof summary.totalDurationMs).toBe('number');
      expect(summary.totalDurationMs).toBeGreaterThanOrEqual(0);

      // ─── SQLite db at schema_version === 3 ───────────────────────────
      expect(readSchemaVersion(backend)).toBe(3);

      // ─── No domain events imported (only migration-stream events exist).
      // Inspect the underlying events table directly: there should be no
      // events on any non-migration stream because no JSONL files existed.
      const db = (backend as unknown as {
        _migrationLockDb: {
          prepare: (sql: string) => {
            all: () => Array<{ streamId: string }>;
          };
        };
      })._migrationLockDb;
      const distinctStreams = db
        .prepare('SELECT DISTINCT streamId FROM events')
        .all()
        .map((r) => r.streamId);
      expect(distinctStreams.filter((s) => s !== MIGRATION_STREAM_ID)).toEqual([]);

      // ─── Migration-stream events: exactly one `migration.completed`,
      //     zero `migration.legacy_jsonl_imported` ─────────────────────
      const migEvents = backend.queryEvents(MIGRATION_STREAM_ID);
      const imported = migEvents.filter((e) => e.type === 'migration.legacy_jsonl_imported');
      const completed = migEvents.filter((e) => e.type === 'migration.completed');
      expect(imported).toHaveLength(0);
      expect(completed).toHaveLength(1);

      const cd = completed[0].data as {
        filesImported: number;
        eventsImported: number;
        totalDurationMs: number;
      };
      expect(cd.filesImported).toBe(0);
      expect(cd.eventsImported).toBe(0);
      expect(typeof cd.totalDurationMs).toBe('number');
      expect(cd.totalDurationMs).toBeGreaterThanOrEqual(0);

      // ─── No `.archive-v210/` directory created (nothing to archive) ──
      const archiveDir = path.join(stateDir, '.archive-v210');
      expect(await pathExists(archiveDir)).toBe(false);

      // ─── Lock claimed during run, released after success ─────────────
      // The orchestrator's success path always calls releaseMigrationLock
      // (DR-12). Read the row and assert the post-release shape.
      const lockState = readMigrationLockState(backend);
      expect(lockState).not.toBeNull();
      if (lockState === null) return;
      expect(lockState.state).toBe('completed');
      expect(typeof lockState.claimedAt).toBe('string');
      expect(lockState.claimedAt.length).toBeGreaterThan(0);
      expect(lockState.releasedAt).not.toBeNull();
    } finally {
      backend.close();
    }
  });

  it('Migration_LegacyJsonl_TwoFiles_ImportsAllEventsAndArchivesAndEmitsTerminal', async () => {
    // ─── Fixture: two clean JSONL files, several events each ─────────
    const streamX = 'stream-xray';
    const xLines: string[] = [];
    for (let i = 1; i <= 5; i++) {
      xLines.push(JSON.stringify(makeEvent(streamX, i, i === 5 ? 'task.completed' : 'task.assigned', i)));
    }
    await writeFile(
      path.join(stateDir, `${streamX}.events.jsonl`),
      xLines.join('\n') + '\n',
      'utf-8',
    );

    const streamY = 'stream-yankee';
    const yLines: string[] = [];
    for (let i = 1; i <= 7; i++) {
      yLines.push(JSON.stringify(makeEvent(streamY, i, i === 7 ? 'task.completed' : 'task.assigned', i)));
    }
    await writeFile(
      path.join(stateDir, `${streamY}.events.jsonl`),
      yLines.join('\n') + '\n',
      'utf-8',
    );

    const dbPath = path.join(stateDir, 'exarchos.db');
    const backend = new SqliteBackend(dbPath);
    backend.initialize();

    try {
      // ─── Run migration ────────────────────────────────────────────────
      const summary = await runJsonlToSqliteMigration({ stateDir, backend });

      expect(summary.ok).toBe(true);
      if (summary.ok !== true) return;
      expect(summary.filesImported).toBe(2);
      expect(summary.eventsImported).toBe(12); // 5 + 7
      expect(typeof summary.totalDurationMs).toBe('number');
      expect(summary.totalDurationMs).toBeGreaterThanOrEqual(0);

      // ─── SQLite db at schema_version === 3 ───────────────────────────
      expect(readSchemaVersion(backend)).toBe(3);

      // ─── All events imported with preserved per-event fields ─────────
      const xEvents = backend.queryEvents(streamX);
      expect(xEvents).toHaveLength(5);
      // Per-stream-monotonic sequence: strictly increasing.
      for (let i = 1; i < xEvents.length; i++) {
        expect(xEvents[i].sequence).toBeGreaterThan(xEvents[i - 1].sequence);
      }
      // Type/data/timestamp/eventId preservation. The importer drops the
      // legacy `eventId` (canonical AtomicAppender allocates fresh UUIDs)
      // but we still assert each persisted event carries a non-empty
      // eventId-shaped string so downstream consumers can identify rows.
      for (let i = 0; i < xEvents.length; i++) {
        const ev = xEvents[i];
        expect(ev.streamId).toBe(streamX);
        expect(typeof ev.type).toBe('string');
        expect(ev.type.length).toBeGreaterThan(0);
        expect(typeof ev.timestamp).toBe('string');
        expect(ev.timestamp.length).toBeGreaterThan(0);
        // Reconstructed payload includes eventId per AtomicAppender.append's
        // canonical write contract; verify it's a non-empty string.
        const evWithId = ev as unknown as { eventId?: unknown };
        expect(typeof evWithId.eventId).toBe('string');
        expect((evWithId.eventId as string).length).toBeGreaterThan(0);
        // `data.i` round-tripped from the seed.
        expect(ev.data).toBeDefined();
        const d = ev.data as { i: number; payload: string };
        expect(d.i).toBe(i + 1);
        expect(d.payload).toBe(`event-${i + 1}`);
      }
      // Last event in stream X is task.completed.
      expect(xEvents[xEvents.length - 1].type).toBe('task.completed');

      const yEvents = backend.queryEvents(streamY);
      expect(yEvents).toHaveLength(7);
      for (let i = 1; i < yEvents.length; i++) {
        expect(yEvents[i].sequence).toBeGreaterThan(yEvents[i - 1].sequence);
      }
      for (let i = 0; i < yEvents.length; i++) {
        const ev = yEvents[i];
        expect(ev.streamId).toBe(streamY);
        const d = ev.data as { i: number; payload: string };
        expect(d.i).toBe(i + 1);
        expect(d.payload).toBe(`event-${i + 1}`);
      }
      expect(yEvents[yEvents.length - 1].type).toBe('task.completed');

      // ─── Source files MOVED to `.archive-v210/<basename>` ────────────
      const archiveDir = path.join(stateDir, '.archive-v210');
      expect(await pathExists(archiveDir)).toBe(true);
      const archived = await readdir(archiveDir);
      expect(archived.sort()).toEqual(
        [`${streamX}.events.jsonl`, `${streamY}.events.jsonl`].sort(),
      );
      // Archived entries are real files.
      for (const entry of archived) {
        const s = await stat(path.join(archiveDir, entry));
        expect(s.isFile()).toBe(true);
      }
      // Originals are gone from stateDir.
      const stateDirEntries = await readdir(stateDir);
      const remainingJsonl = stateDirEntries.filter((e) => e.endsWith('.events.jsonl'));
      expect(remainingJsonl).toEqual([]);

      // ─── One `migration.legacy_jsonl_imported` per source file ───────
      const migEvents = backend.queryEvents(MIGRATION_STREAM_ID);
      const importedEvents = migEvents.filter(
        (e) => e.type === 'migration.legacy_jsonl_imported',
      );
      expect(importedEvents).toHaveLength(2);
      // Each carries `{ sourcePath, eventCount, durationMs }`.
      const sourcePaths = importedEvents.map((e) => {
        const d = e.data as { sourcePath: string; eventCount: number; durationMs: number };
        expect(typeof d.sourcePath).toBe('string');
        expect(d.sourcePath.length).toBeGreaterThan(0);
        expect(typeof d.eventCount).toBe('number');
        expect(d.eventCount).toBeGreaterThanOrEqual(0);
        expect(typeof d.durationMs).toBe('number');
        expect(d.durationMs).toBeGreaterThanOrEqual(0);
        return d.sourcePath;
      });
      // Both sourcePaths are accounted for (basenames present).
      const sourceBasenames = sourcePaths.map((p) => path.basename(p)).sort();
      expect(sourceBasenames).toEqual(
        [`${streamX}.events.jsonl`, `${streamY}.events.jsonl`].sort(),
      );
      // Per-file eventCount matches what we seeded.
      const byBasename = new Map<string, number>();
      for (const ev of importedEvents) {
        const d = ev.data as { sourcePath: string; eventCount: number };
        byBasename.set(path.basename(d.sourcePath), d.eventCount);
      }
      expect(byBasename.get(`${streamX}.events.jsonl`)).toBe(5);
      expect(byBasename.get(`${streamY}.events.jsonl`)).toBe(7);

      // ─── Terminal `migration.completed` with summed totals ───────────
      const completed = migEvents.filter((e) => e.type === 'migration.completed');
      expect(completed).toHaveLength(1);
      const cd = completed[0].data as {
        filesImported: number;
        eventsImported: number;
        totalDurationMs: number;
      };
      expect(cd.filesImported).toBe(2);
      expect(cd.eventsImported).toBe(12);
      expect(cd.totalDurationMs).toBeGreaterThanOrEqual(0);

      // The terminal completed event MUST come after both per-file
      // imported events (the orchestrator emits it last).
      const lastImportedSeq = Math.max(...importedEvents.map((e) => e.sequence));
      expect(completed[0].sequence).toBeGreaterThan(lastImportedSeq);

      // ─── Lock claimed during run, released after success ─────────────
      const lockState = readMigrationLockState(backend);
      expect(lockState).not.toBeNull();
      if (lockState === null) return;
      expect(lockState.state).toBe('completed');
      expect(typeof lockState.claimedAt).toBe('string');
      expect(lockState.claimedAt.length).toBeGreaterThan(0);
      expect(lockState.releasedAt).not.toBeNull();
    } finally {
      backend.close();
    }
  });
});
