/**
 * Tests for `taskStoreReducer.apply`: one test for each handled `task.*` event type, and tests
 * for the events that it ignores.
 *
 * A handled event increments `projectionSequence`. An ignored event returns the state by identity.
 */
import { describe, it, expect } from 'vitest';
import type { WorkflowEvent } from '../../../../src/events/schemas.js';
import { taskStoreReducer } from '../../../../src/projections/taskstore/reducer.js';
import type { TaskStoreState } from '../../../../src/projections/taskstore/types.js';
import { assertReducerImmutable } from '../../../../src/projections/testing.js';

/** Builds a `WorkflowEvent` with defaults for the fields that the reducer does not read. */
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

  /** The claim keeps the `title` from the earlier `task.assigned` event. */
  it('Apply_TaskClaimed_TransitionsToClaimed', () => {
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

    expect(next).toBe(state);
    expect(next.projectionSequence).toBe(0);
    expect(Object.keys(next.tasks)).toHaveLength(0);
  });

  it('Apply_TaskAssigned_MissingTaskId_ReturnsStateUnchanged', () => {
    const state: TaskStoreState = taskStoreReducer.initial;
    const malformed = buildEvent({
      type: 'task.assigned',
      data: { title: 'no id here' },
    });

    const next = taskStoreReducer.apply(state, malformed);
    expect(next).toBe(state);
    expect(next.projectionSequence).toBe(0);
  });

  /** `assertReducerImmutable` freezes each intermediate state, so a mutation inside `apply` throws a `TypeError`. */
  it('TaskStoreReducer_IsImmutable', () => {
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

  /** Pins `scope: 'stream'` on the reducer itself. `src/projections/taskstore/types.ts` gives the reason. */
  it('TaskStoreReducer_HasStreamScope', () => {
    expect(taskStoreReducer.scope).toBe('stream');
    expect(taskStoreReducer.id).toBe('task-store@v1');
    expect(taskStoreReducer.version).toBe(1);
  });
});
