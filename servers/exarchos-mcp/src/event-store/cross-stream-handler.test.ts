import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { EventStore } from './store.js';
import { handleEventAppend } from './tools.js';
import { rmrfAsync } from '../test-helpers/temp-dir.js';

/**
 * T26 — `team.disbanded` emission queries the events table (not derived state).
 *
 * The plan specified this test under `src/team/coordinator.test.ts`. There is
 * no `team/` directory in the repo today; the actual `team.disbanded`
 * emission site is `event-store/tools.ts::handleEventAppend` (the C11
 * router-interception path landed in v2.9). The contract tested here is
 * identical to what a future coordinator module would assert: when a caller
 * appends `team.disbanded`, the handler MUST recompute `tasksCompleted` by
 * reducing over the events table via `EventStore.queryByType` with a
 * `streamPrefix` filter — never from in-memory derived state and never from
 * a single-stream JSONL scan that would miss subagent streams.
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

  it('TeamCoordinator_DisbandedEmission_QueriesEventsNotDerivedState', async () => {
    const featureId = 'feat-t26-1';
    const subagentA = `${featureId}/subagent-a`;
    const subagentB = `${featureId}/subagent-b`;
    const teamId = 'team-t26';

    // Two task.completed events on subagent streams; the parent feature
    // stream has none. A JSONL-scan-only emission path (the legacy router)
    // would see zero `task.completed` for the team and emit `tasksCompleted: 0`.
    // Reducing over the events table via the streamPrefix filter sees both.
    await eventStore.append(subagentA, {
      type: 'task.completed',
      data: { taskId: 'a-1', teamId },
    });
    await eventStore.append(subagentB, {
      type: 'task.completed',
      data: { taskId: 'b-1', teamId },
    });

    // Spy on `queryByType` — the emission MUST call it with the right
    // prefix and event type. This pins the contract: the handler reduces
    // over the cross-stream query, not over derived state.
    const spy = vi.spyOn(eventStore, 'queryByType');

    const result = await handleEventAppend(
      {
        stream: featureId,
        event: {
          type: 'team.disbanded',
          data: {
            teamId,
            // Caller-supplied tally is wrong on purpose — the cross-stream
            // reducer must override it. The legacy router-only path
            // returned 0 here (no task.completed on the parent stream).
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
    const data = (events[0]!.data ?? {}) as Record<string, unknown>;
    expect(data.teamId).toBe(teamId);
    // Two task.completed events span the two subagent streams; the
    // cross-stream query reducer recovers both.
    expect(data.tasksCompleted).toBe(2);
    expect(data.tasksFailed).toBe(0);
    expect(data.totalDurationMs).toBe(1234);
  });

  it('TeamCoordinator_DisbandedEmission_ScopedByTeamId', async () => {
    // Cross-team isolation: events on the same prefix but a different teamId
    // must NOT bleed into this team's count.
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
    const data = (events[0]!.data ?? {}) as Record<string, unknown>;
    expect(data.tasksCompleted).toBe(1); // only teamA's task.completed counts
  });
});
