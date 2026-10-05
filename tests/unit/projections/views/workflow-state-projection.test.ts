import { describe, it, expect } from 'vitest';
import type { WorkflowEvent } from '../../../../src/events/schemas.js';
import {
  workflowStateProjection,
  WORKFLOW_STATE_VIEW,
} from '../../../../src/projections/views/workflow-state-projection.js';

let seq = 0;

function makeEvent(
  type: WorkflowEvent['type'],
  data?: Record<string, unknown>,
  overrides?: Partial<WorkflowEvent>,
): WorkflowEvent {
  seq += 1;
  return {
    streamId: 'test-stream',
    sequence: seq,
    timestamp: new Date().toISOString(),
    type,
    schemaVersion: '1.0',
    data: data ?? {},
    ...overrides,
  } as WorkflowEvent;
}

describe('WORKFLOW_STATE_VIEW', () => {
  it('should export the view name constant', () => {
    expect(WORKFLOW_STATE_VIEW).toBe('workflow-state');
  });
});

describe('WorkflowStateProjection init', () => {
  describe('Init_NoEvents_ReturnsMinimalSkeleton', () => {
    it('should return a valid skeleton with empty arrays and objects', () => {
      const state = workflowStateProjection.init();

      expect(state.version).toBe('1.1');
      expect(state.featureId).toBe('');
      expect(state.workflowType).toBe('feature');
      expect(state.phase).toBe('plan');
      expect(state.createdAt).toBe('');
      expect(state.updatedAt).toBe('');
      expect(state.artifacts).toEqual({ design: null, plan: null, pr: null });
      expect(state.tasks).toEqual([]);
      expect(state.worktrees).toEqual({});
      expect(state.reviews).toEqual({});
      expect(state.integration).toBeNull();
      expect(state.synthesis).toEqual({
        integrationBranch: null,
        mergeOrder: [],
        mergedBranches: [],
        prUrl: null,
        prFeedback: [],
      });
      expect(state._events).toEqual([]);
      expect(state._version).toBe(1);
      expect(state._history).toEqual({});
      expect(state._checkpoint).toEqual({
        timestamp: '',
        phase: '',
        summary: '',
        operationsSince: 0,
        fixCycleCount: 0,
        lastActivityTimestamp: '',
        staleAfterMinutes: 120,
      });
    });
  });
});

describe('WorkflowStateProjection workflow lifecycle', () => {
  describe('Apply_WorkflowStarted_SetsFeatureIdAndPhase', () => {
    it('should set featureId, workflowType, phase, createdAt, updatedAt from workflow.started', () => {
      const state = workflowStateProjection.init();
      const ts = '2026-02-19T10:00:00.000Z';

      const event = makeEvent(
        'workflow.started',
        { featureId: 'my-feature', workflowType: 'feature' },
        { timestamp: ts },
      );
      const next = workflowStateProjection.apply(state, event);

      expect(next.featureId).toBe('my-feature');
      expect(next.workflowType).toBe('feature');
      expect(next.phase).toBe('plan');
      expect(next.createdAt).toBe(ts);
      expect(next.updatedAt).toBe(ts);
    });

    /**
     * A second fold of `workflow.started` must keep the stamped `createdAt`, so a reconcile replay
     * is idempotent. `updatedAt` still moves.
     */
    it('should preserve an existing createdAt when workflow.started is re-folded (reconcile idempotency)', () => {
      const created = '2026-02-19T10:00:00.000Z';
      const later = '2026-03-01T12:00:00.000Z';
      const start = workflowStateProjection.apply(
        workflowStateProjection.init(),
        makeEvent('workflow.started', { featureId: 'f', workflowType: 'feature' }, { timestamp: created }),
      );
      expect(start.createdAt).toBe(created);

      const refolded = workflowStateProjection.apply(
        start,
        makeEvent('workflow.started', { featureId: 'f', workflowType: 'feature' }, { timestamp: later }),
      );

      expect(refolded.createdAt).toBe(created);
      expect(refolded.updatedAt).toBe(later);
    });

    it('should set phase to triage for debug workflows', () => {
      const state = workflowStateProjection.init();
      const event = makeEvent('workflow.started', {
        featureId: 'bug-hunt',
        workflowType: 'debug',
      });
      const next = workflowStateProjection.apply(state, event);

      expect(next.workflowType).toBe('debug');
      expect(next.phase).toBe('triage');
    });

    it('should set phase to explore for refactor workflows', () => {
      const state = workflowStateProjection.init();
      const event = makeEvent('workflow.started', {
        featureId: 'cleanup',
        workflowType: 'refactor',
      });
      const next = workflowStateProjection.apply(state, event);

      expect(next.workflowType).toBe('refactor');
      expect(next.phase).toBe('explore');
    });
  });

  describe('Apply_WorkflowTransition_UpdatesPhase', () => {
    it('should update phase to event.data.to and updatedAt', () => {
      const state = workflowStateProjection.init();
      const ts = '2026-02-19T11:00:00.000Z';

      const event = makeEvent(
        'workflow.transition',
        { from: 'ideate', to: 'plan', trigger: 'next', featureId: 'f1' },
        { timestamp: ts },
      );
      const next = workflowStateProjection.apply(state, event);

      expect(next.phase).toBe('plan');
      expect(next.updatedAt).toBe(ts);
    });

    it('should merge historyUpdates into _history when present', () => {
      const state = workflowStateProjection.init();

      const event = makeEvent('workflow.transition', {
        from: 'ideate',
        to: 'plan',
        trigger: 'next',
        featureId: 'f1',
        historyUpdates: { ideate: 'completed design doc' },
      });
      const next = workflowStateProjection.apply(state, event);

      expect(next._history).toEqual({ ideate: 'completed design doc' });
    });
  });

  describe('Apply_WorkflowCheckpoint_UpdatesCheckpointFields', () => {
    it('should update _checkpoint phase, timestamp, lastActivityTimestamp, and operationsSince', () => {
      const state = workflowStateProjection.init();
      const ts = '2026-02-19T12:00:00.000Z';

      const event = makeEvent(
        'workflow.checkpoint',
        { phase: 'delegate', counter: 5, featureId: 'f1' },
        { timestamp: ts },
      );
      const next = workflowStateProjection.apply(state, event);

      expect(next._checkpoint.phase).toBe('delegate');
      expect(next._checkpoint.timestamp).toBe(ts);
      expect(next._checkpoint.lastActivityTimestamp).toBe(ts);
      expect(next._checkpoint.operationsSince).toBe(5);
    });

    it('should leave operationsSince unchanged when counter is not provided', () => {
      const state = workflowStateProjection.init();

      const event = makeEvent('workflow.checkpoint', {
        phase: 'review',
        featureId: 'f1',
      });
      const next = workflowStateProjection.apply(state, event);

      expect(next._checkpoint.phase).toBe('review');
      expect(next._checkpoint.operationsSince).toBe(0);
    });
  });
});

