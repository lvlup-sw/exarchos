/**
 * Wave 2A.3 — taskStoreReducer.apply unit tests (#1284).
 *
 * One `it(...)` per registered `task.*` event type per the plan:
 *
 *   - Apply_TaskAssigned_CreatesAssignedRecord
 *   - Apply_TaskClaimed_TransitionsToClaimed
 *   - Apply_TaskProgressed_UpdatesProgressMetadata
 *   - Apply_TaskCompleted_TransitionsToCompleted
 *   - Apply_TaskFailed_TransitionsToFailed
 *   - Apply_UnknownEvent_ReturnsStateUnchanged
 *
 * Each test seeds an initial state, applies one event, and asserts on the
 * resulting record + the `projectionSequence` monotonic bump for handled
 * events (or identity preservation for the unknown-event case).
 */
import { describe, it, expect } from 'vitest';
import type { WorkflowEvent } from '../../events/schemas.js';
import { taskStoreReducer } from './reducer.js';
import type { TaskStoreState } from './types.js';
import { assertReducerImmutable } from '../testing.js';

/**
 * Construct a `WorkflowEvent` shape with sane defaults for the fields the
 * reducer does not consume. Sequence is monotonic across the per-test event
 * list (the reducer does not require a per-stream sequence; this is only to
 * keep WorkflowEventBase happy).
 */
function buildEvent(overrides: {
  type: string;
  streamId?: string;
  sequence?: number;
  data?: Record<string, unknown>;
}): WorkflowEvent {
  return {
    streamId: overrides.streamId ?? 'wf-test',
    sequence: overrides.sequence ?? 1,
    timestamp: '2026-05-10T00:00:00.000Z',
    type: overrides.type,
    schemaVersion: '1.0',
    data: overrides.data,
  } as WorkflowEvent;
}

