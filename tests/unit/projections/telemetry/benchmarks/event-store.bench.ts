// EventStore speed, measured in the benchmark gate rather than asserted in a
// correctness test (#2029).
//
// These arms replace `event-store.test.ts`, whose timing assertions ran only
// when RUN_BENCHMARKS was set and whose verdict measured the host. The budgets
// they asserted are the `event_store_*` keys in
// `src/projections/telemetry/benchmarks/baselines.json`: single append 50 ms,
// batch of 50 200 ms, 10 concurrent streams 500 ms, query of 100 events 100 ms
// (with and without a type filter), sequence init from 100 events 100 ms.
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { bench, describe } from 'vitest';

import { EventStore } from '../../../../../src/events/store.js';
import { rmrf } from '../../../../../tools/test-helpers/temp-dir.js';

const QUERY_STREAM = 'bench-query';
const QUERY_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'event-store-bench-query-'));
const seeded = new EventStore(QUERY_DIR);
await seeded.initialize();
await seeded.batchAppend(
  QUERY_STREAM,
  Array.from({ length: 100 }, (_, i) =>
    i === 0
      ? { type: 'workflow.started' as const, data: { featureId: QUERY_STREAM, workflowType: 'feature' } }
      : i % 2 === 0
        ? { type: 'task.assigned' as const, data: { taskId: `task-${i}`, title: `Task ${i}`, branch: `feat/bench-${i}` } }
        : { type: 'task.completed' as const, data: { taskId: `task-${i}`, artifacts: ['file.ts'], duration: 5000 } },
  ),
);

/** A fresh, initialized store in its own temp directory. */
async function freshStore(): Promise<{ store: EventStore; dir: string }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'event-store-bench-'));
  const store = new EventStore(dir);
  await store.initialize();
  return { store, dir };
}

describe('EventStore telemetry budgets', () => {
  bench(
    'append_SingleEvent',
    async () => {
      const { store, dir } = await freshStore();
      await store.append('bench-single', {
        type: 'workflow.started',
        data: { featureId: 'bench-single', workflowType: 'feature' },
      });
      rmrf(dir);
    },
    { warmupIterations: 2, iterations: 20 },
  );

  bench(
    'batchAppend_50Events',
    async () => {
      const { store, dir } = await freshStore();
      await store.batchAppend(
        'bench-batch',
        Array.from({ length: 50 }, (_, i) => ({
          type: 'task.assigned' as const,
          data: { taskId: `task-${i}`, title: `Task ${i}`, branch: `feat/bench-${i}` },
        })),
      );
      rmrf(dir);
    },
    { warmupIterations: 2, iterations: 20 },
  );

  bench(
    'append_Concurrent10Streams',
    async () => {
      const { store, dir } = await freshStore();
      await Promise.all(
        Array.from({ length: 10 }, (_, i) =>
          store.append(`bench-concurrent-${i}`, {
            type: 'workflow.started',
            data: { featureId: `bench-concurrent-${i}`, workflowType: 'feature' },
          }),
        ),
      );
      rmrf(dir);
    },
    { warmupIterations: 2, iterations: 20 },
  );

  bench(
    'query_100EventsNoFilter',
    async () => {
      await seeded.query(QUERY_STREAM);
    },
    { warmupIterations: 3, iterations: 50 },
  );

  bench(
    'query_100EventsTypeFilter',
    async () => {
      await seeded.query(QUERY_STREAM, { type: 'task.assigned' });
    },
    { warmupIterations: 3, iterations: 50 },
  );

  bench(
    'initSequence_100Events',
    async () => {
      const store = new EventStore(QUERY_DIR);
      await store.initialize();
      await store.query(QUERY_STREAM);
    },
    { warmupIterations: 2, iterations: 20 },
  );
});
