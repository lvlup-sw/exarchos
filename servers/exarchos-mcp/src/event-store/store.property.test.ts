import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { fc } from '@fast-check/vitest';
import * as path from 'node:path';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { EventStore } from './store.js';
import { EventTypes } from './schemas.js';

// ─── Shared Setup ─────────────────────────────────────────────────────────

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(tmpdir(), 'pbt-event-store-'));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
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

/** Generate a valid stream ID (lowercase alphanumeric + hyphens). */
const arbStreamId = fc
  .stringMatching(/^[a-z][a-z0-9-]{2,19}$/)
  .filter((s) => s.length >= 3);

/** Generate a unique idempotency key. */
const arbIdempotencyKey = fc.uuid();

// ─── Property Tests ─────────────────────────────────────────────────────

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

// ─── Stale .seq Cross-Validation Tests (#939) ────────────────────────────

describe('EventStore Stale .seq Cross-Validation', () => {
  it('initializeSequence_StaleSeqFile_UsesJsonlLineCount', async () => {
    const runDir = await mkdtemp(path.join(tempDir, 'stale-seq-'));
    const store1 = new EventStore(runDir);
    const streamId = 'test-stale';

    // Append 3 events via store1
    await store1.append(streamId, { type: 'workflow.started', data: {} });
    await store1.append(streamId, { type: 'task.assigned', data: {} });
    await store1.append(streamId, { type: 'task.claimed', data: {} });

    // Manually overwrite .seq with stale value (1 instead of 3)
    const seqPath = path.join(runDir, `${streamId}.seq`);
    await writeFile(seqPath, JSON.stringify({ sequence: 1 }), 'utf-8');

    // Create a new store instance (forces re-initialization from disk)
    const store2 = new EventStore(runDir);

    // Append a 4th event — should get sequence 4, not 2
    const event = await store2.append(streamId, { type: 'workflow.transition', data: {} });
    expect(event.sequence).toBe(4);
  });

  it('handleTaskClaim_StaleSeqFile_ClaimSucceeds', async () => {
    // Import the task tools
    const { handleTaskClaim, resetModuleEventStore } = await import('../tasks/tools.js');
    const { resetMaterializerCache } = await import('../views/tools.js');

    const runDir = await mkdtemp(path.join(tempDir, 'stale-claim-'));
    const store1 = new EventStore(runDir);
    const streamId = 'wf-stale';

    // Seed with initial events
    await store1.append(streamId, { type: 'workflow.started', data: {} });
    await store1.append(streamId, { type: 'task.assigned', data: {} });

    // Write stale .seq (says 1, but JSONL has 2 events)
    const seqPath = path.join(runDir, `${streamId}.seq`);
    await writeFile(seqPath, JSON.stringify({ sequence: 1 }), 'utf-8');

    // Reset module-level caches so handleTaskClaim creates a fresh store
    resetModuleEventStore();
    resetMaterializerCache();

    // Call handleTaskClaim — should succeed, not fail with CLAIM_FAILED
    const result = await handleTaskClaim(
      { taskId: 't-stale', agentId: 'agent-stale', streamId },
      runDir,
      store1,
    );

    expect(result.success).toBe(true);

    // Cleanup module state
    resetModuleEventStore();
    resetMaterializerCache();
  });
});
