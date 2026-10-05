import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { fc } from '@fast-check/vitest';
import * as path from 'node:path';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { EventStore } from '../../../src/events/store.js';
import { EventTypes } from '../../../src/events/schemas.js';
import { rmrfAsync } from '../../../tools/test-helpers/temp-dir.js';

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(tmpdir(), 'pbt-event-store-'));
});

afterEach(async () => {
  await rmrfAsync(tempDir);
});

/** Generate a valid event type from the schema. */
const arbEventType = fc.constantFrom(...EventTypes);

/** Generate a minimal event payload suitable for EventStore.append(). */
const arbEvent = arbEventType.map((type) => ({
  type,
  data: { generated: true },
}));

/** Generate an array of N events where N is between 1 and 20. */
const arbEventSequence = fc.array(arbEvent, { minLength: 1, maxLength: 20 });

/** Generate a unique idempotency key. */
const arbIdempotencyKey = fc.uuid();

/**
 * Property suite for the storage primitive on the SQLite substrate.
 * Each property run uses its own store in a new directory.
 */
describe('EventStore Property Tests', () => {
  describe('EventStore_AppendThenQuery_PreservesOrder', () => {
    it('for any sequence of N events (1-20), query() returns them sorted by ascending sequence', async () => {
      await fc.assert(
        fc.asyncProperty(arbEventSequence, async (events) => {
          const runDir = await mkdtemp(path.join(tempDir, 'run-'));
          const store = new EventStore(runDir);
          const streamId = 'test-stream';

          for (const event of events) {
            await store.append(streamId, event);
          }

          const queried = await store.query(streamId);

          expect(queried).toHaveLength(events.length);

          for (let i = 0; i < queried.length; i++) {
            expect(queried[i].sequence).toBe(i + 1);
          }

          for (let i = 1; i < queried.length; i++) {
            expect(queried[i].sequence).toBeGreaterThan(queried[i - 1].sequence);
          }
        }),
        { numRuns: 50 },
      );
    });
  });

  describe('EventStore_IdempotentAppend_NoDuplicates', () => {
    it('appending same event with same idempotencyKey twice produces only one event', async () => {
      await fc.assert(
        fc.asyncProperty(arbEvent, arbIdempotencyKey, async (event, key) => {
          const runDir = await mkdtemp(path.join(tempDir, 'run-'));
          const store = new EventStore(runDir);
          const streamId = 'test-stream';

          const first = await store.append(streamId, event, { idempotencyKey: key });
          const second = await store.append(streamId, event, { idempotencyKey: key });

          expect(first.sequence).toBe(second.sequence);
          expect(first.idempotencyKey).toBe(second.idempotencyKey);

          const queried = await store.query(streamId);
          expect(queried).toHaveLength(1);
        }),
        { numRuns: 50 },
      );
    });
  });

  describe('EventStore_QueryWithTypeFilter_SubsetOfAll', () => {
    it('for any event type, query(streamId, { type }) is always a subset of query(streamId)', async () => {
      await fc.assert(
        fc.asyncProperty(arbEventSequence, arbEventType, async (events, filterType) => {
          const runDir = await mkdtemp(path.join(tempDir, 'run-'));
          const store = new EventStore(runDir);
          const streamId = 'test-stream';

          for (const event of events) {
            await store.append(streamId, event);
          }

          const allEvents = await store.query(streamId);

          const filtered = await store.query(streamId, { type: filterType });

          expect(filtered.length).toBeLessThanOrEqual(allEvents.length);

          const allSequences = new Set(allEvents.map((e) => e.sequence));
          for (const event of filtered) {
            expect(allSequences.has(event.sequence)).toBe(true);
            expect(event.type).toBe(filterType);
          }

          const expectedCount = allEvents.filter((e) => e.type === filterType).length;
          expect(filtered).toHaveLength(expectedCount);
        }),
        { numRuns: 50 },
      );
    });
  });
});
