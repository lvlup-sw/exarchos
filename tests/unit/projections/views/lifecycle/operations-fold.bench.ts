// Cold `foldInFlightOperations` speed over 10k real store-backed events,
// measured in the benchmark gate rather than asserted in a correctness test
// (#2029). The SLA is p95 < 250 ms, the same as the workflow fold beside it.
//
// This arm replaces the RUN_BENCHMARKS-gated case that timed the fold in
// `operations-fold.test.ts`. The corpus is unchanged: 10k instances across
// every liveness surface, two thirds of them terminated.
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { bench, describe } from 'vitest';

import { LIVENESS_DESCRIPTORS } from '../../../../../src/events/liveness-registry.js';
import type { EventType } from '../../../../../src/events/schemas.js';
import { EventStore } from '../../../../../src/events/store.js';
import { foldInFlightOperations } from '../../../../../src/projections/views/lifecycle/operations-fold.js';

const STREAM = 'bench-ops-fold-cold-10k';
const INSTANCES = 10_000;

const batch: Array<{ type: EventType; data: Record<string, unknown>; timestamp: string }> = [];
for (let i = 0; i < INSTANCES; i++) {
  const descriptor = LIVENESS_DESCRIPTORS[i % LIVENESS_DESCRIPTORS.length];
  if (descriptor === undefined) continue;
  const key = `k-${i}`;
  batch.push({
    type: descriptor.startType,
    data: { instanceId: key },
    timestamp: new Date(2026, 0, 1, 0, 0, 0, i).toISOString(),
  });
  const terminal = descriptor.terminalTypes[0];
  if (i % 3 !== 0 && terminal !== undefined) {
    batch.push({ type: terminal, data: { instanceId: key }, timestamp: new Date(2026, 0, 1, 0, 0, 1, i).toISOString() });
  }
}
const store = new EventStore(fs.mkdtempSync(path.join(os.tmpdir(), 'operations-fold-bench-')));
await store.batchAppend(STREAM, batch);
const EVENTS = await store.query(STREAM);

describe('operations-fold cold read', () => {
  bench(
    'operations-fold-cold-10k-events',
    () => {
      foldInFlightOperations(EVENTS);
    },
    { warmupIterations: 2, iterations: 15 },
  );
});
