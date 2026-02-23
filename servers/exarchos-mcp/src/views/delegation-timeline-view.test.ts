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
      expect(DELEGATION_TIMELINE_VIEW).toBe('delegation-timeline');
    });
  });

  describe('init', () => {
    it('init_ReturnsEmptyState_NoTasks', () => {
      const state = delegationTimelineProjection.init();
      expect(state).toEqual({
        teamSpawnedAt: null,
        teamDisbandedAt: null,
        totalDurationMs: 0,
        tasks: [],
        bottleneck: null,
        hasMore: false,
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

    // ─── T18: Cap delegation timeline tasks array ──────────────────────

    it('Apply_TeamTaskAssigned_ExceedsMaxTasks_EvictsOldest', () => {
      let state = delegationTimelineProjection.init();

      // Assign 210 tasks (exceeds MAX_TIMELINE_TASKS = 200)
      for (let i = 0; i < 210; i++) {
        state = delegationTimelineProjection.apply(
          state,
          makeEvent('team.task.assigned', {
            taskId: `task-${i}`,
            teammateName: `worker-${i}`,
            worktreePath: `/tmp/wt-${i}`,
            modules: ['auth'],
          }, i + 1),
        );
      }

      // Should be capped at 200
      expect(state.tasks).toHaveLength(200);
      // Oldest (task-0 through task-9) should be evicted
      expect(state.tasks[0].taskId).toBe('task-10');
      expect(state.tasks[199].taskId).toBe('task-209');
    });

    // ─── T20: hasMore indicator for delegation timeline ──────────────

    it('ViewState_HasEvicted_HasMoreIsTrue', () => {
      let state = delegationTimelineProjection.init();

      // Under the limit — no eviction
      for (let i = 0; i < 200; i++) {
        state = delegationTimelineProjection.apply(
          state,
          makeEvent('team.task.assigned', {
            taskId: `task-${i}`,
            teammateName: `worker-${i}`,
            worktreePath: `/tmp/wt-${i}`,
            modules: ['auth'],
          }, i + 1),
        );
      }
      expect(state.hasMore).toBe(false);

      // One more pushes over the limit
      state = delegationTimelineProjection.apply(
        state,
        makeEvent('team.task.assigned', {
          taskId: 'task-200',
          teammateName: 'worker-200',
          worktreePath: '/tmp/wt-200',
          modules: ['auth'],
        }, 201),
      );
      expect(state.hasMore).toBe(true);
      expect(state.tasks).toHaveLength(200);
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

    it('Apply_TeamTaskAssigned_InvalidSchema_ReturnsViewUnchanged', () => {
      const state = delegationTimelineProjection.init();
      // Missing worktreePath and modules — should fail schema validation
      const event = makeEvent('team.task.assigned', {
        taskId: 'task-1',
        teammateName: 'worker-1',
      }, 1);

      const next = delegationTimelineProjection.apply(state, event);
      // With safeParse, incomplete data should be rejected
      expect(next.tasks).toHaveLength(0);
      expect(next).toEqual(state);
    });

    it('Apply_TeamTaskAssigned_FullSchema_CreatesTask', () => {
      const state = delegationTimelineProjection.init();
      const ts = '2026-02-22T10:00:00.000Z';
      const event = makeEvent('team.task.assigned', {
        taskId: 'task-1',
        teammateName: 'worker-1',
        worktreePath: '/path/to/.worktrees/wt-1',
        modules: ['src/foo.ts'],
      }, 1, ts);

      const next = delegationTimelineProjection.apply(state, event);
      expect(next.tasks).toHaveLength(1);
      expect(next.tasks[0].taskId).toBe('task-1');
      expect(next.tasks[0].teammateName).toBe('worker-1');
      expect(next.tasks[0].status).toBe('assigned');
      expect(next.tasks[0].assignedAt).toBe(ts);
    });

    it('Apply_TaskEviction_BottleneckEvicted_BottleneckResetToNull', () => {
      let state = delegationTimelineProjection.init();

      // Assign and complete task-0 so it becomes the bottleneck (long duration)
      state = delegationTimelineProjection.apply(
        state,
        makeEvent('team.task.assigned', {
          taskId: 'task-0',
          teammateName: 'worker-0',
          worktreePath: '/tmp/wt-0',
          modules: ['auth'],
        }, 1),
      );
      state = delegationTimelineProjection.apply(
        state,
        makeEvent('team.task.completed', {
          taskId: 'task-0',
          teammateName: 'worker-0',
          durationMs: 99999,
          filesChanged: [],
          testsPassed: true,
          qualityGateResults: {},
        }, 2),
      );

      // task-0 should now be the bottleneck
      expect(state.bottleneck?.taskId).toBe('task-0');

      // Assign tasks 1 through 209 — once we exceed MAX_TIMELINE_TASKS (200),
      // task-0 (the current bottleneck) will be evicted from the bounded array
      for (let i = 1; i <= 209; i++) {
        state = delegationTimelineProjection.apply(
          state,
          makeEvent('team.task.assigned', {
            taskId: `task-${i}`,
            teammateName: `worker-${i}`,
            worktreePath: `/tmp/wt-${i}`,
            modules: ['auth'],
          }, i + 2),
        );
      }

      // 210 total tasks assigned → capped at 200, task-0 through task-9 evicted
      expect(state.tasks).toHaveLength(200);
      expect(state.tasks[0].taskId).toBe('task-10');
      expect(state.hasMore).toBe(true);

      // bottleneck referenced task-0 which was evicted — must be reset to null
      expect(state.bottleneck).toBeNull();
    });
  });
});
