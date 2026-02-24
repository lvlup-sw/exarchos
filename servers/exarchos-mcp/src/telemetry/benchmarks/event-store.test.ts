import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { EventStore } from '../../event-store/store.js';
import { generateWorkflowEvents } from './cold-start.js';

const RUN_BENCHMARKS = process.env.RUN_BENCHMARKS === 'true';

// ─── Benchmark Suite ──────────────────────────────────────────────────────

describe('Event Store Benchmarks', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'event-store-bench-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  // ─── 1. Single Event Append ───────────────────────────────────────────────

  it.skipIf(!RUN_BENCHMARKS)(
    'append_SingleEvent_CompletesWithinThreshold',
    async () => {
      // Arrange
      const store = new EventStore(tmpDir);
      await store.initialize();

      // Act
      const start = performance.now();
      await store.append('bench-single', { type: 'workflow.started', data: { featureId: 'bench-single', workflowType: 'feature' } });
      const elapsed = performance.now() - start;

      // Assert
      console.log(`[event-store] single-append: ${elapsed.toFixed(3)}ms`);
      expect(elapsed).toBeLessThan(50);
    },
  );

  // ─── 2. Batch Append (50 Events) ─────────────────────────────────────────

  it.skipIf(!RUN_BENCHMARKS)(
    'batchAppend_50Events_CompletesWithinThreshold',
    async () => {
      // Arrange
      const store = new EventStore(tmpDir);
      await store.initialize();

      const events = Array.from({ length: 50 }, (_, i) => ({
        type: 'task.assigned' as const,
        data: { taskId: `task-${i}`, title: `Task ${i}`, branch: `feat/bench-${i}` },
      }));

      // Act
      const start = performance.now();
      await store.batchAppend('bench-batch', events);
      const elapsed = performance.now() - start;

      // Assert
      console.log(`[event-store] batch-append 50 events: ${elapsed.toFixed(3)}ms`);
      expect(elapsed).toBeLessThan(200);
    },
  );

  // ─── 3. Concurrent Append (10 Parallel Streams) ──────────────────────────

  it.skipIf(!RUN_BENCHMARKS)(
    'append_Concurrent10Streams_CompletesWithinThreshold',
    async () => {
      // Arrange
      const store = new EventStore(tmpDir);
      await store.initialize();

      // Act — 10 parallel appends to 10 different streams
      const start = performance.now();
      await Promise.all(
        Array.from({ length: 10 }, (_, i) =>
          store.append(`bench-concurrent-${i}`, {
            type: 'workflow.started',
            data: { featureId: `bench-concurrent-${i}`, workflowType: 'feature' },
          }),
        ),
      );
      const elapsed = performance.now() - start;

      // Assert
      console.log(`[event-store] concurrent 10 streams: ${elapsed.toFixed(3)}ms`);
      expect(elapsed).toBeLessThan(500);
    },
  );

  // ─── 4. Query 100 Events (No Filter) ─────────────────────────────────────

  it.skipIf(!RUN_BENCHMARKS)(
    'query_100EventsNoFilter_CompletesWithinThreshold',
    async () => {
      // Arrange
      const store = new EventStore(tmpDir);
      await store.initialize();

      // Seed 100 events
      const streamId = 'bench-query-no-filter';
      const batchEvents = Array.from({ length: 100 }, (_, i) => ({
        type: (i === 0 ? 'workflow.started' : 'task.assigned') as 'workflow.started' | 'task.assigned',
        data: i === 0
          ? { featureId: streamId, workflowType: 'feature' }
          : { taskId: `task-${i}`, title: `Task ${i}`, branch: `feat/bench-${i}` },
      }));
      await store.batchAppend(streamId, batchEvents);

      // Act
      const start = performance.now();
      const events = await store.query(streamId);
      const elapsed = performance.now() - start;

      // Assert
      expect(events).toHaveLength(100);
      console.log(`[event-store] query 100 events (no filter): ${elapsed.toFixed(3)}ms`);
      expect(elapsed).toBeLessThan(100);
    },
  );

  // ─── 5. Query 100 Events (Type Filter) ───────────────────────────────────

  it.skipIf(!RUN_BENCHMARKS)(
    'query_100EventsTypeFilter_CompletesWithinThreshold',
    async () => {
      // Arrange
      const store = new EventStore(tmpDir);
      await store.initialize();

      // Seed 100 events with mixed types
      const streamId = 'bench-query-type-filter';
      const batchEvents = Array.from({ length: 100 }, (_, i) => ({
        type: (i === 0 ? 'workflow.started' : i % 2 === 0 ? 'task.assigned' : 'task.completed') as 'workflow.started' | 'task.assigned' | 'task.completed',
        data: i === 0
          ? { featureId: streamId, workflowType: 'feature' }
          : i % 2 === 0
            ? { taskId: `task-${i}`, title: `Task ${i}`, branch: `feat/bench-${i}` }
            : { taskId: `task-${i}`, artifacts: ['file.ts'], duration: 5000 },
      }));
      await store.batchAppend(streamId, batchEvents);

      // Act
      const start = performance.now();
      const events = await store.query(streamId, { type: 'task.assigned' });
      const elapsed = performance.now() - start;

      // Assert
      expect(events.length).toBeGreaterThan(0);
      console.log(`[event-store] query 100 events (type filter): ${elapsed.toFixed(3)}ms`);
      expect(elapsed).toBeLessThan(100);
    },
  );

  // ─── 6. Initialize Sequence (from JSONL, 100 Events, No .seq Cache) ─────

  it.skipIf(!RUN_BENCHMARKS)(
    'initSequence_100EventsNoSeqCache_CompletesWithinThreshold',
    async () => {
      // Arrange — write JSONL file directly (bypassing EventStore to avoid .seq cache)
      const streamId = 'bench-init-seq';
      const events = generateWorkflowEvents(streamId, 100);
      const filePath = path.join(tmpDir, `${streamId}.events.jsonl`);
      const content = events.map(e => JSON.stringify(e)).join('\n') + '\n';
      writeFileSync(filePath, content, 'utf-8');

      // Ensure no .seq file exists
      const seqPath = path.join(tmpDir, `${streamId}.seq`);
      try {
        await fs.unlink(seqPath);
      } catch {
        // Expected: no .seq file to delete
      }

      // Act — create fresh store and append (which triggers initializeSequence)
      const start = performance.now();
      const store = new EventStore(tmpDir);
      await store.initialize();
      await store.append(streamId, { type: 'task.completed', data: { taskId: 'task-final', artifacts: [], duration: 100 } });
      const elapsed = performance.now() - start;

      // Assert — the append succeeded, meaning sequence was initialized correctly
      const allEvents = await store.query(streamId);
      expect(allEvents).toHaveLength(101);
      console.log(`[event-store] init-sequence from JSONL (100 events): ${elapsed.toFixed(3)}ms`);
      expect(elapsed).toBeLessThan(100);
    },
  );
});
