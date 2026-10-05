/**
 * Regression test for the extractors that the rehydration and task-store reducers share.
 * The golden strings pin the output of both folds, which read event data through `src/projections/shared/event-data-extractors.ts`.
 */

import { describe, it, expect } from 'vitest';
import { rehydrationReducer } from '../../../src/projections/rehydration/reducer.js';
import { taskStoreReducer } from '../../../src/projections/taskstore/reducer.js';
import type { WorkflowEvent } from '../../../src/events/schemas.js';

function evt(
  sequence: number,
  type: string,
  data: Record<string, unknown>,
): WorkflowEvent {
  return {
    streamId: 'feat-x',
    sequence,
    timestamp: '2026-01-01T00:00:00.000Z',
    type,
    schemaVersion: '1.0',
    data,
  } as unknown as WorkflowEvent;
}

/**
 * A log that reaches each shared extractor in each reducer that calls it.
 * Only the task-store reducer reads the `duration` number and the `artifacts` string array of `task.completed`.
 * `state.patched` reaches the decoders that only the rehydration reducer has.
 */
const FIXTURE_LOG: readonly WorkflowEvent[] = [
  evt(1, 'workflow.started', { featureId: 'feat-x', workflowType: 'feature' }),
  evt(2, 'workflow.transition', { to: 'delegate' }),
  evt(3, 'state.patched', {
    patch: {
      tasks: [{ id: '001', status: 'pending' }],
      artifacts: { design: 'docs/x.md' },
    },
  }),
  evt(4, 'task.assigned', {
    taskId: '001',
    title: 'First',
    branch: 'feat/1',
    worktree: '/wt/1',
    assignee: 'agent-a',
  }),
  evt(5, 'task.claimed', {
    taskId: '001',
    agentId: 'agent-a',
    claimedAt: '2026-02-02T00:00:00.000Z',
  }),
  evt(6, 'task.progressed', { taskId: '001', tddPhase: 'green', detail: 'wip' }),
  evt(7, 'task.completed', {
    taskId: '001',
    artifacts: ['a.ts', 'b.ts'],
    duration: 1234,
  }),
  evt(8, 'task.assigned', { taskId: '002', title: 'Second' }),
  evt(9, 'task.failed', { taskId: '002', error: 'boom' }),
];

/** The golden JSON of the rehydration fold of {@link FIXTURE_LOG}. */
const EXPECTED_REHYDRATION_JSON =
  '{"v":4,"projectionSequence":7,"workflowState":{"featureId":"feat-x","phase":"delegate","workflowType":"feature"},"taskProgress":[{"id":"001","status":"complete"},{"id":"002","status":"failed"}],"decisions":[],"artifacts":{"design":"docs/x.md"},"blockers":[],"recentHandoffs":[],"phasePlaybook":null}';

const EXPECTED_TASKSTORE_JSON =
  '{"projectionSequence":6,"tasks":{"001":{"taskId":"001","status":"completed","title":"First","branch":"feat/1","worktree":"/wt/1","assignee":"agent-a","agentId":"agent-a","claimedAt":"2026-02-02T00:00:00.000Z","tddPhase":"green","detail":"wip","artifacts":["a.ts","b.ts"],"duration":1234},"002":{"taskId":"002","status":"failed","title":"Second","error":"boom"}}}';

function foldRehydration() {
  return FIXTURE_LOG.reduce(
    (state, event) => rehydrationReducer.apply(state, event),
    rehydrationReducer.initial,
  );
}

function foldTaskStore() {
  return FIXTURE_LOG.reduce(
    (state, event) => taskStoreReducer.apply(state, event),
    taskStoreReducer.initial,
  );
}

describe('shared-extractor fold identity (DR-10, INV-1)', () => {
  /** The reducers build the state with spreads, so the key order of the JSON is deterministic. */
  it('Reducers_SharedExtractors_FoldFixtureLogIdentically', () => {
    expect(JSON.stringify(foldRehydration())).toBe(EXPECTED_REHYDRATION_JSON);
    expect(JSON.stringify(foldTaskStore())).toBe(EXPECTED_TASKSTORE_JSON);
  });

  /** Two folds of one log give the same output, so the golden comparison does not depend on one run. */
  it('Reducers_SharedExtractors_FoldIsDeterministicAcrossRuns', () => {
    expect(JSON.stringify(foldRehydration())).toBe(
      JSON.stringify(foldRehydration()),
    );
    expect(JSON.stringify(foldTaskStore())).toBe(
      JSON.stringify(foldTaskStore()),
    );
  });
});
