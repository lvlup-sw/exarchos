import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { EventStore } from '../../../src/events/store.js';
import { handleEventAppend } from '../../../src/events/tools.js';
import { rmrfAsync } from '../../../tools/test-helpers/temp-dir.js';

/**
 * Acceptance test for cross-stream propagation. Two subagents append `task.completed` events
 * to child streams named `<feature-id>/<subagent-id>`. The parent feature stream then receives
 * `team.disbanded`. The persisted `tasksCompleted` must equal the number of `task.completed`
 * events that the two subagents appended. `cross-stream.bundle.test.ts` uses the same fixture.
 */
describe('CrossStream acceptance (DR-3, T23)', () => {
  let tempDir: string;
  let eventStore: EventStore;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), 'cross-stream-acceptance-'));
    eventStore = new EventStore(tempDir);
  });

  afterEach(async () => {
    await rmrfAsync(tempDir);
  });

  /**
   * The two child streams write in parallel, and the appender serializes each stream.
   * The caller sends a wrong `tasksCompleted` on purpose. The handler must replace it with the
   * count of the `task.completed` events of this team on the feature stream and its child streams.
   */
  it('CrossStream_TwoSubagentsAppend_ParentTeamDisbandedReflectsBothCompletions', async () => {
    const featureId = 'feat-cross-stream-1';
    const subagentA = `${featureId}/subagent-a`;
    const subagentB = `${featureId}/subagent-b`;
    const teamId = 'team-cross-stream-1';

    await Promise.all([
      handleEventAppend(
        {
          stream: subagentA,
          event: {
            type: 'task.completed',
            data: { taskId: 'task-a-1', teamId },
          },
        },
        tempDir,
        eventStore,
      ),
      handleEventAppend(
        {
          stream: subagentB,
          event: {
            type: 'task.completed',
            data: { taskId: 'task-b-1', teamId },
          },
        },
        tempDir,
        eventStore,
      ),
    ]);

    const result = await handleEventAppend(
      {
        stream: featureId,
        event: {
          type: 'team.disbanded',
          data: {
            teamId,
            tasksCompleted: 0,
            tasksFailed: 0,
            totalDurationMs: 1000,
          },
        },
      },
      tempDir,
      eventStore,
    );

    expect(result.success).toBe(true);

    const parentEvents = await eventStore.query(featureId, {
      type: 'team.disbanded',
    });
    expect(parentEvents).toHaveLength(1);
    const disbanded = parentEvents[0];
    const data = (disbanded.data ?? {}) as Record<string, unknown>;
    expect(data.teamId).toBe(teamId);
    expect(data.tasksCompleted).toBe(2);
    expect(data.tasksFailed).toBe(0);
    expect(data.totalDurationMs).toBe(1000);
  });
});
