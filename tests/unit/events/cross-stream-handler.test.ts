import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { EventStore } from '../../../src/events/store.js';
import { handleEventAppend } from '../../../src/events/tools.js';
import { rmrfAsync } from '../../../tools/test-helpers/temp-dir.js';

/**
 * `handleEventAppend` is the emission site of `team.disbanded`. The repository has no team
 * coordinator module. When a caller appends `team.disbanded`, the handler must compute
 * `tasksCompleted` from the events table, not from derived state. It calls
 * `EventStore.queryByType` with a `streamPrefix` filter, so the count includes the subagent streams.
 */
describe('TeamCoordinator — disbanded emission queries events table (T26)', () => {
  let tempDir: string;
  let eventStore: EventStore;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), 'team-coordinator-t26-'));
    eventStore = new EventStore(tempDir);
  });

  afterEach(async () => {
    await rmrfAsync(tempDir);
  });

  /**
   * The two `task.completed` events are on subagent streams, and the parent stream has none.
   * A scan of only the parent stream counts zero. The caller sends a wrong `tasksCompleted` on
   * purpose, and the handler must replace it with the count from the cross-stream query.
   */
  it('TeamCoordinator_DisbandedEmission_QueriesEventsNotDerivedState', async () => {
    const featureId = 'feat-t26-1';
    const subagentA = `${featureId}/subagent-a`;
    const subagentB = `${featureId}/subagent-b`;
    const teamId = 'team-t26';

    await eventStore.append(subagentA, {
      type: 'task.completed',
      data: { taskId: 'a-1', teamId },
    });
    await eventStore.append(subagentB, {
      type: 'task.completed',
      data: { taskId: 'b-1', teamId },
    });

    const spy = vi.spyOn(eventStore, 'queryByType');

    const result = await handleEventAppend(
      {
        stream: featureId,
        event: {
          type: 'team.disbanded',
          data: {
            teamId,
            tasksCompleted: 999,
            tasksFailed: 0,
            totalDurationMs: 1234,
          },
        },
      },
      tempDir,
      eventStore,
    );

    expect(result.success).toBe(true);
    expect(spy).toHaveBeenCalled();
    const call = spy.mock.calls.find(
      (c) => c[0] === 'task.completed' && (c[1] as { streamPrefix?: string })?.streamPrefix === featureId,
    );
    expect(call).toBeDefined();

    const events = await eventStore.query(featureId, { type: 'team.disbanded' });
    expect(events).toHaveLength(1);
    const data = (events[0].data ?? {}) as Record<string, unknown>;
    expect(data.teamId).toBe(teamId);
    expect(data.tasksCompleted).toBe(2);
    expect(data.tasksFailed).toBe(0);
    expect(data.totalDurationMs).toBe(1234);
  });

  /** An event on the same prefix with a different `teamId` must not add to the count of this team. */
  it('TeamCoordinator_DisbandedEmission_ScopedByTeamId', async () => {
    const featureId = 'feat-t26-2';
    const subagentA = `${featureId}/subagent-a`;
    const teamA = 'team-alpha';
    const teamB = 'team-beta';

    await eventStore.append(subagentA, {
      type: 'task.completed',
      data: { taskId: 'a-1', teamId: teamA },
    });
    await eventStore.append(subagentA, {
      type: 'task.completed',
      data: { taskId: 'b-1', teamId: teamB },
    });

    const result = await handleEventAppend(
      {
        stream: featureId,
        event: {
          type: 'team.disbanded',
          data: {
            teamId: teamA,
            tasksCompleted: 99,
            tasksFailed: 0,
            totalDurationMs: 100,
          },
        },
      },
      tempDir,
      eventStore,
    );

    expect(result.success).toBe(true);
    const events = await eventStore.query(featureId, { type: 'team.disbanded' });
    expect(events).toHaveLength(1);
    const data = (events[0].data ?? {}) as Record<string, unknown>;
    expect(data.tasksCompleted).toBe(1);
  });
});