describe('WorkflowStateProjection task events', () => {
  describe('Apply_TaskAssigned_PushesToTasksArray', () => {
    it('should add a new task with pending status', () => {
      const state = workflowStateProjection.init();
      const event = makeEvent('task.assigned', {
        taskId: 'task-1',
        title: 'Implement feature',
        branch: 'feat/task-1',
        worktree: '/tmp/wt-1',
      });
      const next = workflowStateProjection.apply(state, event);

      expect(next.tasks).toHaveLength(1);
      expect(next.tasks[0]).toEqual({
        id: 'task-1',
        title: 'Implement feature',
        status: 'pending',
        branch: 'feat/task-1',
        worktreePath: '/tmp/wt-1',
      });
    });
  });

  describe('Apply_TaskAssigned_DuplicateId_UpdatesExisting', () => {
    it('should update the existing task instead of duplicating', () => {
      let state = workflowStateProjection.init();

      state = workflowStateProjection.apply(
        state,
        makeEvent('task.assigned', {
          taskId: 'task-1',
          title: 'Original title',
          branch: 'feat/old',
        }),
      );

      state = workflowStateProjection.apply(
        state,
        makeEvent('task.assigned', {
          taskId: 'task-1',
          title: 'Updated title',
          branch: 'feat/new',
          worktree: '/tmp/wt-new',
        }),
      );

      expect(state.tasks).toHaveLength(1);
      expect(state.tasks[0].title).toBe('Updated title');
      expect(state.tasks[0].branch).toBe('feat/new');
      expect(state.tasks[0].worktreePath).toBe('/tmp/wt-new');
    });
  });

  describe('Apply_TaskCompleted_UpdatesStatusAndCompletedAt', () => {
    it('should set status to complete and record completedAt', () => {
      let state = workflowStateProjection.init();
      state = workflowStateProjection.apply(
        state,
        makeEvent('task.assigned', { taskId: 'task-1', title: 'T1' }),
      );

      const ts = '2026-02-19T14:00:00.000Z';
      state = workflowStateProjection.apply(
        state,
        makeEvent(
          'task.completed',
          { taskId: 'task-1' },
          { timestamp: ts },
        ),
      );

      expect(state.tasks[0].status).toBe('complete');
      expect(state.tasks[0].completedAt).toBe(ts);
    });
  });

  describe('Apply_TaskCompleted_UnknownTaskId_NoOp', () => {
    it('should return state unchanged when taskId is not found', () => {
      const state = workflowStateProjection.init();
      const event = makeEvent('task.completed', { taskId: 'nonexistent' });
      const next = workflowStateProjection.apply(state, event);

      expect(next).toEqual(state);
    });
  });

  describe('Apply_TaskFailed_UpdatesStatus', () => {
    it('should set status to failed', () => {
      let state = workflowStateProjection.init();
      state = workflowStateProjection.apply(
        state,
        makeEvent('task.assigned', { taskId: 'task-1', title: 'T1' }),
      );

      state = workflowStateProjection.apply(
        state,
        makeEvent('task.failed', { taskId: 'task-1', error: 'build failed' }),
      );

      expect(state.tasks[0].status).toBe('failed');
    });
  });
});

