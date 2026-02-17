import { describe, it, expect } from 'vitest';
import {
  delegationTimelineProjection,
  DELEGATION_TIMELINE_VIEW,
} from './delegation-timeline-view.js';
import type { DelegationTimelineViewState } from './delegation-timeline-view.js';
import type { WorkflowEvent } from '../event-store/schemas.js';

const makeEvent = (
  type: string,
  data: Record<string, unknown>,
  seq = 1,
  timestamp?: string,
): WorkflowEvent => ({
  streamId: 'test',
  sequence: seq,
  timestamp: timestamp ?? new Date().toISOString(),
  type: type as WorkflowEvent['type'],
  data,
  schemaVersion: '1.0',
});

describe('DelegationTimelineView', () => {
  describe('view name constant', () => {
    it('should export delegation_timeline as view name', () => {
      expect(DELEGATION_TIMELINE_VIEW).toBe('delegation_timeline');
    });
  });

  describe('init', () => {
    it('init_ReturnsEmptyState_NoTasks', () => {
      const state = delegationTimelineProjection.init();
      expect(state).toEqual({
        featureId: '',
        teamSpawnedAt: null,
        teamDisbandedAt: null,
        totalDurationMs: 0,
        tasks: [],
        bottleneck: null,
      });
    });
  });

  describe('apply', () => {
    it('apply_TeamSpawned_SetsSpawnTimestamp', () => {
      const state = delegationTimelineProjection.init();
      const ts = '2026-02-16T10:00:00.000Z';
      const event = makeEvent('team.spawned', {
        teamSize: 3,
        teammateNames: ['w1', 'w2', 'w3'],
        taskCount: 6,
        dispatchMode: 'parallel',
      }, 1, ts);

      const next = delegationTimelineProjection.apply(state, event);
      expect(next.teamSpawnedAt).toBe(ts);
    });

    it('apply_TeamTaskAssigned_AddsTaskEntry', () => {
      const state = delegationTimelineProjection.init();
      const ts = '2026-02-16T10:00:00.000Z';
      const event = makeEvent('team.task.assigned', {
        taskId: 'task-1',
        teammateName: 'worker-1',
        worktreePath: '/tmp/worktree',
        modules: ['auth'],
      }, 1, ts);

      const next = delegationTimelineProjection.apply(state, event);
      expect(next.tasks).toHaveLength(1);
      expect(next.tasks[0].taskId).toBe('task-1');
      expect(next.tasks[0].teammateName).toBe('worker-1');
      expect(next.tasks[0].status).toBe('assigned');
      expect(next.tasks[0].assignedAt).toBe(ts);
    });

    it('apply_TeamTaskCompleted_UpdatesTaskStatus', () => {
      let state = delegationTimelineProjection.init();
      const assignTs = '2026-02-16T10:00:00.000Z';
      const completeTs = '2026-02-16T10:05:00.000Z';

      state = delegationTimelineProjection.apply(state, makeEvent('team.task.assigned', {
        taskId: 'task-1',
        teammateName: 'worker-1',
        worktreePath: '/tmp/worktree',
        modules: ['auth'],
      }, 1, assignTs));

      state = delegationTimelineProjection.apply(state, makeEvent('team.task.completed', {
        taskId: 'task-1',
        teammateName: 'worker-1',
        durationMs: 300000,
        filesChanged: ['src/auth/login.ts'],
        testsPassed: true,
        qualityGateResults: {},
      }, 2, completeTs));

      expect(state.tasks[0].status).toBe('completed');
      expect(state.tasks[0].completedAt).toBe(completeTs);
      expect(state.tasks[0].durationMs).toBe(300000);
    });

    it('apply_TeamTaskFailed_UpdatesTaskStatus', () => {
      let state = delegationTimelineProjection.init();
      const assignTs = '2026-02-16T10:00:00.000Z';
      const failTs = '2026-02-16T10:03:00.000Z';

      state = delegationTimelineProjection.apply(state, makeEvent('team.task.assigned', {
        taskId: 'task-1',
        teammateName: 'worker-1',
        worktreePath: '/tmp/worktree',
        modules: ['auth'],
      }, 1, assignTs));

      state = delegationTimelineProjection.apply(state, makeEvent('team.task.failed', {
        taskId: 'task-1',
        teammateName: 'worker-1',
        failureReason: 'tests failed',
        gateResults: {},
      }, 2, failTs));

      expect(state.tasks[0].status).toBe('failed');
      expect(state.tasks[0].completedAt).toBe(failTs);
    });

    it('apply_TeamDisbanded_CalculatesTotalDuration', () => {
      let state = delegationTimelineProjection.init();
      const spawnTs = '2026-02-16T10:00:00.000Z';
      const disbandTs = '2026-02-16T10:10:00.000Z';

      state = delegationTimelineProjection.apply(state, makeEvent('team.spawned', {
        teamSize: 3,
        teammateNames: ['w1', 'w2', 'w3'],
        taskCount: 6,
        dispatchMode: 'parallel',
      }, 1, spawnTs));

      state = delegationTimelineProjection.apply(state, makeEvent('team.disbanded', {
        totalDurationMs: 600000,
        tasksCompleted: 5,
        tasksFailed: 1,
      }, 2, disbandTs));

      expect(state.teamDisbandedAt).toBe(disbandTs);
      expect(state.totalDurationMs).toBe(600000);
    });

    it('apply_MultipleCompleted_IdentifiesBottleneck', () => {
      let state = delegationTimelineProjection.init();

      // Assign 3 tasks
      const tasks = [
        { taskId: 'task-1', duration: 1000 },
        { taskId: 'task-2', duration: 5000 },
        { taskId: 'task-3', duration: 2000 },
      ];

      let seq = 1;
      for (const t of tasks) {
        state = delegationTimelineProjection.apply(state, makeEvent('team.task.assigned', {
          taskId: t.taskId,
          teammateName: `worker-${seq}`,
          worktreePath: `/tmp/wt-${seq}`,
          modules: ['auth'],
        }, seq));
        seq++;
      }

      // Complete all 3 tasks with varying durations
      for (const t of tasks) {
        state = delegationTimelineProjection.apply(state, makeEvent('team.task.completed', {
          taskId: t.taskId,
          teammateName: `worker-${seq - 3}`,
          durationMs: t.duration,
          filesChanged: ['src/auth/login.ts'],
          testsPassed: true,
          qualityGateResults: {},
        }, seq));
        seq++;
      }

      expect(state.bottleneck).not.toBeNull();
      expect(state.bottleneck!.taskId).toBe('task-2');
      expect(state.bottleneck!.durationMs).toBe(5000);
      expect(state.bottleneck!.reason).toBe('longest_task');
    });
  });
});
