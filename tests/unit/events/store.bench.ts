/**
 * EventStore micro-benchmarks on the SQLite substrate. Advisory only.
 *
 * `bench()` only observes; it cannot fail CI. The merge gate for append
 * throughput is `append-cost-budget.test.ts`: it counts the statements and
 * transactions of each append and fails on any extra one, so its verdict does
 * not depend on the runner (#2029). The `AppendUnkeyed_5000Sequential_SqliteBackend`
 * arm below reports the old 1000 ops/sec per stream figure as a measurement.
 *
 * Run: `npm run bench`, or `npx vitest bench --run store.bench`.
 */

import { bench, describe } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { EventStore } from '../../../src/events/store.js';
import { AtomicAppender } from '../../../src/events/atomic-appender.js';
import { createGateExecutedEvent } from '../../../tools/evals/benchmarks/event-factories.js';
import { rmrf } from '../../../tools/test-helpers/temp-dir.js';

// ─── Helpers ───────────────────────────────────────────────────────────────

function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'bench-es-'));
}

function cleanupDir(dir: string): void {
  rmrf(dir);
}

/**
 * Seed an SQLite-backed state directory with `count` events on `streamId`.
 * Drives `EventStore.append` through the (sole) SQLite substrate so the
 * read path finds the rows on the same backend handle.
 */
async function seedSqliteDir(dir: string, streamId: string, count: number): Promise<void> {
  fs.mkdirSync(dir, { recursive: true });
  const store = new EventStore(dir);
  for (let i = 1; i <= count; i++) {
    const event = createGateExecutedEvent(i, streamId);
    await store.append(streamId, {
      type: event.type,
      timestamp: event.timestamp,
      data: event.data,
    });
  }
}

// ─── Append Benchmarks ────────────────────────────────────────────────────

describe('EventStore Append Benchmarks', () => {
  bench(
    'Append_100Events_Sequential',
    async () => {
      const dir = createTempDir();
      try {
        const store = new EventStore(dir);
        const streamId = 'append-100';
        for (let i = 1; i <= 100; i++) {
          const event = createGateExecutedEvent(i, streamId);
          await store.append(streamId, {
            type: event.type,
            timestamp: event.timestamp,
            data: event.data,
          });
        }
      } finally {
        cleanupDir(dir);
      }
    },
    { warmupIterations: 2, iterations: 20 },
  );

  bench(
    'Append_1000Events_Sequential',
    async () => {
      const dir = createTempDir();
      try {
        const store = new EventStore(dir);
        const streamId = 'append-1k';
        for (let i = 1; i <= 1000; i++) {
          const event = createGateExecutedEvent(i, streamId);
          await store.append(streamId, {
            type: event.type,
            timestamp: event.timestamp,
            data: event.data,
          });
        }
      } finally {
        cleanupDir(dir);
      }
    },
    { warmupIterations: 1, iterations: 5 },
  );
});

describe('AtomicAppender Throughput Benchmarks', () => {
  bench(
    'AppendUnkeyed_5000Sequential_SqliteBackend',
    async () => {
      const dir = createTempDir();
      try {
        const appender = new AtomicAppender({ stateDir: dir, backend: 'sqlite' });
        const streamId = 'throughput-stream';
        const warmup = await appender.appendUnkeyed(streamId, [{ type: 'task.assigned', data: { warmup: true } }]);
        if (!warmup.ok) throw new Error(`warm-up append failed: ${warmup.reason}`);
        for (let i = 0; i < 5000; i++) {
          const r = await appender.appendUnkeyed(streamId, [{ type: 'task.assigned', data: { i } }]);
          if (!r.ok) throw new Error(`append failed at i=${i}: reason=${r.reason}`);
        }
      } finally {
        cleanupDir(dir);
      }
    },
    { warmupIterations: 0, iterations: 3 },
  );
});

// ─── Query Benchmarks ─────────────────────────────────────────────────────

// Pre-seed a directory with 1000 events at module load time using
// top-level await (NodeNext + ES2022). Both query-arm `bench()`
// callbacks close over `QUERY_DIR`, so seeding completes before the
// bench framework collects the arms.
const QUERY_STREAM = 'query-stream';
const QUERY_DIR = createTempDir();
await seedSqliteDir(QUERY_DIR, QUERY_STREAM, 1000);

describe('EventStore Query Benchmarks', () => {
  bench(
    'Query_1000Events_WithTypeFilter',
    async () => {
      const store = new EventStore(QUERY_DIR);
      await store.query(QUERY_STREAM, { type: 'gate.executed' });
    },
    { warmupIterations: 3, iterations: 50 },
  );

  bench(
    'Query_1000Events_NoFilter',
    async () => {
      const store = new EventStore(QUERY_DIR);
      await store.query(QUERY_STREAM);
    },
    { warmupIterations: 3, iterations: 50 },
  );

  // Cleanup: register a finalizer via process event (best-effort)
  process.once('beforeExit', () => {
    try { cleanupDir(QUERY_DIR); } catch { /* best-effort */ }
  });
});