describe('WorkflowStateProjection state.patched', () => {
  describe('Apply_StatePatched_DeepMergesIntoState', () => {
    it('should patch top-level fields into state', () => {
      const state = workflowStateProjection.init();
      const event = makeEvent('state.patched', {
        patch: { integration: { passed: true } },
      });
      const next = workflowStateProjection.apply(state, event);

      expect(next.integration).toEqual({ passed: true });
    });
  });

  describe('Apply_StatePatched_NestedObjects_MergesRecursively', () => {
    it('should recursively merge nested objects', () => {
      let state = workflowStateProjection.init();

      state = workflowStateProjection.apply(
        state,
        makeEvent('state.patched', {
          patch: { synthesis: { integrationBranch: 'main', mergeOrder: ['a', 'b'] } },
        }),
      );

      state = workflowStateProjection.apply(
        state,
        makeEvent('state.patched', {
          patch: { synthesis: { prUrl: 'https://github.com/pr/1' } },
        }),
      );

      expect(state.synthesis.integrationBranch).toBe('main');
      expect(state.synthesis.mergeOrder).toEqual(['a', 'b']);
      expect(state.synthesis.prUrl).toBe('https://github.com/pr/1');
    });
  });

  describe('Apply_StatePatched_ArrayFields_ReplacesArray', () => {
    it('should replace arrays instead of merging them', () => {
      let state = workflowStateProjection.init();

      state = workflowStateProjection.apply(
        state,
        makeEvent('state.patched', {
          patch: { synthesis: { mergeOrder: ['a', 'b'] } },
        }),
      );
      state = workflowStateProjection.apply(
        state,
        makeEvent('state.patched', {
          patch: { synthesis: { mergeOrder: ['x', 'y', 'z'] } },
        }),
      );

      expect(state.synthesis.mergeOrder).toEqual(['x', 'y', 'z']);
    });
  });

  describe('Apply_StatePatched_NullPatch_NoOp', () => {
    it('should return state unchanged when patch is null', () => {
      const state = workflowStateProjection.init();
      const event = makeEvent('state.patched', { patch: null });
      const next = workflowStateProjection.apply(state, event);

      expect(next).toEqual(state);
    });

    it('should return state unchanged when patch is undefined', () => {
      const state = workflowStateProjection.init();
      const event = makeEvent('state.patched', {});
      const next = workflowStateProjection.apply(state, event);

      expect(next).toEqual(state);
    });

    it('should return state unchanged when data is missing', () => {
      const state = workflowStateProjection.init();
      const event = makeEvent('state.patched', undefined);
      const next = workflowStateProjection.apply(state, event);

      expect(next).toEqual(state);
    });

    /**
     * An empty patch must return the same reference, not only an equal value.
     * `reconcileFromEvents` counts a new reference as a change.
     */
    it('should return the SAME reference for an empty patch (no-op identity)', () => {
      const state = workflowStateProjection.init();
      const event = makeEvent('state.patched', { patch: {} });
      const next = workflowStateProjection.apply(state, event);

      expect(next).toBe(state);
    });
  });

  describe('Apply_StatePatched_ArrayIndexPath_MergesInPlace', () => {
    /**
     * `tasks[0].nativeTaskId` is an array-index patch. The fold must change that one element as
     * the file write does, and keep the other task.
     */
    it('should apply an array-index dot-path patch in place without clobbering sibling tasks', () => {
      let state = workflowStateProjection.init();

      state = workflowStateProjection.apply(
        state,
        makeEvent('task.assigned', { taskId: 'task-1', title: 'First', branch: 'feat/1', worktree: '/tmp/wt-1' }),
      );
      state = workflowStateProjection.apply(
        state,
        makeEvent('task.assigned', { taskId: 'task-2', title: 'Second' }),
      );

      state = workflowStateProjection.apply(
        state,
        makeEvent('state.patched', { patch: { 'tasks[0].nativeTaskId': 'nt-1' } }),
      );

      expect(state.tasks).toHaveLength(2);
      expect(state.tasks[0]).toMatchObject({
        id: 'task-1',
        title: 'First',
        status: 'pending',
        nativeTaskId: 'nt-1',
      });
      expect(state.tasks[1]).toMatchObject({ id: 'task-2', title: 'Second', status: 'pending' });
    });

    it('should update an existing field at an array index in place', () => {
      let state = workflowStateProjection.init();
      state = workflowStateProjection.apply(
        state,
        makeEvent('task.assigned', { taskId: 'task-1', title: 'First' }),
      );
      state = workflowStateProjection.apply(
        state,
        makeEvent('task.assigned', { taskId: 'task-2', title: 'Second' }),
      );

      state = workflowStateProjection.apply(
        state,
        makeEvent('state.patched', { patch: { 'tasks[1].status': 'complete' } }),
      );

      expect(state.tasks).toHaveLength(2);
      expect(state.tasks[0]).toMatchObject({ id: 'task-1', status: 'pending' });
      expect(state.tasks[1]).toMatchObject({ id: 'task-2', status: 'complete' });
    });
  });
});

describe('WorkflowStateProjection stack/review events', () => {
  describe('Apply_StackPositionFilled_UpdatesTaskBranch', () => {
    it('should update the matching task branch', () => {
      let state = workflowStateProjection.init();
      state = workflowStateProjection.apply(
        state,
        makeEvent('task.assigned', {
          taskId: 'task-1',
          title: 'T1',
          branch: 'old-branch',
        }),
      );

      state = workflowStateProjection.apply(
        state,
        makeEvent('stack.position-filled', {
          taskId: 'task-1',
          branch: 'new-branch',
          position: 1,
        }),
      );

      expect(state.tasks[0].branch).toBe('new-branch');
    });
  });

  describe('Apply_ReviewRouted_UpdatesReviewsRecord', () => {
    it('should add an entry to the reviews object keyed by PR number', () => {
      const state = workflowStateProjection.init();
      const event = makeEvent('review.routed', {
        pr: 42,
        riskScore: 0.75,
        factors: ['large-diff'],
        destination: 'coderabbit',
        velocityTier: 'normal',
        semanticAugmented: true,
      });
      const next = workflowStateProjection.apply(state, event);

      expect(next.reviews['42']).toBeDefined();
      expect((next.reviews['42'] as Record<string, unknown>).pr).toBe(42);
      expect((next.reviews['42'] as Record<string, unknown>).riskScore).toBe(0.75);
      expect((next.reviews['42'] as Record<string, unknown>).destination).toBe('coderabbit');
    });
  });
});

describe('WorkflowStateProjection team events', () => {
  describe('Apply_TeamSpawned_AppendsToViewEvents', () => {
    it('should append team.spawned to view._events', () => {
      const state = workflowStateProjection.init();
      const ts = '2026-02-19T15:00:00.000Z';

      const event = makeEvent(
        'team.spawned',
        { teamSize: 3, teammateNames: ['a', 'b', 'c'], taskCount: 3, dispatchMode: 'parallel' },
        { timestamp: ts },
      );
      const next = workflowStateProjection.apply(state, event);

      expect(next._events).toBeDefined();
      expect(Array.isArray(next._events)).toBe(true);
      expect(next._events).toHaveLength(1);
      expect(next._events[0]).toMatchObject({ type: 'team.spawned' });
    });
  });

  describe('Apply_TeamDisbanded_AppendsToViewEvents', () => {
    it('should append both team.spawned and team.disbanded to view._events', () => {
      let state = workflowStateProjection.init();
      const ts1 = '2026-02-19T15:00:00.000Z';
      const ts2 = '2026-02-19T16:00:00.000Z';

      state = workflowStateProjection.apply(
        state,
        makeEvent(
          'team.spawned',
          { teamSize: 2 },
          { timestamp: ts1 },
        ),
      );

      state = workflowStateProjection.apply(
        state,
        makeEvent(
          'team.disbanded',
          { totalDurationMs: 5000 },
          { timestamp: ts2 },
        ),
      );

      expect(state._events).toHaveLength(2);
      expect(state._events[0]).toMatchObject({ type: 'team.spawned' });
      expect(state._events[1]).toMatchObject({ type: 'team.disbanded' });
    });
  });

  describe('Apply_TeamSpawned_PreservesEventData', () => {
    it('should preserve event data including teamSize in _events entry', () => {
      const state = workflowStateProjection.init();
      const ts = '2026-02-19T15:00:00.000Z';

      const event = makeEvent(
        'team.spawned',
        { teamSize: 3 },
        { timestamp: ts },
      );
      const next = workflowStateProjection.apply(state, event);

      expect(next._events).toHaveLength(1);
      const entry = next._events[0];
      expect(entry.type).toBe('team.spawned');
      expect(entry.timestamp).toBe(ts);
      expect(entry.data).toBeDefined();
      expect((entry.data as Record<string, unknown>).teamSize).toBe(3);
    });
  });
});

