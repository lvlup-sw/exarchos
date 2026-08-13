import { bench, describe } from 'vitest';
import type { WorkflowEvent } from '../../../events/schemas.js';
import type { WorkflowState } from '../../../storage/backend.js';
import { SqliteBackend } from '../../../storage/sqlite-backend.js';
import { foldWorkflowSummaries } from './workflow-fold.js';

/**
 * Cold-read benchmark for the workflow-fold view (DR-3 SLA: p95 < 250 ms over
 * a 10k-event store). Lives OUTSIDE the `src/bench` directory so it is excluded
 * from the vitest hot loop (test.include only globs the `src/bench` tree), and
 * runs only under `vitest bench` (benchmark.include globs all bench files under
 * src) at the boundary/offline cadence.
 *
 * Corpus: 200 workflows × 50 events = 10,000 events, spread across workflow
 * types and lifecycle phases, in a single in-memory SQLite database. Exercises
 * the indexed `workflow_type` join, `json_extract` phase read, and the
 * `MIN(events.timestamp)` per-stream envelope subquery under realistic density.
 */

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
