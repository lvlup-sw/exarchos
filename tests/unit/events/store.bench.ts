/**
 * EventStore micro-benchmarks on the SQLite substrate. Advisory only.
 *
 * `bench()` only observes. It cannot fail CI. The merge gate for append throughput is
 * `append-cost-budget.test.ts`. That test counts the statements and transactions of each
 * append and fails on an extra one, so its verdict does not depend on the runner.
 * The `AppendUnkeyed_5000Sequential_SqliteBackend` arm times 5000 sequential appends on one stream.
 * Its reference figure is 1000 appends per second.
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

function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'bench-es-'));
}

function cleanupDir(dir: string): void {
  rmrf(dir);
}

/** Seeds a state directory with `count` events on `streamId` through `EventStore.append`. */
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

const QUERY_STREAM = 'query-stream';
/**
 * A directory that holds 1000 events for the two query arms. A top-level `await` seeds it
 * at module load, before the bench framework collects the arms.
 */
const QUERY_DIR = createTempDir();
await seedSqliteDir(QUERY_DIR, QUERY_STREAM, 1000);

/** A `beforeExit` handler removes `QUERY_DIR`. The removal is best-effort. */
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

  process.once('beforeExit', () => {
    try { cleanupDir(QUERY_DIR); } catch { }
  });
});
