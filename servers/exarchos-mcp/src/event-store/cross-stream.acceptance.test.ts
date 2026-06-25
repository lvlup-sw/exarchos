import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { EventStore } from './store.js';
import { handleEventAppend } from './tools.js';
import { rmrfAsync } from '../test-helpers/temp-dir.js';

/**
 * T23 — ACCEPTANCE test for DR-3 (cross-stream propagation).
 *
 * Two subagents run in (logically) separate worktrees and append
 * `task.completed` events to namespaced child streams of the form
 * `<feature-id>/<subagent-id>`. The parent team coordinator emits
 * `team.disbanded` to the parent feature stream. The acceptance criterion
 * is that the persisted `team.disbanded` event's `tasksCompleted` count
 * is computed by reducing over the events table — querying every stream
 * matching the namespaced prefix — and exactly matches the number of
 * `task.completed` events the two subagents appended.
 *
 * This test stays RED until T24 (namespaced stream-id validator), T25
 * (`streamPrefix` filter on `EventStore.queryByType`), T26 (handler routes
 * `team.disbanded` through the cross-stream query), and T27 (router
 * removed/thinned) are GREEN. T28 mirrors this fixture as the bundle test.
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

  it('CrossStream_TwoSubagentsAppend_ParentTeamDisbandedReflectsBothCompletions', async () => {
    const featureId = 'feat-cross-stream-1';
    const subagentA = `${featureId}/subagent-a`;
    const subagentB = `${featureId}/subagent-b`;
    const teamId = 'team-cross-stream-1';

    // Concurrent appends to two namespaced child streams. AtomicAppender
    // serializes per-stream, but the two streams write in parallel.
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

    // Parent stream emits team.disbanded — the handler must reduce over the
    // events table (every stream whose ID matches `<featureId>` or
    // `<featureId>/*`) and recompute tasksCompleted from the actual
    // task.completed events for this team.
    const result = await handleEventAppend(
      {
        stream: featureId,
        event: {
          type: 'team.disbanded',
          data: {
            teamId,
            // Caller-supplied tally is intentionally wrong — the cross-stream
            // query reducer must override it with the canonical count.
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

    // The parent stream must contain exactly one team.disbanded with
    // tasksCompleted === 2 (one from each subagent).
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
