import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { fc } from '@fast-check/vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import type { WorkflowEvent } from '../event-store/schemas.js';
import { SqliteBackend } from './sqlite-backend.js';
import { hydrateStream, hydrateAll } from './hydration.js';

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeEvent(overrides: Partial<WorkflowEvent> = {}): WorkflowEvent {
  return {
    streamId: 'test-stream',
    sequence: 1,
    timestamp: '2024-01-01T00:00:00.000Z',
    type: 'workflow.started',
    schemaVersion: '1.0',
    ...overrides,
  } as WorkflowEvent;
}

function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'hydration-test-'));
}

function writeJsonlFile(dir: string, streamId: string, events: WorkflowEvent[]): void {
  const filePath = path.join(dir, `${streamId}.events.jsonl`);
  const content = events.map((e) => JSON.stringify(e)).join('\n') + (events.length > 0 ? '\n' : '');
  fs.writeFileSync(filePath, content, 'utf-8');
}

// ─── hydrateStream Tests ────────────────────────────────────────────────────

describe('hydrateStream', () => {
  let backend: SqliteBackend;
  let tempDir: string;

  beforeEach(() => {
    backend = new SqliteBackend(':memory:');
    backend.initialize();
    tempDir = createTempDir();
  });

  afterEach(() => {
    backend.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('hydrateStream_EmptyDB_InsertsAllEvents', async () => {
    // Arrange
    const events = [
      makeEvent({ streamId: 'my-stream', sequence: 1, type: 'workflow.started' }),
      makeEvent({ streamId: 'my-stream', sequence: 2, type: 'task.assigned' }),
      makeEvent({ streamId: 'my-stream', sequence: 3, type: 'task.completed' }),
    ];
    writeJsonlFile(tempDir, 'my-stream', events);

    // Act
    await hydrateStream(backend, tempDir, 'my-stream');

    // Assert
    const stored = backend.queryEvents('my-stream');
    expect(stored).toHaveLength(3);
    expect(stored[0].sequence).toBe(1);
    expect(stored[1].sequence).toBe(2);
    expect(stored[2].sequence).toBe(3);
    expect(backend.getSequence('my-stream')).toBe(3);
  });

  it('hydrateStream_PartialDB_InsertsOnlyDeltaEvents', async () => {
    // Arrange: pre-populate SQLite with events 1 and 2
    backend.appendEvent('my-stream', makeEvent({ streamId: 'my-stream', sequence: 1, type: 'workflow.started' }));
    backend.appendEvent('my-stream', makeEvent({ streamId: 'my-stream', sequence: 2, type: 'task.assigned' }));

    // JSONL has events 1-4
    const events = [
      makeEvent({ streamId: 'my-stream', sequence: 1, type: 'workflow.started' }),
      makeEvent({ streamId: 'my-stream', sequence: 2, type: 'task.assigned' }),
      makeEvent({ streamId: 'my-stream', sequence: 3, type: 'task.completed' }),
      makeEvent({ streamId: 'my-stream', sequence: 4, type: 'gate.executed' }),
    ];
    writeJsonlFile(tempDir, 'my-stream', events);

    // Act
    await hydrateStream(backend, tempDir, 'my-stream');

    // Assert: only events 3 and 4 were inserted (delta)
    const stored = backend.queryEvents('my-stream');
    expect(stored).toHaveLength(4);
    expect(stored[2].sequence).toBe(3);
    expect(stored[3].sequence).toBe(4);
    expect(backend.getSequence('my-stream')).toBe(4);
  });

  it('hydrateStream_CorruptJSONLLine_SkipsAndContinues', async () => {
    // Arrange: write JSONL with a corrupt line in the middle
    const filePath = path.join(tempDir, 'my-stream.events.jsonl');
    const lines = [
      JSON.stringify(makeEvent({ streamId: 'my-stream', sequence: 1, type: 'workflow.started' })),
      '{this is not valid json',
      JSON.stringify(makeEvent({ streamId: 'my-stream', sequence: 3, type: 'task.completed' })),
    ];
    fs.writeFileSync(filePath, lines.join('\n') + '\n', 'utf-8');

    // Act — should not throw
    await hydrateStream(backend, tempDir, 'my-stream');

    // Assert: events 1 and 3 were inserted; corrupt line was skipped
    const stored = backend.queryEvents('my-stream');
    expect(stored).toHaveLength(2);
    expect(stored[0].sequence).toBe(1);
    expect(stored[1].sequence).toBe(3);
  });

  it('hydrateStream_EmptyJSONL_NoOps', async () => {
    // Arrange: write an empty JSONL file
    const filePath = path.join(tempDir, 'my-stream.events.jsonl');
    fs.writeFileSync(filePath, '', 'utf-8');

    // Act
    await hydrateStream(backend, tempDir, 'my-stream');

    // Assert
    const stored = backend.queryEvents('my-stream');
    expect(stored).toHaveLength(0);
    expect(backend.getSequence('my-stream')).toBe(0);
  });

  it('hydrateStream_FastSkip_SkipsLinesBeforeDBSequence', async () => {
    // Arrange: pre-populate with 5 events
    for (let i = 1; i <= 5; i++) {
      backend.appendEvent('my-stream', makeEvent({ streamId: 'my-stream', sequence: i }));
    }

    // JSONL has events 1-8
    const events: WorkflowEvent[] = [];
    for (let i = 1; i <= 8; i++) {
      events.push(makeEvent({ streamId: 'my-stream', sequence: i }));
    }
    writeJsonlFile(tempDir, 'my-stream', events);

    // Act
    await hydrateStream(backend, tempDir, 'my-stream');

    // Assert: events 6-8 were inserted
    const stored = backend.queryEvents('my-stream');
    expect(stored).toHaveLength(8);
    expect(backend.getSequence('my-stream')).toBe(8);
  });

  it('hydrateStream_MissingJSONLFile_NoOps', async () => {
    // Act: hydrate a stream that has no JSONL file — should not throw
    await hydrateStream(backend, tempDir, 'nonexistent-stream');

    // Assert
    const stored = backend.queryEvents('nonexistent-stream');
    expect(stored).toHaveLength(0);
  });
});

// ─── hydrateAll Tests ───────────────────────────────────────────────────────

describe('hydrateAll', () => {
  let backend: SqliteBackend;
  let tempDir: string;

  beforeEach(() => {
    backend = new SqliteBackend(':memory:');
    backend.initialize();
    tempDir = createTempDir();
  });

  afterEach(() => {
    backend.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('hydrateAll_MultipleStreams_HydratesEach', async () => {
    // Arrange: two different streams
    const eventsA = [
      makeEvent({ streamId: 'stream-a', sequence: 1, type: 'workflow.started' }),
      makeEvent({ streamId: 'stream-a', sequence: 2, type: 'task.assigned' }),
    ];
    const eventsB = [
      makeEvent({ streamId: 'stream-b', sequence: 1, type: 'workflow.started' }),
    ];
    writeJsonlFile(tempDir, 'stream-a', eventsA);
    writeJsonlFile(tempDir, 'stream-b', eventsB);

    // Act
    await hydrateAll(backend, tempDir);

    // Assert
    const storedA = backend.queryEvents('stream-a');
    expect(storedA).toHaveLength(2);

    const storedB = backend.queryEvents('stream-b');
    expect(storedB).toHaveLength(1);
  });

  it('hydrateAll_EmptyDirectory_NoOps', async () => {
    // Act — no JSONL files in the directory
    await hydrateAll(backend, tempDir);

    // Assert — no errors, no events
    // If we could list all events somehow, we'd expect zero.
    // Just verify no throw occurred.
  });
});

// ─── Property Tests ─────────────────────────────────────────────────────────

describe('Hydration Property Tests', () => {
  it('hydrateStream_Idempotent_NoDuplicates', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 20 }),
        async (count) => {
          const propDir = createTempDir();
          const backend = new SqliteBackend(':memory:');
          backend.initialize();

          try {
            const streamId = 'idem-stream';
            const events: WorkflowEvent[] = [];
            for (let i = 1; i <= count; i++) {
              events.push(
                makeEvent({
                  streamId,
                  sequence: i,
                  type: 'workflow.started',
                  timestamp: `2024-01-01T00:00:${String(i).padStart(2, '0')}.000Z`,
                }),
              );
            }
            writeJsonlFile(propDir, streamId, events);

            // First hydration
            await hydrateStream(backend, propDir, streamId);
            const afterFirst = backend.queryEvents(streamId);

            // Second hydration (idempotent)
            await hydrateStream(backend, propDir, streamId);
            const afterSecond = backend.queryEvents(streamId);

            expect(afterSecond).toHaveLength(afterFirst.length);
            for (let i = 0; i < afterFirst.length; i++) {
              expect(afterSecond[i].sequence).toBe(afterFirst[i].sequence);
              expect(afterSecond[i].type).toBe(afterFirst[i].type);
            }
          } finally {
            backend.close();
            fs.rmSync(propDir, { recursive: true, force: true });
          }
        },
      ),
    );
  });

  it('hydrateStream_SequencePreserved_MatchesJsonl', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 20 }),
        async (count) => {
          const propDir = createTempDir();
          const backend = new SqliteBackend(':memory:');
          backend.initialize();

          try {
            const streamId = 'seq-stream';
            const events: WorkflowEvent[] = [];
            for (let i = 1; i <= count; i++) {
              events.push(
                makeEvent({
                  streamId,
                  sequence: i,
                  type: 'workflow.started',
                  timestamp: `2024-01-01T00:00:${String(i).padStart(2, '0')}.000Z`,
                }),
              );
            }
            writeJsonlFile(propDir, streamId, events);

            await hydrateStream(backend, propDir, streamId);
            const stored = backend.queryEvents(streamId);

            // Sequences must match exactly
            expect(stored).toHaveLength(events.length);
            for (let i = 0; i < events.length; i++) {
              expect(stored[i].sequence).toBe(events[i].sequence);
            }
          } finally {
            backend.close();
            fs.rmSync(propDir, { recursive: true, force: true });
          }
        },
      ),
    );
  });
});