describe('taskStoreReducer.apply (Wave 2A.3, #1284)', () => {
  it('Apply_TaskAssigned_CreatesAssignedRecord', () => {
    const state: TaskStoreState = taskStoreReducer.initial;
    const event = buildEvent({
      type: 'task.assigned',
      data: {
        taskId: 'T-1',
        title: 'Implement reducer',
        branch: 'feature/X',
        worktree: '/tmp/wf-test/T-1',
        assignee: 'agent-1',
      },
    });

    const next = taskStoreReducer.apply(state, event);

    expect(next.projectionSequence).toBe(1);
    expect(next.tasks['T-1']).toBeDefined();
    expect(next.tasks['T-1']).toMatchObject({
      taskId: 'T-1',
      status: 'assigned',
      title: 'Implement reducer',
      branch: 'feature/X',
      worktree: '/tmp/wf-test/T-1',
      assignee: 'agent-1',
    });
  });

  it('Apply_TaskClaimed_TransitionsToClaimed', () => {
    // Seed with a prior assignment so the claim transitions a known record.
    const seeded = taskStoreReducer.apply(
      taskStoreReducer.initial,
      buildEvent({
        type: 'task.assigned',
        data: { taskId: 'T-1', title: 'Implement', assignee: 'agent-1' },
      }),
    );

    const claimEvent = buildEvent({
      type: 'task.claimed',
      sequence: 2,
      data: {
        taskId: 'T-1',
        agentId: 'agent-2',
        claimedAt: '2026-05-10T00:01:00.000Z',
      },
    });
    const next = taskStoreReducer.apply(seeded, claimEvent);

    expect(next.projectionSequence).toBe(2);
    expect(next.tasks['T-1'].status).toBe('claimed');
    expect(next.tasks['T-1'].agentId).toBe('agent-2');
    expect(next.tasks['T-1'].claimedAt).toBe('2026-05-10T00:01:00.000Z');
    // Passthrough fields from prior assignment are preserved.
    expect(next.tasks['T-1'].title).toBe('Implement');
  });

  it('Apply_TaskProgressed_UpdatesProgressMetadata', () => {
    const seeded = taskStoreReducer.apply(
      taskStoreReducer.initial,
      buildEvent({
        type: 'task.assigned',
        data: { taskId: 'T-1', title: 'Implement' },
      }),
    );

    const progressEvent = buildEvent({
      type: 'task.progressed',
      sequence: 2,
      data: { taskId: 'T-1', tddPhase: 'green', detail: 'tests pass' },
    });
    const next = taskStoreReducer.apply(seeded, progressEvent);

    expect(next.projectionSequence).toBe(2);
    expect(next.tasks['T-1'].status).toBe('in-progress');
    expect(next.tasks['T-1'].tddPhase).toBe('green');
    expect(next.tasks['T-1'].detail).toBe('tests pass');
    expect(next.tasks['T-1'].title).toBe('Implement');
  });

  it('Apply_TaskCompleted_TransitionsToCompleted', () => {
    const seeded = taskStoreReducer.apply(
      taskStoreReducer.initial,
      buildEvent({
        type: 'task.assigned',
        data: { taskId: 'T-1', title: 'Implement' },
      }),
    );

    const completedEvent = buildEvent({
      type: 'task.completed',
      sequence: 2,
      data: {
        taskId: 'T-1',
        artifacts: ['src/foo.ts', 'src/foo.test.ts'],
        duration: 1500,
      },
    });
    const next = taskStoreReducer.apply(seeded, completedEvent);

    expect(next.projectionSequence).toBe(2);
    expect(next.tasks['T-1'].status).toBe('completed');
    expect(next.tasks['T-1'].artifacts).toEqual([
      'src/foo.ts',
      'src/foo.test.ts',
    ]);
    expect(next.tasks['T-1'].duration).toBe(1500);
  });

  it('Apply_TaskFailed_TransitionsToFailed', () => {
    const seeded = taskStoreReducer.apply(
      taskStoreReducer.initial,
      buildEvent({
        type: 'task.assigned',
        data: { taskId: 'T-1', title: 'Implement' },
      }),
    );

    const failedEvent = buildEvent({
      type: 'task.failed',
      sequence: 2,
      data: { taskId: 'T-1', error: 'typecheck failed' },
    });
    const next = taskStoreReducer.apply(seeded, failedEvent);

    expect(next.projectionSequence).toBe(2);
    expect(next.tasks['T-1'].status).toBe('failed');
    expect(next.tasks['T-1'].error).toBe('typecheck failed');
  });

  it('Apply_UnknownEvent_ReturnsStateUnchanged', () => {
    const state: TaskStoreState = taskStoreReducer.initial;
    const unknownEvent = buildEvent({
      type: 'workflow.started',
      data: { featureId: 'X', workflowType: 'feature' },
    });

    const next = taskStoreReducer.apply(state, unknownEvent);

    expect(next).toBe(state); // identity preserved
    expect(next.projectionSequence).toBe(0);
    expect(Object.keys(next.tasks)).toHaveLength(0);
  });

  it('Apply_TaskAssigned_MissingTaskId_ReturnsStateUnchanged', () => {
    // Robustness: a malformed task.assigned without a taskId should be a no-op.
    const state: TaskStoreState = taskStoreReducer.initial;
    const malformed = buildEvent({
      type: 'task.assigned',
      data: { title: 'no id here' },
    });

    const next = taskStoreReducer.apply(state, malformed);
    expect(next).toBe(state);
    expect(next.projectionSequence).toBe(0);
  });

  // ─── Task 2A.4 — assertReducerImmutable ────────────────────────────────
  it('TaskStoreReducer_IsImmutable', () => {
    // Folds a representative event sequence through assertReducerImmutable.
    // The harness deep-freezes every intermediate state; any in-place mutation
    // inside `apply` throws a TypeError under ESM strict mode.
    const events: WorkflowEvent[] = [
      buildEvent({
        type: 'task.assigned',
        sequence: 1,
        data: { taskId: 'T-1', title: 'Implement' },
      }),
      buildEvent({
        type: 'task.claimed',
        sequence: 2,
        data: { taskId: 'T-1', agentId: 'agent-A', claimedAt: 'now' },
      }),
      buildEvent({
        type: 'task.progressed',
        sequence: 3,
        data: { taskId: 'T-1', tddPhase: 'red' },
      }),
      buildEvent({
        type: 'task.assigned',
        sequence: 4,
        data: { taskId: 'T-2', title: 'Second task' },
      }),
      buildEvent({
        type: 'task.completed',
        sequence: 5,
        data: { taskId: 'T-1', duration: 100, artifacts: ['a.ts'] },
      }),
      buildEvent({
        type: 'task.failed',
        sequence: 6,
        data: { taskId: 'T-2', error: 'boom' },
      }),
      buildEvent({
        type: 'workflow.started',
        sequence: 7,
        data: { featureId: 'X', workflowType: 'feature' },
      }),
    ];
    expect(() => assertReducerImmutable(taskStoreReducer, events)).not.toThrow();
  });

  it('TaskStoreReducer_HasStreamScope', () => {
    // This reducer MUST be `scope: 'stream'` — see `TaskStoreState`'s key space
    // in `./types.ts` for why. Wired through the registry check in 2A.5, but
    // asserted statically here so a misconfiguration surfaces in the reducer
    // test, not via a side-effect import in another file.
    expect(taskStoreReducer.scope).toBe('stream');
    expect(taskStoreReducer.id).toBe('task-store@v1');
    expect(taskStoreReducer.version).toBe(1);
  });
});