describe('WorkflowStateProjection oneshot/pruning events', () => {
  describe('workflowStateProjection_synthesizeRequested_appendsToEvents', () => {
    it('should append synthesize.requested to view._events', () => {
      const state = workflowStateProjection.init();
      const ts = '2026-04-11T10:00:00.000Z';

      const event = makeEvent(
        'synthesize.requested',
        { featureId: 'oneshot-feature', reason: 'all-tasks-complete' },
        { timestamp: ts },
      );
      const next = workflowStateProjection.apply(state, event);

      expect(next._events).toBeDefined();
      expect(Array.isArray(next._events)).toBe(true);
      expect(next._events).toHaveLength(1);
      expect(next._events[0]).toMatchObject({
        type: 'synthesize.requested',
        timestamp: ts,
      });
      expect((next._events[0].data as Record<string, unknown>).featureId).toBe(
        'oneshot-feature',
      );
    });
  });

  describe('workflowStateProjection_synthesizeRequested_doesNotMutateOtherFields', () => {
    it('should leave phase, featureId, tasks, and other fields unchanged', () => {
      let state = workflowStateProjection.init();
      state = workflowStateProjection.apply(
        state,
        makeEvent(
          'workflow.started',
          { featureId: 'f-synth', workflowType: 'feature' },
          { timestamp: '2026-04-11T09:00:00.000Z' },
        ),
      );
      state = workflowStateProjection.apply(
        state,
        makeEvent('task.assigned', { taskId: 'task-A', title: 'A', branch: 'feat/a' }),
      );

      const before = {
        featureId: state.featureId,
        workflowType: state.workflowType,
        phase: state.phase,
        createdAt: state.createdAt,
        tasks: state.tasks,
        artifacts: state.artifacts,
        synthesis: state.synthesis,
        reviews: state.reviews,
        integration: state.integration,
      };

      const next = workflowStateProjection.apply(
        state,
        makeEvent('synthesize.requested', { featureId: 'f-synth' }),
      );

      expect(next.featureId).toBe(before.featureId);
      expect(next.workflowType).toBe(before.workflowType);
      expect(next.phase).toBe(before.phase);
      expect(next.createdAt).toBe(before.createdAt);
      expect(next.tasks).toEqual(before.tasks);
      expect(next.artifacts).toEqual(before.artifacts);
      expect(next.synthesis).toEqual(before.synthesis);
      expect(next.reviews).toEqual(before.reviews);
      expect(next.integration).toEqual(before.integration);
    });
  });

  describe('workflowStateProjection_workflowPruned_appendsToEvents', () => {
    it('should append workflow.pruned to view._events for audit trail', () => {
      const state = workflowStateProjection.init();
      const ts = '2026-04-11T11:00:00.000Z';

      const event = makeEvent(
        'workflow.pruned',
        { featureId: 'stale-feature', reason: 'stale-timeout', prunedAt: ts },
        { timestamp: ts },
      );
      const next = workflowStateProjection.apply(state, event);

      expect(next._events).toBeDefined();
      expect(Array.isArray(next._events)).toBe(true);
      expect(next._events).toHaveLength(1);
      expect(next._events[0]).toMatchObject({
        type: 'workflow.pruned',
        timestamp: ts,
      });
      expect((next._events[0].data as Record<string, unknown>).reason).toBe(
        'stale-timeout',
      );
    });
  });

  describe('workflowStateProjection_workflowPruned_doesNotMutateOtherFields', () => {
    it('should leave phase, featureId, tasks, and other fields unchanged', () => {
      let state = workflowStateProjection.init();
      state = workflowStateProjection.apply(
        state,
        makeEvent(
          'workflow.started',
          { featureId: 'f-prune', workflowType: 'feature' },
          { timestamp: '2026-04-11T09:00:00.000Z' },
        ),
      );
      state = workflowStateProjection.apply(
        state,
        makeEvent('task.assigned', { taskId: 'task-B', title: 'B', branch: 'feat/b' }),
      );

      const before = {
        featureId: state.featureId,
        workflowType: state.workflowType,
        phase: state.phase,
        createdAt: state.createdAt,
        tasks: state.tasks,
        artifacts: state.artifacts,
        synthesis: state.synthesis,
        reviews: state.reviews,
        integration: state.integration,
      };

      const next = workflowStateProjection.apply(
        state,
        makeEvent('workflow.pruned', { featureId: 'f-prune', reason: 'stale' }),
      );

      expect(next.featureId).toBe(before.featureId);
      expect(next.workflowType).toBe(before.workflowType);
      expect(next.phase).toBe(before.phase);
      expect(next.createdAt).toBe(before.createdAt);
      expect(next.tasks).toEqual(before.tasks);
      expect(next.artifacts).toEqual(before.artifacts);
      expect(next.synthesis).toEqual(before.synthesis);
      expect(next.reviews).toEqual(before.reviews);
      expect(next.integration).toEqual(before.integration);
    });
  });
});

