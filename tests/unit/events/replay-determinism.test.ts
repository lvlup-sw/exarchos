/**
 * Replay determinism of `workflowStatusProjection` over the event-log shapes of four closed bugs.
 *
 * Each test builds one event log, folds it two times from a fresh `init()` state, and compares
 * the two states as JSON text. A difference shows that the projection is not deterministic.
 * Scenario 1 writes its log through the real `AtomicAppender` in a temporary directory.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  workflowStatusProjection,
  type WorkflowStatusViewState,
} from '../../../src/projections/views/workflow-status-view.js';
import type { WorkflowEvent } from '../../../src/events/schemas.js';
import { AtomicAppender } from '../../../src/events/atomic-appender.js';
import { rmrfAsync } from '../../../tools/test-helpers/temp-dir.js';

/**
 * Fold the events through the projection from a fresh `init()` state.
 * The fold does not use the `ViewMaterializer` cache, because a cache hit skips the fold.
 */
function project(events: readonly WorkflowEvent[]): WorkflowStatusViewState {
  let state = workflowStatusProjection.init();
  for (const evt of events) {
    state = workflowStatusProjection.apply(state, evt);
  }
  return state;
}

/**
 * Build a `WorkflowEvent` with schema version `1.0`.
 * The timestamp advances one second for each sequence number.
 */
function makeEvent(
  streamId: string,
  sequence: number,
  type: string,
  data: Record<string, unknown>,
  timestampMs = 1_700_000_000_000,
): WorkflowEvent {
  return {
    streamId,
    sequence,
    timestamp: new Date(timestampMs + sequence * 1000).toISOString(),
    type,
    data,
    schemaVersion: '1.0',
  } as WorkflowEvent;
}

