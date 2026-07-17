import { describe, it, expect } from 'vitest';
import { rehydrationReducer } from './rehydration/reducer.js';
import { taskStoreReducer } from './taskstore/reducer.js';
import type { WorkflowEvent } from '../event-store/schemas.js';

// ─── DR-10 / INV-1: shared-extractor fold-identity regression ────────────────
//
// Task 019 collapsed the byte-identical `extractTaskId` / `extractString`
// (and generic `extractNumber` / `extractStringArray`) copies out of the
// rehydration and task-store reducers into
// `projections/shared/event-data-extractors.ts`. That extraction MUST be
// behavior-preserving: a fixture event log has to fold BYTE-IDENTICAL through
// both reducers after the extraction as it did before.
//
// The two golden strings below were captured from the reducers BEFORE the
// extraction (the pre-refactor behavior). The reducers now share the extracted
// primitives, so these assertions pin that the shared extractors reproduce the
// prior fold exactly. The `check_test_adequacy` kill-probe (revert the source
// hunk, keep this test) — and the manual kill-probe in the task's verify step
// (mutate a shared extractor) — both drive at least one of these to red.

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

// A fixture log that exercises every shared extractor across BOTH reducers:
//   - extractTaskId      — every task.* event
//   - extractString      — title/branch/worktree/assignee/agentId/claimedAt/
//                          detail/error (task-store) + featureId/workflowType/
//                          to (rehydration)
//   - extractNumber      — task.completed `duration` (task-store)
//   - extractStringArray — task.completed `artifacts` (task-store)
// plus rehydration-local decoders (state.patched artifacts + plan tasks).
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

// Pre-extraction golden — captured from the reducers before Task 019.
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
  it('Reducers_SharedExtractors_FoldFixtureLogIdentically', () => {
    // Byte-identical: JSON serialization (deterministic key order from the
    // reducers' spread construction) must equal the pre-extraction golden.
    expect(JSON.stringify(foldRehydration())).toBe(EXPECTED_REHYDRATION_JSON);
    expect(JSON.stringify(foldTaskStore())).toBe(EXPECTED_TASKSTORE_JSON);
  });

  it('Reducers_SharedExtractors_FoldIsDeterministicAcrossRuns', () => {
    // Purity guard: folding the same log twice yields identical output, so the
    // byte-identity assertion above is not an artifact of a single run.
    expect(JSON.stringify(foldRehydration())).toBe(
      JSON.stringify(foldRehydration()),
    );
    expect(JSON.stringify(foldTaskStore())).toBe(
      JSON.stringify(foldTaskStore()),
    );
  });
});