describe('WorkflowStateProjection passthrough events', () => {
  describe('Apply_UnknownEventType_ReturnsStateUnchanged', () => {
    it('should return state unchanged for unrecognized event types', () => {
      const state = workflowStateProjection.init();
      const event = makeEvent('some.unknown.event' as WorkflowEvent['type'], {
        anything: true,
      });
      const next = workflowStateProjection.apply(state, event);

      expect(next).toEqual(state);
    });
  });

  describe('Apply_ObservabilityOnly_ReturnsStateUnchanged', () => {
    it('should return state unchanged for non-team observability events', () => {
      const state = workflowStateProjection.init();

      const toolInvoked = workflowStateProjection.apply(
        state,
        makeEvent('tool.invoked', { tool: 'exarchos_workflow' }),
      );
      expect(toolInvoked).toEqual(state);

      const benchmarkCompleted = workflowStateProjection.apply(
        state,
        makeEvent('benchmark.completed', { taskId: 't1', results: [] }),
      );
      expect(benchmarkCompleted).toEqual(state);

      const gateExecuted = workflowStateProjection.apply(
        state,
        makeEvent('gate.executed', { gateName: 'typecheck', layer: 'L1', passed: true }),
      );
      expect(gateExecuted).toEqual(state);
    });
  });
});

describe('WorkflowStateProjection mutation-adequacy dimension (DR-2a)', () => {
  type Dim = {
    status?: string;
    passed?: boolean;
    mutationScore?: number;
    skipped?: boolean;
    degraded?: boolean;
    noCoverage?: number;
  };
  const dimOf = (s: ReturnType<typeof workflowStateProjection.init>): Dim | undefined =>
    (s.reviews as Record<string, Dim>)['mutation-adequacy'];

  it('foldsMutationGateExecutedIntoReviewsDimension', () => {
    const state = workflowStateProjection.init();
    const next = workflowStateProjection.apply(
      state,
      makeEvent('gate.executed', {
        gateName: 'mutation-adequacy',
        layer: 'review',
        passed: true,
        details: { mutationScore: 0.82, threshold: 0.4 },
      }),
    );
    const dim = dimOf(next);
    expect(dim).toBeDefined();
    expect(dim!.status).toBe('pass');
    expect(dim!.passed).toBe(true);
    expect(dim!.mutationScore).toBe(0.82);
    expect(dim!.skipped ?? false).toBe(false);
  });

  /**
   * A run with no toolchain emits a passing gate with `skipped`. The dimension records `pass` and
   * `skipped`, with no `degraded` marker.
   */
  it('foldsSkipPassWhenNoToolchain', () => {
    const state = workflowStateProjection.init();
    const next = workflowStateProjection.apply(
      state,
      makeEvent('gate.executed', {
        gateName: 'mutation-adequacy',
        layer: 'review',
        passed: true,
        details: { skipped: true, reason: 'no runner', mutationScore: 0 },
      }),
    );
    expect(dimOf(next)!.status).toBe('pass');
    expect(dimOf(next)!.skipped).toBe(true);
    expect(dimOf(next)!.degraded ?? false).toBe(false);
  });

  /**
   * A runner that fails with a toolchain present emits `skipped` and `degraded`. The fold must
   * keep `degraded`, so `allReviewsPassed` can fail the dimension under block enforcement.
   * `skipped` alone does not tell a broken runner from a missing toolchain.
   */
  it('foldsDegradedMarkerFromDegradePath_RVC_R1', () => {
    const state = workflowStateProjection.init();
    const next = workflowStateProjection.apply(
      state,
      makeEvent('gate.executed', {
        gateName: 'mutation-adequacy',
        layer: 'review',
        passed: true,
        details: { skipped: true, degraded: true, reason: 'stryker exited 1', mutationScore: 0 },
      }),
    );
    expect(dimOf(next)!.status).toBe('pass');
    expect(dimOf(next)!.skipped).toBe(true);
    expect(dimOf(next)!.degraded).toBe(true);
  });

  /** The dimension status is always `pass`. The raw gate result stays in `passed`. */
  it('advisoryPassEvenWhenScoreBelowThreshold', () => {
    const state = workflowStateProjection.init();
    const next = workflowStateProjection.apply(
      state,
      makeEvent('gate.executed', {
        gateName: 'mutation-adequacy',
        layer: 'review',
        passed: false,
        details: { mutationScore: 0.1, threshold: 0.4 },
      }),
    );
    expect(dimOf(next)!.status).toBe('pass');
    expect(dimOf(next)!.passed).toBe(false);
    expect(dimOf(next)!.mutationScore).toBe(0.1);
  });

  it('nonMutationGateExecutedIsNoOp', () => {
    const state = workflowStateProjection.init();
    const next = workflowStateProjection.apply(
      state,
      makeEvent('gate.executed', { gateName: 'static-analysis', layer: 'delegate', passed: true }),
    );
    expect(next).toEqual(state);
  });

  /** The fold keeps `noCoverage` from the event details, and does not change `mutationScore`. */
  it('Fold_MutationEventWithNoCoverage_CarriesField', () => {
    const state = workflowStateProjection.init();
    const next = workflowStateProjection.apply(
      state,
      makeEvent('gate.executed', {
        gateName: 'mutation-adequacy',
        layer: 'review',
        passed: false,
        details: { mutationScore: 1.0, noCoverage: 3, threshold: 0.4 },
      }),
    );
    const dim = dimOf(next)!;
    expect(dim.status).toBe('pass');
    expect(dim.mutationScore).toBe(1.0);
    expect(dim.noCoverage).toBe(3);
  });

  /** An old event with no `noCoverage` in its details must fold to a dimension with no `noCoverage` key. */
  it('Fold_LegacyMutationEventWithoutNoCoverage_FoldsIdentically', () => {
    const legacyEvent = makeEvent('gate.executed', {
      gateName: 'mutation-adequacy',
      layer: 'review',
      passed: true,
      details: { mutationScore: 0.82, threshold: 0.4 },
    });
    const dim = dimOf(workflowStateProjection.apply(workflowStateProjection.init(), legacyEvent))!;
    expect(dim).toEqual({
      status: 'pass',
      gateName: 'mutation-adequacy',
      passed: true,
      mutationScore: 0.82,
    });
    expect('noCoverage' in dim).toBe(false);
  });
});

