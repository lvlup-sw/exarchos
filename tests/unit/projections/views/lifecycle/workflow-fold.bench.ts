// Cold-read benchmark for the workflow-fold view. `vitest bench` collects this
// file, and `vitest run` does not. `tools/audit/benchmark-baseline.json` holds
// the regression threshold of each bench.
//
// The corpus is 200 workflows with 50 events each, in one in-memory SQLite
// database. The workflows cycle through three workflow types and six phases.
// The summary query reads the phase with `json_extract`, and the start time
// with a `MIN(timestamp)` subquery for each stream.

import { bench, describe } from 'vitest';
import type { WorkflowEvent } from '../../../../../src/events/schemas.js';
import type { WorkflowState } from '../../../../../src/storage/backend.js';
import { SqliteBackend } from '../../../../../src/storage/sqlite-backend.js';
import { foldWorkflowSummaries } from '../../../../../src/projections/views/lifecycle/workflow-fold.js';

const WORKFLOW_COUNT = 200;
const EVENTS_PER_WORKFLOW = 50;
const TYPES = ['feature', 'debug', 'refactor'] as const;
const PHASES = ['plan', 'delegate', 'review', 'blocked', 'completed', 'cancelled'] as const;
const EPOCH = Date.parse('2026-01-01T00:00:00.000Z');

function buildTenThousandEventStore(): SqliteBackend {
  const backend = new SqliteBackend(':memory:');
  backend.initialize();

  for (let w = 0; w < WORKFLOW_COUNT; w++) {
    const featureId = `wf-${String(w).padStart(4, '0')}`;
    const workflowType = TYPES[w % TYPES.length];
    const phase = PHASES[w % PHASES.length];

    backend.setState(featureId, {
      featureId,
      workflowType,
      phase,
    } as unknown as WorkflowState);
    backend.registerStream(featureId, workflowType);

    for (let e = 0; e < EVENTS_PER_WORKFLOW; e++) {
      backend.appendEvent(featureId, {
        streamId: featureId,
        sequence: e + 1,
        timestamp: new Date(EPOCH + w * 1000 + e).toISOString(),
        type: 'workflow.transition',
        schemaVersion: '1.0',
      } as WorkflowEvent);
    }
  }

  return backend;
}

describe('workflow-fold cold read (DR-3)', () => {
  const backend = buildTenThousandEventStore();
  const nowMs = Date.parse('2026-02-01T00:00:00.000Z');

  bench(
    'workflow-fold-cold-10k-events',
    () => {
      foldWorkflowSummaries(backend, { includeTerminal: true, nowMs });
    },
    { warmupIterations: 5, iterations: 100 },
  );

  bench(
    'workflow-fold-cold-10k-events-type-filtered',
    () => {
      foldWorkflowSummaries(backend, { workflowType: 'feature', nowMs });
    },
    { warmupIterations: 5, iterations: 100 },
  );
});
