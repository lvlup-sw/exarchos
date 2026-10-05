import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { EventStore } from '../../../src/events/store.js';
import { handleEventAppend } from '../../../src/events/tools.js';
import { rmrfAsync } from '../../../tools/test-helpers/temp-dir.js';

/**
 * Bundle test for cross-stream propagation, on the fixture of `cross-stream.acceptance.test.ts`.
 * One path exercises the namespaced stream-id validator, `EventStore.queryByType` with the
 * `streamPrefix` filter, and the cross-stream count in the `team.disbanded` handler.
 * A regression in one of the three fails here, at the integration boundary.
 */
describe('CrossStream bundle (DR-3, T28)', () => {
  let stateDir: string;
  let eventStore: EventStore;

  beforeEach(async () => {
    stateDir = await mkdtemp(path.join(tmpdir(), 'cross-stream-bundle-'));
    eventStore = new EventStore(stateDir);
  });

  afterEach(async () => {
    await rmrfAsync(stateDir);
  });

  /**
   * Each subagent stream serializes independently, so the two writes can interleave.
   * The caller sends a wrong `tasksCompleted` on purpose. The handler must replace it with 2:
   * one `task.completed` on each subagent stream, both for this team.
   */
  it('CrossStream_TwoSubagentsAppend_ParentDisbandedReflectsBoth_Bundle', async () => {
    const featureId = 'feat-bundle-1';
    const subA = `${featureId}/subagent-a`;
    const subB = `${featureId}/subagent-b`;
    const teamId = 'team-bundle';

    const appends = await Promise.all([
      handleEventAppend(
        {
          stream: subA,
          event: {
            type: 'task.completed',
            data: { taskId: 'task-a', teamId },
          },
        },
        stateDir,
        eventStore,
      ),
      handleEventAppend(
        {
          stream: subB,
          event: {
            type: 'task.completed',
            data: { taskId: 'task-b', teamId },
          },
        },
        stateDir,
        eventStore,
      ),
    ]);
    for (const result of appends) {
      expect(result.success).toBe(true);
    }

    const disbandedResult = await handleEventAppend(
      {
        stream: featureId,
        event: {
          type: 'team.disbanded',
          data: {
            teamId,
            tasksCompleted: 0,
            tasksFailed: 0,
            totalDurationMs: 7777,
          },
        },
      },
      stateDir,
      eventStore,
    );
    expect(disbandedResult.success).toBe(true);

    const events = await eventStore.query(featureId);
    const disbanded = events.find((e) => e.type === 'team.disbanded');
    expect(disbanded).toBeDefined();
    const data = (disbanded!.data ?? {}) as Record<string, unknown>;
    expect(data.teamId).toBe(teamId);
    expect(data.tasksCompleted).toBe(2);
    expect(data.tasksFailed).toBe(0);
    expect(data.totalDurationMs).toBe(7777);
  });

  /**
   * The flat stream `feat-bundle-2-extra` must not add to the count for `feat-bundle-2`.
   * The prefix filter is structural, so only `feat-bundle-2/subagent-a` is under the prefix.
   */
  it('CrossStream_NamespacedStreamsCoexistWithFlatStreams_Bundle', async () => {
    const featureId = 'feat-bundle-2';
    const subA = `${featureId}/subagent-a`;
    const lookalikeFlat = `${featureId}-extra`;
    const teamId = 'team-bundle-2';

    await eventStore.append(subA, {
      type: 'task.completed',
      data: { taskId: 'a-1', teamId },
    });
    await eventStore.append(lookalikeFlat, {
      type: 'task.completed',
      data: { taskId: 'lookalike', teamId },
    });

    const result = await handleEventAppend(
      {
        stream: featureId,
        event: {
          type: 'team.disbanded',
          data: {
            teamId,
            tasksCompleted: 0,
            tasksFailed: 0,
            totalDurationMs: 100,
          },
        },
      },
      stateDir,
      eventStore,
    );
    expect(result.success).toBe(true);

    const events = await eventStore.query(featureId, { type: 'team.disbanded' });
    expect(events).toHaveLength(1);
    const data = (events[0].data ?? {}) as Record<string, unknown>;
    expect(data.tasksCompleted).toBe(1);
  });
});
