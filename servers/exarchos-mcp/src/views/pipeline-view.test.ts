/**
 * Pipeline view projection — #1359 / PR4 T13 tests.
 *
 * Bug A of the #1359 projection-drift RCA: pre-#1359 the pipeline view only
 * folded `task.assigned` / `task.completed` / `task.failed` and ignored
 * `state.patched`. Callers that mutated tasks via `workflow.update({tasks})`
 * without paired `task.*` events were invisible to `taskCount` /
 * `completedCount` / `failedCount`. One observed session: 53 vs 67
 * taskCount, 20 vs 56 completedCount.
 *
 * Fix: a `tasksById` map keyed by task id, monotonically promoted by both
 * `state.patched` plan-task folds and dedicated `task.*` events using the
 * shared `STATUS_RANK` ladder. Counters are derived from the map so all
 * paths share a single source of truth.
 */
import { describe, it, expect } from 'vitest';
import { pipelineProjection, type PipelineViewState } from './pipeline-view.js';
import type { WorkflowEvent } from '../event-store/schemas.js';

/**
 * Helper — build a minimal WorkflowEvent. Only `type` and `data` are
 * load-bearing for the projection; the rest satisfy WorkflowEventBase.
 */
function makeEvent<T extends Record<string, unknown>>(
  type: string,
  data: T,
  sequence: number,
): WorkflowEvent {
  return {
    streamId: 'wf-pipe',
    sequence,
    timestamp: '2026-05-15T00:00:00.000Z',
    type,
    schemaVersion: '1.0',
    data,
  } as WorkflowEvent;
}

describe('pipelineProjection — state.patched fold (#1359 / PR4 T13)', () => {
  it('PipelineProjection_StatePatchedCompleteTask_IncrementsCompletedCount', () => {
    // GIVEN: a workflow.started event setting context, followed by a
    // state.patched whose patch.tasks declares two tasks — one complete,
    // one pending — with no paired task.* events. Pre-fix this scenario
    // left taskCount === 0; post-fix the view folds state.patched.tasks
    // through the monotonic STATUS_RANK helper and surfaces the canonical
    // counters.
    const initial = pipelineProjection.init();
    const started = makeEvent(
      'workflow.started',
      { featureId: 'feat-1359', workflowType: 'feature' },
      1,
    );
    const patched = makeEvent(
      'state.patched',
      {
        featureId: 'feat-1359',
        fields: ['tasks'],
        patch: {
          tasks: [
            { id: 'T001', title: 'first', status: 'complete' },
            { id: 'T002', title: 'second', status: 'pending' },
          ],
        },
      },
      2,
    );

    let view: PipelineViewState = pipelineProjection.apply(initial, started);
    view = pipelineProjection.apply(view, patched);

    // THEN: the counters reflect canonical state.
    expect(view.taskCount).toBe(2);
    expect(view.completedCount).toBe(1);
    expect(view.failedCount).toBe(0);
  });

  it('PipelineProjection_StatePatchedThenTaskCompleted_DoesNotDoubleCount', () => {
    // Monotonic-promotion invariant: a state.patched marking T001 as
    // 'complete' followed by a redundant task.completed event for T001
    // must produce completedCount === 1, NOT 2.
    const initial = pipelineProjection.init();
    const started = makeEvent(
      'workflow.started',
      { featureId: 'feat-mono', workflowType: 'feature' },
      1,
    );
    const patched = makeEvent(
      'state.patched',
      {
        featureId: 'feat-mono',
        fields: ['tasks'],
        patch: { tasks: [{ id: 'T001', status: 'complete' }] },
      },
      2,
    );
    const completed = makeEvent('task.completed', { taskId: 'T001' }, 3);

    let view: PipelineViewState = pipelineProjection.apply(initial, started);
    view = pipelineProjection.apply(view, patched);
    view = pipelineProjection.apply(view, completed);

    expect(view.taskCount).toBe(1);
    expect(view.completedCount).toBe(1);
  });

  it('PipelineProjection_TaskFailedThenStatePatchedPending_DoesNotRegress', () => {
    // task.failed promotes T001 to 'failed' (rank 2). A later
    // state.patched re-asserting the plan with status='pending' must NOT
    // regress the entry — plan-state stamps the full task list, events
    // carry execution truth.
    const initial = pipelineProjection.init();
    const started = makeEvent(
      'workflow.started',
      { featureId: 'feat-regress', workflowType: 'feature' },
      1,
    );
    const failed = makeEvent('task.failed', { taskId: 'T001' }, 2);
    const patched = makeEvent(
      'state.patched',
      {
        featureId: 'feat-regress',
        fields: ['tasks'],
        patch: { tasks: [{ id: 'T001', status: 'pending' }] },
      },
      3,
    );

    let view: PipelineViewState = pipelineProjection.apply(initial, started);
    view = pipelineProjection.apply(view, failed);
    view = pipelineProjection.apply(view, patched);

    expect(view.taskCount).toBe(1);
    expect(view.failedCount).toBe(1);
  });
});

// ─── DR-5: repoRoot carried by the projection fold ───────────────────────────

describe('pipelineProjection — repoRoot fold (DR-5)', () => {
  it('PipelineProjection_StartedWithRepoRoot_StateCarriesIt', () => {
    const initial = pipelineProjection.init();
    const started = makeEvent(
      'workflow.started',
      { featureId: 'feat-repo', workflowType: 'feature', repoRoot: '/home/dev/exarchos' },
      1,
    );

    const view = pipelineProjection.apply(initial, started);

    // Pure fold: the identity is copied from the event data verbatim.
    expect(view.repoRoot).toBe('/home/dev/exarchos');
    expect(view.featureId).toBe('feat-repo');
  });

  it('PipelineProjection_StartedWithoutRepoRoot_StateUndefined', () => {
    const initial = pipelineProjection.init();
    const started = makeEvent(
      'workflow.started',
      { featureId: 'feat-legacy', workflowType: 'feature' },
      1,
    );

    const view = pipelineProjection.apply(initial, started);

    // Legacy stream (no repoRoot on the event) stays unscoped — never looked up.
    expect(view.repoRoot).toBeUndefined();
    expect(view.featureId).toBe('feat-legacy');
  });
});
