import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { EventStore } from './store.js';
import { handleEventAppend } from './tools.js';
import { rmrfAsync } from '../test-helpers/temp-dir.js';

/**
 * T27 — SubagentStreamRouter retirement: regression-pin tests.
 *
 * The v2.9 `SubagentStreamRouter` primitive (`agents/subagent-stream-router.ts`)
 * fixed the #1224 off-by-N regression by routing both `task.completed` and
 * `team.disbanded` writes through the parent stream's appender and computing
 * `tasksCompleted` from a JSONL scan of the parent stream. DR-3 supersedes
 * that primitive: subagent streams are now namespaced as
 * `<feature-id>/<subagent-id>` and `team.disbanded.tasksCompleted` is computed
 * by reducing over the events table via `EventStore.queryByType` with
 * `streamPrefix: <feature-id>` (T26).
 *
 * The router module is removed (no remaining production callers after T26).
 * This file replaces the original `agents/subagent-stream-router.test.ts` —
 * the same observable behaviours are pinned here against the new path:
 *
 *   1. `task.completed` events on subagent streams cause-precede `team.disbanded`
 *      on the parent stream by global timestamp ordering.
 *   2. `team.disbanded.tasksCompleted` reflects the events-table count for
 *      the team, not any in-memory tally; events for unrelated teams don't bleed.
 *   3. Replayed `task.completed` events with the same idempotency key produce
 *      a single persisted event (delegated to AtomicAppender's idempotency
 *      cache via the standard append path).
 *
 * Co-located here (under `event-store/`) because the new owner of these
 * observables is the cross-stream query reducer, not a standalone router
 * primitive. The original `agents/subagent-stream-router.test.ts` is
 * removed in the same commit.
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
    // Was: SubagentStreamRouter_onTaskCompleted_emittedBeforeDisbanded.
    // Reformulation: subagent task.completed events appear earlier in the
    // global timestamp ordering than the parent's team.disbanded.
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

    // Every task.completed timestamp precedes (or equals) the team.disbanded
    // timestamp — same observable the old test asserted via per-stream
    // sequence ordering, generalized to the cross-stream namespace.
    for (const tc of taskCompleted) {
      expect(tc.timestamp.localeCompare(disbanded.timestamp)).toBeLessThanOrEqual(0);
    }
  });

  it('SubagentRouterRetired_DisbandedTasksCount_ReflectsEventsTableNotInMemoryTally', async () => {
    // Was: SubagentStreamRouter_disbandedTasksCount_reflectsParentStreamNotInMemoryTally.
    // The replacement reducer queries across `<featureId>/*` AND `<featureId>`
    // itself — the old router only saw the parent stream because it routed
    // every task.completed onto the parent. Either way, the persisted
    // `team.disbanded.tasksCompleted` must reflect the events table.
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
    // Unrelated team — must NOT bleed into the count.
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
            tasksCompleted: 999, // wrong on purpose; reducer overrides
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

  it('SubagentRouterRetired_ReplayedTaskCompleted_SingleParentEvent', async () => {
    // Was: SubagentStreamRouter_replayedTaskCompleted_singleParentEvent.
    // Idempotency now lives in AtomicAppender's commit-on-success cache;
    // a retried append with the same idempotency key produces a single
    // persisted event on the SAME stream the caller targets (no parent
    // re-routing — that was the router's responsibility).
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

  it('SubagentRouterRetired_ModuleDeleted_NoProductionImports', async () => {
    // Pin: importing the deleted router module fails at module load.
    // This catches accidental re-introduction of the primitive — any new
    // production caller would surface here as a build/import-time error,
    // not a silent regression.
    let importErr: unknown = null;
    try {
      // The module was removed in T27 GREEN. Importing it must throw
      // (ERR_MODULE_NOT_FOUND); if a future commit reintroduces the file,
      // this assertion will flip and the author can decide whether the
      // re-introduction is intentional.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await import('../agents/subagent-stream-router.js' as any);
    } catch (err) {
      importErr = err;
    }
    expect(importErr).not.toBeNull();
  });
});