describe('WorkflowStateProjection round-trip', () => {
  describe('RoundTrip_FullEventSequence_ProducesCompleteState', () => {
    it('should produce a complete state from a realistic event sequence', () => {
      let state = workflowStateProjection.init();

      state = workflowStateProjection.apply(
        state,
        makeEvent(
          'workflow.started',
          { featureId: 'round-trip', workflowType: 'feature' },
          { timestamp: '2026-02-19T10:00:00.000Z' },
        ),
      );
      expect(state.featureId).toBe('round-trip');
      expect(state.phase).toBe('plan');

      state = workflowStateProjection.apply(
        state,
        makeEvent('state.patched', {
          patch: { artifacts: { design: 'docs/design.md', plan: 'docs/plan.md', pr: null } },
        }),
      );
      expect(state.artifacts.design).toBe('docs/design.md');

      state = workflowStateProjection.apply(
        state,
        makeEvent(
          'workflow.transition',
          { from: 'ideate', to: 'plan', trigger: 'next', featureId: 'round-trip' },
          { timestamp: '2026-02-19T10:05:00.000Z' },
        ),
      );
      expect(state.phase).toBe('plan');

      state = workflowStateProjection.apply(
        state,
        makeEvent('task.assigned', { taskId: 't1', title: 'Task 1', branch: 'feat/t1' }),
      );
      state = workflowStateProjection.apply(
        state,
        makeEvent('task.assigned', { taskId: 't2', title: 'Task 2', branch: 'feat/t2' }),
      );
      state = workflowStateProjection.apply(
        state,
        makeEvent('task.assigned', { taskId: 't3', title: 'Task 3', branch: 'feat/t3' }),
      );
      expect(state.tasks).toHaveLength(3);

      state = workflowStateProjection.apply(
        state,
        makeEvent(
          'task.completed',
          { taskId: 't1' },
          { timestamp: '2026-02-19T11:00:00.000Z' },
        ),
      );
      state = workflowStateProjection.apply(
        state,
        makeEvent(
          'task.completed',
          { taskId: 't2' },
          { timestamp: '2026-02-19T11:05:00.000Z' },
        ),
      );

      state = workflowStateProjection.apply(
        state,
        makeEvent('task.failed', { taskId: 't3', error: 'test failure' }),
      );

      const t1 = state.tasks.find((t) => t.id === 't1');
      const t2 = state.tasks.find((t) => t.id === 't2');
      const t3 = state.tasks.find((t) => t.id === 't3');
      expect(t1?.status).toBe('complete');
      expect(t1?.completedAt).toBe('2026-02-19T11:00:00.000Z');
      expect(t2?.status).toBe('complete');
      expect(t3?.status).toBe('failed');

      state = workflowStateProjection.apply(
        state,
        makeEvent('state.patched', {
          patch: {
            synthesis: {
              integrationBranch: 'main',
              mergeOrder: ['feat/t1', 'feat/t2'],
              mergedBranches: ['feat/t1', 'feat/t2'],
              prUrl: 'https://github.com/pr/99',
            },
          },
        }),
      );
      expect(state.synthesis.integrationBranch).toBe('main');
      expect(state.synthesis.prUrl).toBe('https://github.com/pr/99');

      state = workflowStateProjection.apply(
        state,
        makeEvent(
          'workflow.transition',
          { from: 'plan', to: 'completed', trigger: 'finish', featureId: 'round-trip' },
          { timestamp: '2026-02-19T12:00:00.000Z' },
        ),
      );
      expect(state.phase).toBe('completed');
      expect(state.updatedAt).toBe('2026-02-19T12:00:00.000Z');

      expect(state.featureId).toBe('round-trip');
      expect(state.workflowType).toBe('feature');
      expect(state.tasks).toHaveLength(3);
      expect(state.artifacts.design).toBe('docs/design.md');
      expect(state.artifacts.plan).toBe('docs/plan.md');
    });
  });
});

describe('WorkflowStateProjection immutability', () => {
  it('should not mutate the input state', () => {
    const original = workflowStateProjection.init();
    const frozen = JSON.parse(JSON.stringify(original));

    workflowStateProjection.apply(
      original,
      makeEvent('workflow.started', { featureId: 'immut-test', workflowType: 'feature' }),
    );

    expect(original).toEqual(frozen);
  });

  it('should not mutate the tasks array', () => {
    let state = workflowStateProjection.init();
    state = workflowStateProjection.apply(
      state,
      makeEvent('task.assigned', { taskId: 't1', title: 'T1' }),
    );

    const tasksBefore = state.tasks;

    workflowStateProjection.apply(
      state,
      makeEvent('task.assigned', { taskId: 't2', title: 'T2' }),
    );

    expect(tasksBefore).toHaveLength(1);
  });
});

