import { describe, it, expect } from 'vitest';
import type { WorkflowEvent } from '../event-store/schemas.js';
import {
  workflowStateProjection,
  WORKFLOW_STATE_VIEW,
} from './workflow-state-projection.js';

// ─── Test Helpers ──────────────────────────────────────────────────────────

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

// ─── View Name ─────────────────────────────────────────────────────────────

describe('WORKFLOW_STATE_VIEW', () => {
  it('should export the view name constant', () => {
    expect(WORKFLOW_STATE_VIEW).toBe('workflow-state');
  });
});

// ─── init() ────────────────────────────────────────────────────────────────

describe('WorkflowStateProjection init', () => {
  describe('Init_NoEvents_ReturnsMinimalSkeleton', () => {
    it('should return a valid skeleton with empty arrays and objects', () => {
      const state = workflowStateProjection.init();

      expect(state.version).toBe('1.1');
      expect(state.featureId).toBe('');
      expect(state.workflowType).toBe('feature');
      expect(state.phase).toBe('ideate');
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

// ─── Workflow Lifecycle ────────────────────────────────────────────────────

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
      expect(next.phase).toBe('ideate');
      expect(next.createdAt).toBe(ts);
      expect(next.updatedAt).toBe(ts);
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
      expect(next._checkpoint.operationsSince).toBe(0); // unchanged from init
    });
  });
});

// ─── Task Events ───────────────────────────────────────────────────────────

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

      // Assign first task
      state = workflowStateProjection.apply(
        state,
        makeEvent('task.assigned', {
          taskId: 'task-1',
          title: 'Original title',
          branch: 'feat/old',
        }),
      );

      // Assign same taskId again with different data
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

// ─── state.patched ─────────────────────────────────────────────────────────

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

      // First patch sets some synthesis fields
      state = workflowStateProjection.apply(
        state,
        makeEvent('state.patched', {
          patch: { synthesis: { integrationBranch: 'main', mergeOrder: ['a', 'b'] } },
        }),
      );

      // Second patch merges additional synthesis fields without overwriting existing ones
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
  });
});

// ─── Stack and Review Events ───────────────────────────────────────────────

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

// ─── Observability and Unknown Events ──────────────────────────────────────

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

  describe('Apply_TeamSpawned_ReturnsStateUnchanged', () => {
    it('should return state unchanged for observability events', () => {
      const state = workflowStateProjection.init();

      const teamSpawned = workflowStateProjection.apply(
        state,
        makeEvent('team.spawned', { teamSize: 3, teammateNames: ['a', 'b', 'c'], taskCount: 3, dispatchMode: 'parallel' }),
      );
      expect(teamSpawned).toEqual(state);

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

// ─── Round-Trip Integration ────────────────────────────────────────────────

describe('WorkflowStateProjection round-trip', () => {
  describe('RoundTrip_FullEventSequence_ProducesCompleteState', () => {
    it('should produce a complete state from a realistic event sequence', () => {
      let state = workflowStateProjection.init();

      // 1. workflow.started
      state = workflowStateProjection.apply(
        state,
        makeEvent(
          'workflow.started',
          { featureId: 'round-trip', workflowType: 'feature' },
          { timestamp: '2026-02-19T10:00:00.000Z' },
        ),
      );
      expect(state.featureId).toBe('round-trip');
      expect(state.phase).toBe('ideate');

      // 2. state.patched (add artifacts)
      state = workflowStateProjection.apply(
        state,
        makeEvent('state.patched', {
          patch: { artifacts: { design: 'docs/design.md', plan: 'docs/plan.md', pr: null } },
        }),
      );
      expect(state.artifacts.design).toBe('docs/design.md');

      // 3. workflow.transition (ideate -> plan)
      state = workflowStateProjection.apply(
        state,
        makeEvent(
          'workflow.transition',
          { from: 'ideate', to: 'plan', trigger: 'next', featureId: 'round-trip' },
          { timestamp: '2026-02-19T10:05:00.000Z' },
        ),
      );
      expect(state.phase).toBe('plan');

      // 4. task.assigned x 3
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

      // 5. task.completed x 2
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

      // 6. task.failed x 1
      state = workflowStateProjection.apply(
        state,
        makeEvent('task.failed', { taskId: 't3', error: 'test failure' }),
      );

      // Verify task statuses
      const t1 = state.tasks.find((t) => t.id === 't1');
      const t2 = state.tasks.find((t) => t.id === 't2');
      const t3 = state.tasks.find((t) => t.id === 't3');
      expect(t1?.status).toBe('complete');
      expect(t1?.completedAt).toBe('2026-02-19T11:00:00.000Z');
      expect(t2?.status).toBe('complete');
      expect(t3?.status).toBe('failed');

      // 7. state.patched (synthesis data)
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

      // 8. workflow.transition -> completed
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

      // Final assertions
      expect(state.featureId).toBe('round-trip');
      expect(state.workflowType).toBe('feature');
      expect(state.tasks).toHaveLength(3);
      expect(state.artifacts.design).toBe('docs/design.md');
      expect(state.artifacts.plan).toBe('docs/plan.md');
    });
  });
});

// ─── Immutability ──────────────────────────────────────────────────────────

describe('WorkflowStateProjection immutability', () => {
  it('should not mutate the input state', () => {
    const original = workflowStateProjection.init();
    const frozen = JSON.parse(JSON.stringify(original));

    workflowStateProjection.apply(
      original,
      makeEvent('workflow.started', { featureId: 'immut-test', workflowType: 'feature' }),
    );

    // Original should be unchanged
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

    // Original tasks array should not have been mutated
    expect(tasksBefore).toHaveLength(1);
  });
});
