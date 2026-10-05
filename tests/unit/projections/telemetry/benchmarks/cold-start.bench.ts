// Benchmarks for the speed of a cold-start view materialization. A timing assertion measures
// the host as well as the code, so these arms only report.
//
// Reference budgets: 200 ms for a full replay of up to 100 events, and 500 ms for 500 events.
// A snapshot-assisted cold start of 100 events has 100 ms. A warm cache hit has 5 ms, and a raw
// snapshot load has 50 ms.
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { bench, describe } from 'vitest';

import { generateWorkflowEvents } from '../../../../../src/projections/telemetry/benchmarks/cold-start.js';
import { ViewMaterializer } from '../../../../../src/projections/views/materializer.js';
import { SnapshotStore } from '../../../../../src/projections/views/snapshot-store.js';
import {
  WORKFLOW_STATUS_VIEW,
  workflowStatusProjection,
} from '../../../../../src/projections/views/workflow-status-view.js';

const SNAPSHOT_STREAM = 'bench-snapshot';
const SNAPSHOT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cold-start-bench-'));
const SNAPSHOT_EVENTS = generateWorkflowEvents(SNAPSHOT_STREAM, 100);
const seeding = new ViewMaterializer({ snapshotStore: new SnapshotStore(SNAPSHOT_DIR), snapshotInterval: 50 });
seeding.register(WORKFLOW_STATUS_VIEW, workflowStatusProjection);
seeding.materialize(SNAPSHOT_STREAM, WORKFLOW_STATUS_VIEW, SNAPSHOT_EVENTS.slice(0, 50));
await delay(100);

const WARM_STREAM = 'bench-warm';
const WARM_EVENTS = generateWorkflowEvents(WARM_STREAM, 100);
const warm = new ViewMaterializer();
warm.register(WORKFLOW_STATUS_VIEW, workflowStatusProjection);
warm.materialize(WARM_STREAM, WORKFLOW_STATUS_VIEW, WARM_EVENTS);

describe('Cold-start materialization budgets', () => {
  for (const eventCount of [10, 50, 100, 500]) {
    const events = generateWorkflowEvents('bench-replay', eventCount);
    bench(
      `materialize_ColdStartNoSnapshot_${eventCount}Events`,
      () => {
        const materializer = new ViewMaterializer();
        materializer.register(WORKFLOW_STATUS_VIEW, workflowStatusProjection);
        materializer.materialize('bench-replay', WORKFLOW_STATUS_VIEW, events);
      },
      { warmupIterations: 3, iterations: 30 },
    );
  }

  bench(
    'materialize_SnapshotAssisted100Events',
    async () => {
      const materializer = new ViewMaterializer({
        snapshotStore: new SnapshotStore(SNAPSHOT_DIR),
        snapshotInterval: Number.MAX_SAFE_INTEGER,
      });
      materializer.register(WORKFLOW_STATUS_VIEW, workflowStatusProjection);
      await materializer.loadFromSnapshot(SNAPSHOT_STREAM, WORKFLOW_STATUS_VIEW);
      materializer.materialize(SNAPSHOT_STREAM, WORKFLOW_STATUS_VIEW, SNAPSHOT_EVENTS);
    },
    { warmupIterations: 3, iterations: 30 },
  );

  bench(
    'materialize_WarmCacheHit',
    () => {
      warm.materialize(WARM_STREAM, WORKFLOW_STATUS_VIEW, WARM_EVENTS);
    },
    { warmupIterations: 3, iterations: 100 },
  );

  bench(
    'loadSnapshot_RawDiskLoad',
    async () => {
      await new SnapshotStore(SNAPSHOT_DIR).load(SNAPSHOT_STREAM, WORKFLOW_STATUS_VIEW);
    },
    { warmupIterations: 3, iterations: 50 },
  );
});
