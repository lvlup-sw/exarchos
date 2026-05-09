import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';

import { SqliteBackend } from './sqlite-backend.js';
import { AtomicAppender } from '../event-store/atomic-appender.js';
import { importJsonlFile } from './jsonl-importer.js';

/**
 * T20 / T21 — JSONL importer fixtures.
 *
 * The importer routes legacy `*.events.jsonl` content through the canonical
 * `AtomicAppender.append()` path. Per-event order is preserved (the JSONL
 * file's append order is the wire-order). After successful import the
 * source file is moved to `.archive-v210/<basename>`.
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

function makeEvent(streamId: string, sequence: number, type: string, i: number): PersistedEventLite {
  return {
    streamId,
    sequence,
    type,
    timestamp: new Date(2026, 0, 1, 0, 0, sequence).toISOString(),
    eventId: randomUUID(),
    data: { i },
    idempotencyKey: `${streamId}-imp-${i}`,
  };
}

describe('JsonlImporter', () => {
  let stateDir: string;
  let backend: SqliteBackend;
  let appender: AtomicAppender;

  beforeEach(async () => {
    stateDir = await mkdtemp(path.join(tmpdir(), 'jsonl-importer-'));
    backend = new SqliteBackend(path.join(stateDir, 'exarchos.db'));
    backend.initialize();
    appender = new AtomicAppender({
      stateDir,
      backend: 'sqlite',
      sqliteBackend: backend,
    });
  });

  afterEach(async () => {
    backend.close();
    await rm(stateDir, { recursive: true, force: true });
  });

  it('JsonlImporter_LegacyFile_AppendsViaAtomicAppenderInOriginalOrder', async () => {
    const streamId = 'stream-import-order';
    const events = [
      makeEvent(streamId, 1, 'workflow.started', 0),
      makeEvent(streamId, 2, 'task.assigned', 1),
      makeEvent(streamId, 3, 'task.progressed', 2),
      makeEvent(streamId, 4, 'task.completed', 3),
    ];
    const filePath = path.join(stateDir, `${streamId}.events.jsonl`);
    await writeFile(
      filePath,
      events.map((e) => JSON.stringify(e)).join('\n') + '\n',
      'utf-8',
    );

    const result = await importJsonlFile(filePath, appender, backend);

    expect(result.ok).toBe(true);
    if (result.ok !== true) return;
    expect(result.eventCount).toBe(4);

    // Events appear in the SQLite events table in the same wire-order as
    // the source file. The appender allocates fresh sequences; what we
    // verify is the type ordering — events.jsonl's append-order must
    // be preserved, even if the new sequence numbers do not match the
    // original sequences in the file.
    const persisted = backend.queryEvents(streamId);
    expect(persisted).toHaveLength(4);
    expect(persisted.map((e) => e.type)).toEqual([
      'workflow.started',
      'task.assigned',
      'task.progressed',
      'task.completed',
    ]);

    // `migration.legacy_jsonl_imported` event is emitted on the
    // `__migration__` stream so callers (lifecycle.ts wiring in T57) can
    // observe per-file telemetry without inspecting the importer's
    // return value.
    const migrationEvents = backend.queryEvents('__migration__');
    const imported = migrationEvents.filter((e) => e.type === 'migration.legacy_jsonl_imported');
    expect(imported).toHaveLength(1);
    const data = imported[0].data as { sourcePath: string; eventCount: number; durationMs: number };
    expect(data.sourcePath).toBe(filePath);
    expect(data.eventCount).toBe(4);
    expect(data.durationMs).toBeGreaterThanOrEqual(0);
  });
});
