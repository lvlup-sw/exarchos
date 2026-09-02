import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { EventStore } from '../../../src/events/store.js';
import { handleEventAppend } from '../../../src/events/tools.js';
import { rmrfAsync } from '../../../tools/test-helpers/temp-dir.js';

/**
 * T28 — Bundle test for DR-3 cross-stream propagation.
 *
 * Mirrors the T23 acceptance fixture with the full happy path: two subagents
 * append `task.completed` events concurrently to namespaced streams of the
 * form `<feature-id>/<subagent-id>`, the parent feature stream emits
 * `team.disbanded`, and the persisted event's `tasksCompleted` reflects
 * exactly the count produced by reducing over the events table — no
 * derived state, no JSONL-only scan of the parent stream.
 *
 * This bundle test exercises:
 *  - The namespaced stream-id validator (T24).
 *  - `EventStore.queryByType` with the `streamPrefix` filter (T25).
 *  - Handler-level cross-stream reduction at `team.disbanded` (T26).
 *  - The retired SubagentStreamRouter path is fully gone (T27).
 *
 * Once T24-T27 are GREEN this test should pass without further work; if any
 * upstream regresses, this test surfaces the regression at the integration
 * boundary.
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

  it('CrossStream_TwoSubagentsAppend_ParentDisbandedReflectsBoth_Bundle', async () => {
    const featureId = 'feat-bundle-1';
    const subA = `${featureId}/subagent-a`;
    const subB = `${featureId}/subagent-b`;
    const teamId = 'team-bundle';

    // Concurrent appends — each subagent stream serializes independently
    // so the two writes can interleave. The cross-stream query reducer
    // must see both regardless of interleave order.
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

    // Parent emits team.disbanded with a deliberately-wrong tasksCompleted
    // — the cross-stream reducer must override it with the canonical count
    // (2: one task.completed per subagent stream, both scoped to teamId).
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

    // Verify by reading from the parent stream via the durable substrate
    // (post v2.11 substrate-cut: SQLite is the source of truth, the JSONL
    // sidecar inspection that lived here previously is gone).
    const events = await eventStore.query(featureId);
    const disbanded = events.find((e) => e.type === 'team.disbanded');
    expect(disbanded).toBeDefined();
    const data = (disbanded!.data ?? {}) as Record<string, unknown>;
    expect(data.teamId).toBe(teamId);
    expect(data.tasksCompleted).toBe(2);
    expect(data.tasksFailed).toBe(0);
    expect(data.totalDurationMs).toBe(7777);
  });

  it('CrossStream_NamespacedStreamsCoexistWithFlatStreams_Bundle', async () => {
    // Bundle pin: a flat-id stream (legacy single-segment form) on the
    // same EventStore must NOT pollute the cross-stream count for an
    // unrelated namespaced feature. Coverage for the structural prefix
    // filter — `feat-bundle-2` is NOT a descendant of `feat-bundle-2-extra`
    // and vice versa.
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
    // Only `feat-bundle-2/subagent-a` matches; the lookalike flat stream
    // doesn't share the namespaced prefix structure and stays out.
    expect(data.tasksCompleted).toBe(1);
  });
});
