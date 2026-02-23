import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import type { WorkflowEvent } from '../../event-store/schemas.js';
import { EventStore } from '../../event-store/store.js';
import { SqliteBackend } from '../sqlite-backend.js';
import { hydrateAll } from '../hydration.js';

// ─── Helpers ────────────────────────────────────────────────────────────────

function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'crash-recovery-'));
}

function makeEventInput(overrides: Record<string, unknown> = {}) {
  return {
    type: 'workflow.started' as const,
    ...overrides,
  };
}

// ─── Crash Recovery Tests ───────────────────────────────────────────────────

describe('Crash Recovery', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = createTempDir();
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('crashRecovery_SQLiteFailsAfterJSONL_HydrationRecoversEvent', async () => {
    // Arrange: create EventStore with a real SqliteBackend
    const stateDir = path.join(tempDir, 'state');
    fs.mkdirSync(stateDir, { recursive: true });
    const dbPath1 = path.join(tempDir, 'original.db');
    const backend1 = new SqliteBackend(dbPath1);
    backend1.initialize();
    const store = new EventStore(stateDir, { backend: backend1 });

    // Append some events normally (both JSONL and SQLite succeed)
    const normalEvents: WorkflowEvent[] = [];
    for (let i = 0; i < 3; i++) {
      const event = await store.append('crash-stream', makeEventInput({
        data: { index: i, phase: 'normal' },
      }));
      normalEvents.push(event);
    }

    // Verify normal events are in SQLite
    const beforeCrash = backend1.queryEvents('crash-stream');
    expect(beforeCrash).toHaveLength(3);

    // Mock backend.appendEvent to throw on the next call (simulating SQLite crash)
    const originalAppendEvent = backend1.appendEvent.bind(backend1);
    let crashCount = 0;
    vi.spyOn(backend1, 'appendEvent').mockImplementation((streamId, event) => {
      crashCount++;
      if (crashCount <= 1) {
        throw new Error('Simulated SQLite crash');
      }
      return originalAppendEvent(streamId, event);
    });

    // Append another event -- JSONL write succeeds, SQLite fails with logged warning
    const crashedEvent = await store.append('crash-stream', makeEventInput({
      data: { index: 3, phase: 'sqlite-failed' },
    }));

    // The event was written to JSONL but NOT to SQLite
    // SQLite should still have only the 3 normal events
    const afterCrash = backend1.queryEvents('crash-stream');
    expect(afterCrash).toHaveLength(3);

    // Restore and close
    vi.restoreAllMocks();
    backend1.close();

    // Act: create a fresh backend and hydrate from JSONL
    const dbPath2 = path.join(tempDir, 'recovered.db');
    const backend2 = new SqliteBackend(dbPath2);
    backend2.initialize();
    await hydrateAll(backend2, stateDir);

    // Assert: ALL events including the SQLite-failed one should be present
    const recovered = backend2.queryEvents('crash-stream');
    expect(recovered).toHaveLength(4);

    // Verify the crashed event is recovered
    expect(recovered[3].sequence).toBe(4);
    expect(recovered[3].data).toEqual(crashedEvent.data);

    // Verify all normal events are also present
    for (let i = 0; i < normalEvents.length; i++) {
      expect(recovered[i].sequence).toBe(normalEvents[i].sequence);
      expect(recovered[i].data).toEqual(normalEvents[i].data);
    }

    backend2.close();
  });

  it('crashRecovery_TruncatedJSONLLine_HydrationSkipsCorruptLine', async () => {
    // Arrange: create EventStore with backend, write valid events
    const stateDir = path.join(tempDir, 'state');
    fs.mkdirSync(stateDir, { recursive: true });
    const dbPath1 = path.join(tempDir, 'original.db');
    const backend1 = new SqliteBackend(dbPath1);
    backend1.initialize();
    const store = new EventStore(stateDir, { backend: backend1 });

    // Append 5 valid events
    const validEvents: WorkflowEvent[] = [];
    for (let i = 0; i < 5; i++) {
      const event = await store.append('corrupt-stream', makeEventInput({
        data: { index: i },
      }));
      validEvents.push(event);
    }

    backend1.close();

    // Manually append a truncated JSON string to the JSONL file
    const jsonlPath = path.join(stateDir, 'corrupt-stream.events.jsonl');
    const truncatedLine = '{"streamId":"corrupt-stream","sequence":6,"type":"workflow.started","sequ';
    fs.appendFileSync(jsonlPath, truncatedLine + '\n', 'utf-8');

    // Act: hydrate into a fresh backend
    const dbPath2 = path.join(tempDir, 'recovered.db');
    const backend2 = new SqliteBackend(dbPath2);
    backend2.initialize();
    await hydrateAll(backend2, stateDir);

    // Assert: all 5 valid events are present, corrupt line is skipped
    const recovered = backend2.queryEvents('corrupt-stream');
    expect(recovered).toHaveLength(5);

    for (let i = 0; i < validEvents.length; i++) {
      expect(recovered[i].sequence).toBe(validEvents[i].sequence);
      expect(recovered[i].data).toEqual(validEvents[i].data);
    }

    // getSequence should reflect only valid events
    expect(backend2.getSequence('corrupt-stream')).toBe(5);

    backend2.close();
  });

  it('crashRecovery_GetSequence_ConsistentAfterRecovery', async () => {
    // Arrange: create EventStore with backend, simulate partial failure
    const stateDir = path.join(tempDir, 'state');
    fs.mkdirSync(stateDir, { recursive: true });
    const dbPath1 = path.join(tempDir, 'original.db');
    const backend1 = new SqliteBackend(dbPath1);
    backend1.initialize();
    const store = new EventStore(stateDir, { backend: backend1 });

    // Append 4 events normally
    for (let i = 0; i < 4; i++) {
      await store.append('seq-stream', makeEventInput({
        data: { index: i },
      }));
    }

    // Make SQLite fail for the 5th and 6th events
    const originalAppendEvent = backend1.appendEvent.bind(backend1);
    let callCount = 0;
    vi.spyOn(backend1, 'appendEvent').mockImplementation((streamId, event) => {
      callCount++;
      // Fail on calls 1 and 2 (5th and 6th events)
      if (callCount <= 2) {
        throw new Error('Simulated SQLite failure');
      }
      return originalAppendEvent(streamId, event);
    });

    // Append 2 more events (JSONL succeeds, SQLite fails)
    await store.append('seq-stream', makeEventInput({ data: { index: 4 } }));
    await store.append('seq-stream', makeEventInput({ data: { index: 5 } }));

    // SQLite only has 4 events, JSONL has 6
    expect(backend1.queryEvents('seq-stream')).toHaveLength(4);

    vi.restoreAllMocks();
    backend1.close();

    // Act: hydrate into fresh backend
    const dbPath2 = path.join(tempDir, 'recovered.db');
    const backend2 = new SqliteBackend(dbPath2);
    backend2.initialize();
    await hydrateAll(backend2, stateDir);

    // Assert: getSequence matches actual number of valid events hydrated
    const recovered = backend2.queryEvents('seq-stream');
    expect(recovered).toHaveLength(6);
    expect(backend2.getSequence('seq-stream')).toBe(6);

    // Verify sequence numbers are contiguous 1-6
    for (let i = 0; i < recovered.length; i++) {
      expect(recovered[i].sequence).toBe(i + 1);
    }

    backend2.close();
  });
});
