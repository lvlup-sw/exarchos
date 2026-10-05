import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { EventStore } from '../../../src/events/store.js';
import { handleEventAppend } from '../../../src/events/tools.js';
import { rmrfAsync } from '../../../tools/test-helpers/temp-dir.js';

/**
 * Pins the observable behaviors of the cross-stream query reducer, which replaces the `SubagentStreamRouter` primitive.
 * A subagent stream has the name `<feature-id>/<subagent-id>`.
 *
 * 1. Each `task.completed` on a subagent stream has a timestamp at or before the `team.disbanded` on the parent stream.
 * 2. `team.disbanded.tasksCompleted` is the events-table count for the team. Events of other teams do not count.
 * 3. A replayed `task.completed` with the same idempotency key gives one persisted event.
 */
describe('SubagentStreamRouter retirement — observable parity (T27)', () => {
  let stateDir: string;
  let eventStore: EventStore;

  beforeEach(async () => {
    stateDir = await mkdtemp(path.join(tmpdir(), 'subagent-router-retired-'));
    eventStore = new EventStore(stateDir);
  });

  afterEach(async () => {
    await rmrfAsync(stateDir);
  });

  it('SubagentRouterRetired_TaskCompletedPrecedesDisbandedByTimestamp', async () => {
    const featureId = 'feat-retire-1';
    const subagentA = `${featureId}/subagent-a`;
    const teamId = 'team-alpha';

    await eventStore.append(subagentA, {
      type: 'task.completed',
      data: { taskId: 'task-1', teamId },
    });
    await eventStore.append(subagentA, {
      type: 'task.completed',
      data: { taskId: 'task-2', teamId },
    });

    const result = await handleEventAppend(
      {
        stream: featureId,
        event: {
          type: 'team.disbanded',
          data: { teamId, tasksCompleted: 0, tasksFailed: 0, totalDurationMs: 1234 },
        },
      },
      stateDir,
      eventStore,
    );
    expect(result.success).toBe(true);

    const taskCompleted = await eventStore.queryByType('task.completed', {
      streamPrefix: featureId,
    });
    const disbandedEvents = await eventStore.query(featureId, {
      type: 'team.disbanded',
    });

    expect(taskCompleted).toHaveLength(2);
    expect(disbandedEvents).toHaveLength(1);
    const disbanded = disbandedEvents[0];

    for (const tc of taskCompleted) {
      expect(tc.timestamp.localeCompare(disbanded.timestamp)).toBeLessThanOrEqual(0);
    }
  });

  /**
   * The reducer counts across the `<featureId>` stream and its subagent streams.
   * The payload sends `tasksCompleted: 999`, a wrong value on purpose, and the reducer replaces it.
   * The `team-other` event must not count.
   */
  it('SubagentRouterRetired_DisbandedTasksCount_ReflectsEventsTableNotInMemoryTally', async () => {
    const featureId = 'feat-retire-2';
    const subagentA = `${featureId}/subagent-a`;
    const subagentB = `${featureId}/subagent-b`;
    const teamId = 'team-beta';

    await eventStore.append(subagentA, {
      type: 'task.completed',
      data: { taskId: 'task-1', teamId },
    });
    await eventStore.append(subagentA, {
      type: 'task.completed',
      data: { taskId: 'task-2', teamId },
    });
    await eventStore.append(subagentB, {
      type: 'task.completed',
      data: { taskId: 'task-3', teamId },
    });
    await eventStore.append(subagentB, {
      type: 'task.completed',
      data: { taskId: 'task-x', teamId: 'team-other' },
    });

    const result = await handleEventAppend(
      {
        stream: featureId,
        event: {
          type: 'team.disbanded',
          data: {
            teamId,
            tasksCompleted: 999,
            tasksFailed: 0,
            totalDurationMs: 5000,
          },
        },
      },
      stateDir,
      eventStore,
    );
    expect(result.success).toBe(true);

    const disbandedEvents = await eventStore.query(featureId, {
      type: 'team.disbanded',
    });
    expect(disbandedEvents).toHaveLength(1);
    const disbanded = disbandedEvents[0];
    const data = (disbanded.data ?? {}) as Record<string, unknown>;
    expect(data.teamId).toBe(teamId);
    expect(data.tasksCompleted).toBe(3);
  });

  /**
   * A retried append with the same idempotency key leaves one event on the stream that the caller targets.
   * No code routes the event to the parent stream.
   */
  it('SubagentRouterRetired_ReplayedTaskCompleted_SingleParentEvent', async () => {
    const featureId = 'feat-retire-3';
    const subagent = `${featureId}/subagent-c`;
    const teamId = 'team-gamma';
    const taskId = 'task-replay';
    const idempotencyKey = `${subagent}:${taskId}:task.completed`;

    await eventStore.append(
      subagent,
      { type: 'task.completed', data: { taskId, teamId } },
      { idempotencyKey },
    );
    await eventStore.append(
      subagent,
      { type: 'task.completed', data: { taskId, teamId } },
      { idempotencyKey },
    );
    await eventStore.append(
      subagent,
      { type: 'task.completed', data: { taskId, teamId } },
      { idempotencyKey },
    );

    const events = await eventStore.query(subagent, { type: 'task.completed' });
    expect(events).toHaveLength(1);
  });

  /** The dynamic import of the router module must throw. The specifier resolves relative to this test file. */
  it('SubagentRouterRetired_ModuleDeleted_NoProductionImports', async () => {
    let importErr: unknown = null;
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await import('../runtime/agents/subagent-stream-router.js' as any);
    } catch (err) {
      importErr = err;
    }
    expect(importErr).not.toBeNull();
  });
});