describe('replay determinism (C9, #1109 verification)', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'replay-determinism-'));
  });

  afterEach(async () => {
    await rmrfAsync(tmpDir);
  });

  describe('replay_v29BugClusterScenarios_reconstructsIdenticalState', () => {
    /**
     * Concurrent appends through `AtomicAppender`. Three `append` calls on one stream have
     * different idempotency keys, so each call succeeds. The test reads the committed log one time
     * from the SQLite backend and folds it two times.
     */
    it('Scenario1_concurrentAppends_reproject_byteIdentical', async () => {
      const streamId = 'replay-scenario-1';
      const appender = new AtomicAppender({ stateDir: tmpDir });

      const results = await Promise.all([
        appender.append(streamId, [
          { type: 'workflow.started', data: { featureId: streamId, workflowType: 'feature' } },
        ], `${streamId}:k1`),
        appender.append(streamId, [
          { type: 'task.assigned', data: { taskId: 't1' } },
        ], `${streamId}:k2`),
        appender.append(streamId, [
          { type: 'task.completed', data: { taskId: 't1' } },
        ], `${streamId}:k3`),
      ]);
      for (const r of results) {
        expect(r.ok).toBe(true);
      }

      const backend = appender.getSqliteBackend();
      if (!backend) throw new Error('SQLite backend not initialized');
      const events = (await backend.queryEvents(streamId)) as WorkflowEvent[];

      const p1 = project(events);
      const p2 = project(events);
      expect(JSON.stringify(p2)).toBe(JSON.stringify(p1));
    });

    /**
     * Two checkpoints in one phase with different handoffs. The projection does not handle
     * `workflow.checkpoint`, so the events change no count.
     */
    it('Scenario2_refinementCheckpoints_reproject_byteIdentical', () => {
      const streamId = 'replay-scenario-2';
      const events: WorkflowEvent[] = [
        makeEvent(streamId, 1, 'workflow.started', { featureId: streamId, workflowType: 'feature' }),
        makeEvent(streamId, 2, 'workflow.checkpoint', {
          counter: 0,
          phase: 'started',
          featureId: streamId,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          handoff: { delivered: 'design-v1' } as any,
        }),
        makeEvent(streamId, 3, 'workflow.checkpoint', {
          counter: 0,
          phase: 'started',
          featureId: streamId,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          handoff: { delivered: 'design-v2' } as any,
        }),
      ];

      const p1 = project(events);
      const p2 = project(events);
      expect(JSON.stringify(p2)).toBe(JSON.stringify(p1));
    });

    /**
     * A second `task.completed` for the same `taskId`. The projection counts the task one time,
     * so `tasksCompleted` does not exceed `tasksTotal`.
     */
    it('Scenario3_duplicateTaskCompleted_reproject_byteIdentical', () => {
      const streamId = 'replay-scenario-3';
      const events: WorkflowEvent[] = [
        makeEvent(streamId, 1, 'workflow.started', { featureId: streamId, workflowType: 'feature' }),
        makeEvent(streamId, 2, 'task.assigned', { taskId: 't1' }),
        makeEvent(streamId, 3, 'task.completed', { taskId: 't1' }),
        makeEvent(streamId, 4, 'task.completed', { taskId: 't1' }),
      ];

      const p1 = project(events);
      const p2 = project(events);

      expect(JSON.stringify(p2)).toBe(JSON.stringify(p1));
      expect(p1.tasksCompleted).toBe(1);
      expect(p1.tasksTotal).toBe(1);
      expect(p1.tasksCompleted <= p1.tasksTotal).toBe(true);
    });

    /**
     * A historical log shape: `workflow.guard-failed` and then `workflow.transition` for the same
     * attempt. The test pins the determinism of the fold, not the atomicity of the guard.
     * The transition is the last event, so the phase is its `to` value.
     */
    it('Scenario4_failedThenPassedGuard_reproject_byteIdentical', () => {
      const streamId = 'replay-scenario-4';
      const events: WorkflowEvent[] = [
        makeEvent(streamId, 1, 'workflow.started', { featureId: streamId, workflowType: 'feature' }),
        makeEvent(streamId, 2, 'workflow.guard-failed', {
          featureId: streamId,
          from: 'delegate',
          to: 'review',
          reason: 'all-tasks-complete failed',
        }),
        makeEvent(streamId, 3, 'workflow.transition', {
          featureId: streamId,
          from: 'delegate',
          to: 'review',
          trigger: 'manual',
        }),
      ];

      const p1 = project(events);
      const p2 = project(events);
      expect(JSON.stringify(p2)).toBe(JSON.stringify(p1));
      expect(p1.phase).toBe('review');
    });

    /**
     * The four shapes in one log, with a duplicate `task.assigned` and a duplicate
     * `task.completed`. The two distinct tasks give a total of 2 and a completed count of 2. The
     * phase is the `to` value of the last transition.
     */
    it('CombinedScenario_allBugShapes_reproject_byteIdentical', () => {
      const streamId = 'replay-combined';
      const events: WorkflowEvent[] = [
        makeEvent(streamId, 1, 'workflow.started', { featureId: streamId, workflowType: 'feature' }),
        makeEvent(streamId, 2, 'task.assigned', { taskId: 'tA' }),
        makeEvent(streamId, 3, 'task.assigned', { taskId: 'tB' }),
        makeEvent(streamId, 4, 'task.assigned', { taskId: 'tA' }),
        makeEvent(streamId, 5, 'workflow.checkpoint', { counter: 0, phase: 'delegate', featureId: streamId }),
        makeEvent(streamId, 6, 'task.completed', { taskId: 'tA' }),
        makeEvent(streamId, 7, 'task.completed', { taskId: 'tA' }),
        makeEvent(streamId, 8, 'workflow.checkpoint', {
          counter: 0,
          phase: 'delegate',
          featureId: streamId,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          handoff: { delivered: 'wave-2-summary' } as any,
        }),
        makeEvent(streamId, 9, 'task.completed', { taskId: 'tB' }),
        makeEvent(streamId, 10, 'workflow.guard-failed', {
          featureId: streamId,
          from: 'delegate',
          to: 'review',
          reason: 'team-disbanded missing',
        }),
        makeEvent(streamId, 11, 'workflow.transition', {
          featureId: streamId,
          from: 'delegate',
          to: 'review',
          trigger: 'manual',
        }),
      ];

      const p1 = project(events);
      const p2 = project(events);
      expect(JSON.stringify(p2)).toBe(JSON.stringify(p1));

      expect(p1.tasksTotal).toBe(2);
      expect(p1.tasksCompleted).toBe(2);
      expect(p1.tasksCompleted <= p1.tasksTotal).toBe(true);
      expect(p1.phase).toBe('review');
    });
  });
});
