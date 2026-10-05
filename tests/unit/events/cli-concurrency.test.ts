/**
 * Concurrent appends to one feature stream. When N callers race, the store must hold
 * every event exactly once, with the sequences 1 to N and each idempotency key.
 *
 * The callers run in one process, on one shared `EventStore`, through `Promise.all`.
 * The test spawns no CLI process. The per-stream mutex of the appender serializes the appends.
 * Across processes, the SQLite WAL serializes the writers. `store.race.test.ts` holds
 * that contract: two stores on one state directory both initialize.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';

import { EventStore } from '../../../src/events/store.js';
import { buildValidatedEvent } from '../../../src/events/event-factory.js';
import type { WorkflowEvent } from '../../../src/events/schemas.js';
import { rmrfAsync } from '../../../tools/test-helpers/temp-dir.js';

const STREAM_ID = 'concurrency-canary';
const CONCURRENCY = 10;

describe('DR-5: concurrent CLI append safety', () => {
  let stateDir: string;

  beforeEach(async () => {
    stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cli-concurrency-'));
  });

  afterEach(async () => {
    await rmrfAsync(stateDir);
  });

  /**
   * Each append omits `expectedSequence`, so the store assigns the sequence.
   * To detect a half-written row, the shape loop reads `type`, `streamId` and `timestamp` of each event.
   * The last assertion makes sure that no append leaves a hook-event sidecar file.
   */
  it('ConcurrentCliEventAppend_SameFeatureId_ProducesConsistentStore', async () => {
    const store = new EventStore(stateDir);
    await store.initialize();

    const appends = Array.from({ length: CONCURRENCY }, (_, i) => {
      const event = buildValidatedEvent(STREAM_ID, 1, {
        type: 'task.completed',
        data: { taskId: `t-${i}`, verified: false },
      });
      return store.appendValidated(STREAM_ID, event, {
        idempotencyKey: `concurrent-${i}`,
      });
    });
    const acks = await Promise.all(appends);

    expect(acks.length).toBe(CONCURRENCY);
    for (const ack of acks) {
      expect(typeof ack.sequence).toBe('number');
    }

    const events = await store.query(STREAM_ID);

    expect(events.length).toBe(CONCURRENCY);

    const sequences = events.map((e) => e.sequence).sort((a, b) => a - b);
    const expected = Array.from({ length: CONCURRENCY }, (_, i) => i + 1);
    expect(sequences).toEqual(expected);

    const keys = new Set(
      events
        .map((e: WorkflowEvent) => e.idempotencyKey)
        .filter((k): k is string => typeof k === 'string'),
    );
    for (let i = 0; i < CONCURRENCY; i++) {
      expect(keys.has(`concurrent-${i}`)).toBe(true);
    }

    for (const ev of events) {
      expect(typeof ev.type).toBe('string');
      expect(ev.type.length).toBeGreaterThan(0);
      expect(ev.streamId).toBe(STREAM_ID);
      expect(typeof ev.timestamp).toBe('string');
    }

    const sidecarPath = path.join(stateDir, `${STREAM_ID}.hook-events.jsonl`);
    await expect(fs.access(sidecarPath)).rejects.toThrow();
  }, 60_000);
});