describe('WorkflowStateProjection phase.entered / phase.exited', () => {
  const enteredData = {
    phase: 'implement',
    kind: 'IMPLEMENT',
    resolver: 'verification-ladder',
    resolvedGates: [
      { family: 'ladder', gate: 'check_static_analysis' },
      { family: 'ladder', gate: 'check_test_adequacy' },
    ],
    policySource: 'builtin',
    mode: 'enforce',
    posture: 'task-isolated',
  } as const;

  const fold = (evts: WorkflowEvent[]) =>
    evts.reduce(
      (v, e) => workflowStateProjection.apply(v, e),
      workflowStateProjection.init(),
    );

  /**
   * The fold keeps the frozen obligation from `phase.entered`. A second fold of the same log gives
   * the same obligation, because the fold reads `kind` from the event and not from the phase name.
   */
  it('workflowStateProjection_PhaseEnteredExited_FoldedAndReplayStable', () => {
    const events: WorkflowEvent[] = [
      makeEvent('workflow.started', { featureId: 'f1', workflowType: 'feature' }),
      makeEvent('workflow.transition', { to: 'implement' }),
      makeEvent('phase.entered', { ...enteredData }),
    ];

    const afterEntered = fold(events);
    expect(afterEntered.phaseObligation).toEqual({
      phase: 'implement',
      kind: 'IMPLEMENT',
      resolver: 'verification-ladder',
      resolvedGates: enteredData.resolvedGates,
      policySource: 'builtin',
      mode: 'enforce',
      posture: 'task-isolated',
      enteredAt: expect.any(String),
      exited: false,
      allRequiredGatesPassed: null,
    });

    const replayed = fold(events);
    expect(replayed.phaseObligation).toEqual(afterEntered.phaseObligation);
  });

  /** `phase.exited` records the gate status only. The frozen resolver and gate set do not change. */
  it('workflowStateProjection_PhaseExited_RecordsAggregateStatus_FreezeUntouched', () => {
    const afterEntered = fold([
      makeEvent('workflow.started', { featureId: 'f1', workflowType: 'feature' }),
      makeEvent('phase.entered', { ...enteredData }),
    ]);

    const afterExited = workflowStateProjection.apply(
      afterEntered,
      makeEvent('phase.exited', { phase: 'implement', allRequiredGatesPassed: true }),
    );

    expect(afterExited.phaseObligation?.exited).toBe(true);
    expect(afterExited.phaseObligation?.allRequiredGatesPassed).toBe(true);
    expect(afterExited.phaseObligation?.resolver).toBe('verification-ladder');
    expect(afterExited.phaseObligation?.resolvedGates).toEqual(enteredData.resolvedGates);
  });

  it('workflowStateProjection_GatherPhaseEntered_FreezesEmptyObligation', () => {
    const afterEntered = fold([
      makeEvent('workflow.started', { featureId: 'f1', workflowType: 'feature' }),
      makeEvent('phase.entered', {
        phase: 'gather',
        kind: 'GATHER',
        resolver: null,
        resolvedGates: [],
        policySource: 'builtin',
        mode: 'enforce',
        posture: 'read-only',
      }),
    ]);
    expect(afterEntered.phaseObligation?.kind).toBe('GATHER');
    expect(afterEntered.phaseObligation?.resolver).toBeNull();
    expect(afterEntered.phaseObligation?.resolvedGates).toEqual([]);
    expect(afterEntered.phaseObligation?.posture).toBe('read-only');
  });

  /**
   * The fold keeps the `designDepth` of the PLAN `phase.entered`, and a replay gives the same value.
   * A later `phase.entered` with no `designDepth` does not clear it. A workflow with no PLAN depth
   * leaves it undefined, and readers then use `standard`.
   */
  it('DesignDepth_ProjectionRoundTrip_RecoversFrozenValue', () => {
    const planEntered = {
      phase: 'plan',
      kind: 'PLAN',
      resolver: 'plan-structure',
      resolvedGates: [{ family: 'plan', gate: 'check_task_decomposition' }],
      policySource: 'builtin',
      mode: 'enforce',
      posture: 'read-only',
      designDepth: 'deep',
    } as const;
    const events: WorkflowEvent[] = [
      makeEvent('workflow.started', { featureId: 'f1', workflowType: 'feature' }),
      makeEvent('phase.entered', { ...planEntered }),
    ];

    expect(fold(events).designDepth).toBe('deep');
    expect(fold(events).designDepth).toBe('deep');

    const afterNonPlan = workflowStateProjection.apply(
      fold(events),
      makeEvent('phase.entered', {
        phase: 'implement',
        kind: 'IMPLEMENT',
        resolver: 'verification-ladder',
        resolvedGates: [],
        policySource: 'builtin',
        mode: 'enforce',
        posture: 'task-isolated',
      }),
    );
    expect(afterNonPlan.designDepth).toBe('deep');

    const noPlan = fold([
      makeEvent('workflow.started', { featureId: 'f2', workflowType: 'feature' }),
    ]);
    expect(noPlan.designDepth).toBeUndefined();
  });
});

/**
 * The fold of the terminal merge events into `mergeOrchestrator`, so `resolveWorkflowState` can
 * rebuild that block.
 */
describe('WorkflowStateProjection mergeOrchestrator fold', () => {
  it('MergeExecuted_FoldsCompletedBlock', () => {
    let view = workflowStateProjection.init();
    view = workflowStateProjection.apply(view, makeEvent('workflow.started', {
      featureId: 'feat-m', workflowType: 'feature',
    }));
    view = workflowStateProjection.apply(view, makeEvent('merge.executed', {
      taskId: 't1', sourceBranch: 'task/t1', targetBranch: 'integration',
      strategy: 'squash', mergeSha: 'abc123',
    }));

    expect(view.mergeOrchestrator).toBeDefined();
    expect(view.mergeOrchestrator).toMatchObject({
      phase: 'completed',
      taskId: 't1',
      sourceBranch: 'task/t1',
      targetBranch: 'integration',
      strategy: 'squash',
      mergeSha: 'abc123',
    });
  });

  it('MergeRollback_FoldsRolledBackBlockWithRecoveryError', () => {
    let view = workflowStateProjection.init();
    view = workflowStateProjection.apply(view, makeEvent('merge.rollback', {
      taskId: 't2', sourceBranch: 'task/t2', targetBranch: 'integration',
      rollbackSha: 'def456', reason: 'verification-failed',
      recoveryError: 'reset-keep-blocked',
    }));

    expect(view.mergeOrchestrator).toMatchObject({
      phase: 'rolled-back',
      taskId: 't2',
      rollbackSha: 'def456',
      reason: 'verification-failed',
      recoveryError: 'reset-keep-blocked',
    });
  });

  it('MergePreflightFailed_FoldsAbortedBlock', () => {
    let view = workflowStateProjection.init();
    view = workflowStateProjection.apply(view, makeEvent('merge.preflight', {
      passed: false, taskId: 't3', sourceBranch: 'task/t3', targetBranch: 'integration',
    }));

    expect(view.mergeOrchestrator).toMatchObject({
      phase: 'aborted',
      abortReason: 'preflight-failed',
      taskId: 't3',
    });
  });

  /** A passing preflight writes no block. The next terminal write comes from `merge.executed`. */
  it('MergePreflightPassed_IsObservationOnly_NoBlock', () => {
    let view = workflowStateProjection.init();
    view = workflowStateProjection.apply(view, makeEvent('merge.preflight', {
      passed: true, taskId: 't4', sourceBranch: 'task/t4', targetBranch: 'integration',
    }));

    expect(view.mergeOrchestrator).toBeUndefined();
  });
});

