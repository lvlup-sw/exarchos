import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { fc } from '@fast-check/vitest';
import * as path from 'node:path';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { EventStore } from './store.js';
import { EventTypes } from './schemas.js';
import { rmrfAsync } from '../../tools/test-helpers/temp-dir.js';

// ─── Shared Setup ─────────────────────────────────────────────────────────

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(tmpdir(), 'pbt-event-store-'));
});

afterEach(async () => {
  await rmrfAsync(tempDir);
});

// ─── Event Generators ─────────────────────────────────────────────────────

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

// ─── Property Tests ─────────────────────────────────────────────────────

/**
 * Storage-primitive property suite over the (sole) SQLite substrate.
 *
 * Pre-Phase-3 (v2.11 substrate-cut), this suite was parametrized over
 * the legacy JSONL writer and the SQLite writer via
 * `EventStoreOptions.appenderBackend` (T51, #1259). Phase 3 collapsed
 * the option, leaving SQLite as the only substrate; the cross-substrate
 * fold-determinism property and the stale-`.seq` cross-validation tests
 * (which manipulated JSONL-only artifacts) were removed alongside.
 */
describe('EventStore Property Tests', () => {
  describe('EventStore_AppendThenQuery_PreservesOrder', () => {
    it('for any sequence of N events (1-20), query() returns them sorted by ascending sequence', async () => {
      await fc.assert(
        fc.asyncProperty(arbEventSequence, async (events) => {
          // Each property run gets its own isolated store
          const runDir = await mkdtemp(path.join(tempDir, 'run-'));
          const store = new EventStore(runDir);
          const streamId = 'test-stream';

          // Append all events sequentially
          for (const event of events) {
            await store.append(streamId, event);
          }

          // Query all events
          const queried = await store.query(streamId);

          // Verify count matches
          expect(queried).toHaveLength(events.length);

          // Verify ascending sequence order
          for (let i = 0; i < queried.length; i++) {
            expect(queried[i].sequence).toBe(i + 1);
          }

          // Verify each pair is strictly ascending
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

          // Append twice with the same idempotency key
          const first = await store.append(streamId, event, { idempotencyKey: key });
          const second = await store.append(streamId, event, { idempotencyKey: key });

          // Both should return the same event
          expect(first.sequence).toBe(second.sequence);
          expect(first.idempotencyKey).toBe(second.idempotencyKey);

          // Query should return exactly one event
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

          // Append all events
          for (const event of events) {
            await store.append(streamId, event);
          }

          // Query all events
          const allEvents = await store.query(streamId);

          // Query filtered by type
          const filtered = await store.query(streamId, { type: filterType });

          // Filtered result must be a subset of all events
          expect(filtered.length).toBeLessThanOrEqual(allEvents.length);

          // Every filtered event must exist in the full set
          const allSequences = new Set(allEvents.map((e) => e.sequence));
          for (const event of filtered) {
            expect(allSequences.has(event.sequence)).toBe(true);
            expect(event.type).toBe(filterType);
          }

          // Count of filtered type in full set must match filtered count
          const expectedCount = allEvents.filter((e) => e.type === filterType).length;
          expect(filtered).toHaveLength(expectedCount);
        }),
        { numRuns: 50 },
      );
    });
  });
});
