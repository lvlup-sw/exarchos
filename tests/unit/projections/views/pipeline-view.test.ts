/**
 * Pipeline view projection tests for the `state.patched` task fold and the `repoRoot` fold.
 *
 * The view keeps a `tasksById` map. `state.patched` plan tasks and `task.*` events both promote a
 * status in it, and never move it down. The three counters derive from the map.
 */
import { describe, it, expect } from 'vitest';
import { pipelineProjection, type PipelineViewState } from '../../../../src/projections/views/pipeline-view.js';
import type { WorkflowEvent } from '../../../../src/events/schemas.js';

/** Builds a minimal `WorkflowEvent`. The projection reads only `type` and `data`. */
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
  /** Plan tasks from `state.patched` set the counters when the stream holds no `task.*` event. */
  it('PipelineProjection_StatePatchedCompleteTask_IncrementsCompletedCount', () => {
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

    expect(view.taskCount).toBe(2);
    expect(view.completedCount).toBe(1);
    expect(view.failedCount).toBe(0);
  });

  /** A `state.patched` and a `task.completed` that complete the same task count it one time. */
  it('PipelineProjection_StatePatchedThenTaskCompleted_DoesNotDoubleCount', () => {
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

  /**
   * A later `state.patched` with status `pending` must not move a failed task down.
   * The plan sends the full task list, and events carry the execution result.
   */
  it('PipelineProjection_TaskFailedThenStatePatchedPending_DoesNotRegress', () => {
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

describe('pipelineProjection — repoRoot fold (DR-5)', () => {
  /** The fold copies `repoRoot` from the event data with no lookup. */
  it('PipelineProjection_StartedWithRepoRoot_StateCarriesIt', () => {
    const initial = pipelineProjection.init();
    const started = makeEvent(
      'workflow.started',
      { featureId: 'feat-repo', workflowType: 'feature', repoRoot: '/home/dev/exarchos' },
      1,
    );

    const view = pipelineProjection.apply(initial, started);

    expect(view.repoRoot).toBe('/home/dev/exarchos');
    expect(view.featureId).toBe('feat-repo');
  });

  /** When the event has no `repoRoot`, the fold does no lookup and the state stays unscoped. */
  it('PipelineProjection_StartedWithoutRepoRoot_StateUndefined', () => {
    const initial = pipelineProjection.init();
    const started = makeEvent(
      'workflow.started',
      { featureId: 'feat-legacy', workflowType: 'feature' },
      1,
    );

    const view = pipelineProjection.apply(initial, started);

    expect(view.repoRoot).toBeUndefined();
    expect(view.featureId).toBe('feat-legacy');
  });
});