describe('WorkflowStateProjection plan-revision count (DR-1)', () => {
  type View = ReturnType<typeof workflowStateProjection.init>;
  function revisionCountOf(state: View): number | undefined {
    const planReview = state.planReview as { revisionCount?: number } | undefined;
    return planReview?.revisionCount;
  }

  /**
   * The count folds into the nested `planReview.revisionCount`, the field that
   * `revisionsExhausted` reads. It is not a top-level field.
   */
  it('Apply_PlanRevision_FoldsIntoNestedPlanReviewRevisionCount', () => {
    let state = workflowStateProjection.init();
    expect(revisionCountOf(state)).toBeUndefined();
    expect(state.revisionCount).toBeUndefined();

    state = workflowStateProjection.apply(
      state,
      makeEvent('workflow.plan-revision', { count: 1, featureId: 'f' }),
    );
    expect(revisionCountOf(state)).toBe(1);

    state = workflowStateProjection.apply(
      state,
      makeEvent('workflow.plan-revision', { count: 2, featureId: 'f' }),
    );
    expect(revisionCountOf(state)).toBe(2);
    expect(state.revisionCount).toBeUndefined();
  });

  /** The fold spreads the prior `planReview`, so an `approved` from `state.patched` stays. */
  it('Apply_PlanRevision_PreservesOtherPlanReviewFields', () => {
    let state = workflowStateProjection.init();
    state = workflowStateProjection.apply(
      state,
      makeEvent('state.patched', { patch: { 'planReview.approved': true } }),
    );
    state = workflowStateProjection.apply(
      state,
      makeEvent('workflow.plan-revision', { count: 1, featureId: 'f' }),
    );

    const planReview = state.planReview as {
      approved?: boolean;
      revisionCount?: number;
    };
    expect(planReview.approved).toBe(true);
    expect(planReview.revisionCount).toBe(1);
  });

  /** The count derives only from events. A replay from `init()` gives the same count, so a rebuild cannot drift. */
  it('Apply_PlanRevision_CountIsEventDerivedAndSurvivesReplay', () => {
    const events: WorkflowEvent[] = [
      makeEvent('workflow.started', { featureId: 'f', workflowType: 'feature' }),
      makeEvent('workflow.plan-revision', { count: 1, featureId: 'f' }),
      makeEvent('workflow.plan-revision', { count: 2, featureId: 'f' }),
      makeEvent('workflow.plan-revision', { count: 3, featureId: 'f' }),
    ];

    const foldAll = (): View =>
      events.reduce(
        (s, e) => workflowStateProjection.apply(s, e),
        workflowStateProjection.init(),
      );

    const live = foldAll();
    const replayed = foldAll();

    expect(revisionCountOf(live)).toBe(3);
    expect(revisionCountOf(replayed)).toBe(3);
    expect(replayed.planReview).toEqual(live.planReview);
  });
});

describe('WorkflowStateProjection plan-review-dispatch count (WLM-6 DR-2)', () => {
  type View = ReturnType<typeof workflowStateProjection.init>;
  function revisionCountOf(state: View): number | undefined {
    const planReview = state.planReview as { revisionCount?: number } | undefined;
    return planReview?.revisionCount;
  }
  const dispatched = (ordinal: number): WorkflowEvent =>
    makeEvent('workflow.plan-review-dispatched', { featureId: 'f', ordinal });

  /**
   * `workflow.plan-review-dispatched` events fold into `planReview.revisionCount`, the field that
   * `revisionsExhausted` reads. The first review has ordinal 0 and is revision 0. A dispatch with
   * ordinal N is revision N.
   */
  it('RevisionCount_FoldsFromDispatchEvent_NotStandardEdge', () => {
    let state = workflowStateProjection.init();
    expect(revisionCountOf(state)).toBeUndefined();

    state = workflowStateProjection.apply(state, dispatched(0));
    expect(revisionCountOf(state)).toBe(0);
    expect(state.revisionCount).toBeUndefined();

    state = workflowStateProjection.apply(state, dispatched(1));
    expect(revisionCountOf(state)).toBe(1);

    state = workflowStateProjection.apply(state, dispatched(2));
    expect(revisionCountOf(state)).toBe(2);
  });

  /**
   * The fold takes the max of the count and the ordinal, so a duplicate ordinal does not count
   * twice. Thus `revisionCount` stays the number of re-dispatches.
   */
  it('Apply_PlanReviewDispatch_FoldsMaxOrdinal_IdempotentUnderDuplicate', () => {
    let state = workflowStateProjection.init();
    state = workflowStateProjection.apply(state, dispatched(0));
    state = workflowStateProjection.apply(state, dispatched(1));
    state = workflowStateProjection.apply(state, dispatched(1));
    expect(revisionCountOf(state)).toBe(1);
  });

  /** The fold spreads the prior `planReview`, so an `approved` from `state.patched` stays. */
  it('Apply_PlanReviewDispatch_PreservesOtherPlanReviewFields', () => {
    let state = workflowStateProjection.init();
    state = workflowStateProjection.apply(
      state,
      makeEvent('state.patched', { patch: { 'planReview.approved': true } }),
    );
    state = workflowStateProjection.apply(state, dispatched(0));
    state = workflowStateProjection.apply(state, dispatched(1));
    const planReview = state.planReview as { approved?: boolean; revisionCount?: number };
    expect(planReview.approved).toBe(true);
    expect(planReview.revisionCount).toBe(1);
  });

  it('Apply_PlanReviewDispatch_CountIsEventDerivedAndSurvivesReplay', () => {
    const events: WorkflowEvent[] = [
      makeEvent('workflow.started', { featureId: 'f', workflowType: 'feature' }),
      dispatched(0),
      dispatched(1),
      dispatched(2),
    ];
    const foldAll = (): View =>
      events.reduce(
        (s, e) => workflowStateProjection.apply(s, e),
        workflowStateProjection.init(),
      );
    const live = foldAll();
    const replayed = foldAll();
    expect(revisionCountOf(live)).toBe(2);
    expect(revisionCountOf(replayed)).toBe(2);
    expect(replayed.planReview).toEqual(live.planReview);
  });
});
