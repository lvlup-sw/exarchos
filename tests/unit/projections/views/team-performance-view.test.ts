import { describe, it, expect } from 'vitest';
import {
  teamPerformanceProjection,
  TEAM_PERFORMANCE_VIEW,
} from '../../../../src/projections/views/team-performance-view.js';
import type { TeamPerformanceViewState } from '../../../../src/projections/views/team-performance-view.js';
import type { WorkflowEvent } from '../../../../src/events/schemas.js';

const makeEvent = (type: string, data: Record<string, unknown>, seq = 1): WorkflowEvent => ({
  streamId: 'test',
  sequence: seq,
  timestamp: new Date().toISOString(),
  type: type as WorkflowEvent['type'],
  data,
  schemaVersion: '1.0',
});

describe('TeamPerformanceView', () => {
  describe('view name constant', () => {
    it('should export team_performance as view name', () => {
      expect(TEAM_PERFORMANCE_VIEW).toBe('team-performance');
    });
  });

  describe('init', () => {
    it('init_ReturnsEmptyState_NoTeammates', () => {
      const state = teamPerformanceProjection.init();
      expect(state.teammates).toEqual({});
      expect(state.modules).toEqual({});
      expect(state.teamSizing.avgTasksPerTeammate).toBe(0);
      expect(state.teamSizing.dataPoints).toBe(0);
    });
  });

  describe('apply - teammate metrics', () => {
    it('apply_TeamTaskCompleted_IncrementsTeammateTaskCount', () => {
      const state = teamPerformanceProjection.init();
      const event = makeEvent('team.task.completed', {
        taskId: 'task-1',
        teammateName: 'worker-1',
        durationMs: 3000,
        filesChanged: ['src/auth/login.ts'],
        testsPassed: true,
        qualityGateResults: {},
      });

      const next = teamPerformanceProjection.apply(state, event);
      expect(next.teammates['worker-1'].tasksCompleted).toBe(1);
    });

    it('apply_TeamTaskCompleted_UpdatesAvgDuration', () => {
      let state = teamPerformanceProjection.init();

      const event1 = makeEvent('team.task.completed', {
        taskId: 'task-1',
        teammateName: 'worker-1',
        durationMs: 4000,
        filesChanged: ['src/auth/login.ts'],
        testsPassed: true,
        qualityGateResults: {},
      }, 1);

      const event2 = makeEvent('team.task.completed', {
        taskId: 'task-2',
        teammateName: 'worker-1',
        durationMs: 6000,
        filesChanged: ['src/auth/signup.ts'],
        testsPassed: true,
        qualityGateResults: {},
      }, 2);

      state = teamPerformanceProjection.apply(state, event1);
      state = teamPerformanceProjection.apply(state, event2);

      expect(state.teammates['worker-1'].avgDurationMs).toBe(5000);
    });

    it('apply_TeamTaskCompleted_TracksModuleExpertise', () => {
      const state = teamPerformanceProjection.init();
      const event = makeEvent('team.task.completed', {
        taskId: 'task-1',
        teammateName: 'worker-1',
        durationMs: 3000,
        filesChanged: ['src/auth/login.ts', 'src/api/routes.ts'],
        testsPassed: true,
        qualityGateResults: {},
      });

      const next = teamPerformanceProjection.apply(state, event);
      expect(next.teammates['worker-1'].moduleExpertise).toContain('auth');
      expect(next.teammates['worker-1'].moduleExpertise).toContain('api');
    });

    it('apply_TeamTaskFailed_IncrementsFailCount', () => {
      const state = teamPerformanceProjection.init();
      const event = makeEvent('team.task.failed', {
        taskId: 'task-1',
        teammateName: 'worker-1',
        failureReason: 'tests failed',
        gateResults: {},
      });

      const next = teamPerformanceProjection.apply(state, event);
      expect(next.teammates['worker-1'].tasksFailed).toBe(1);
    });

    it('apply_TeamTaskCompleted_CalculatesPassRate', () => {
      let state = teamPerformanceProjection.init();

      for (let i = 1; i <= 3; i++) {
        state = teamPerformanceProjection.apply(state, makeEvent('team.task.completed', {
          taskId: `task-${i}`,
          teammateName: 'worker-1',
          durationMs: 3000,
          filesChanged: ['src/auth/login.ts'],
          testsPassed: true,
          qualityGateResults: {},
        }, i));
      }

      state = teamPerformanceProjection.apply(state, makeEvent('team.task.failed', {
        taskId: 'task-4',
        teammateName: 'worker-1',
        failureReason: 'tests failed',
        gateResults: {},
      }, 4));

      expect(state.teammates['worker-1'].qualityGatePassRate).toBe(0.75);
    });
  });

  describe('apply - module metrics', () => {
    /** Two files in one directory count the `auth` module one time. */
    it('apply_TeamTaskCompleted_DeduplicatesModulesFromSameDirectory', () => {
      const state = teamPerformanceProjection.init();
      const event = makeEvent('team.task.completed', {
        taskId: 'task-1',
        teammateName: 'worker-1',
        durationMs: 3000,
        filesChanged: ['src/auth/login.ts', 'src/auth/signup.ts'],
        testsPassed: true,
        qualityGateResults: {},
      });

      const next = teamPerformanceProjection.apply(state, event);
      expect(next.modules['auth'].totalTasks).toBe(1);
    });

    it('apply_TeamTaskCompleted_TracksModuleDuration', () => {
      let state = teamPerformanceProjection.init();

      state = teamPerformanceProjection.apply(state, makeEvent('team.task.completed', {
        taskId: 'task-1',
        teammateName: 'worker-1',
        durationMs: 4000,
        filesChanged: ['src/auth/login.ts'],
        testsPassed: true,
        qualityGateResults: {},
      }, 1));

      state = teamPerformanceProjection.apply(state, makeEvent('team.task.completed', {
        taskId: 'task-2',
        teammateName: 'worker-2',
        durationMs: 6000,
        filesChanged: ['src/auth/signup.ts'],
        testsPassed: true,
        qualityGateResults: {},
      }, 2));

      expect(state.modules['auth'].avgTaskDurationMs).toBe(5000);
      expect(state.modules['auth'].totalTasks).toBe(2);
    });

    /** The completed task comes first, so the module has a `totalTasks` above zero. */
    it('apply_WorkflowFixCycle_IncrementsModuleFixCycleRate', () => {
      let state = teamPerformanceProjection.init();

      state = teamPerformanceProjection.apply(state, makeEvent('team.task.completed', {
        taskId: 'task-1',
        teammateName: 'worker-1',
        durationMs: 3000,
        filesChanged: ['src/auth/login.ts'],
        testsPassed: true,
        qualityGateResults: {},
      }, 1));

      state = teamPerformanceProjection.apply(state, makeEvent('workflow.fix-cycle', {
        compoundStateId: 'auth-review',
        count: 1,
        featureId: 'test',
      }, 2));

      expect(state.modules['auth'].fixCycleRate).toBeGreaterThan(0);
      expect(state.modules['auth'].fixCycleCount).toBe(1);
    });
  });

  describe('apply - team sizing', () => {
    it('apply_TeamSpawned_UpdatesTeamSizingDataPoints', () => {
      let state = teamPerformanceProjection.init();

      state = teamPerformanceProjection.apply(state, makeEvent('team.spawned', {
        teamSize: 3,
        teammateNames: ['w1', 'w2', 'w3'],
        taskCount: 6,
        dispatchMode: 'parallel',
      }, 1));

      expect(state.teamSizing.dataPoints).toBe(1);
    });

    it('apply_TeamDisbanded_CalculatesAvgTasksPerTeammate', () => {
      let state = teamPerformanceProjection.init();

      state = teamPerformanceProjection.apply(state, makeEvent('team.spawned', {
        teamSize: 3,
        teammateNames: ['w1', 'w2', 'w3'],
        taskCount: 6,
        dispatchMode: 'parallel',
      }, 1));

      state = teamPerformanceProjection.apply(state, makeEvent('team.disbanded', {
        totalDurationMs: 10000,
        tasksCompleted: 5,
        tasksFailed: 1,
      }, 2));

      expect(state.teamSizing.avgTasksPerTeammate).toBe(2);
    });
  });

  describe('apply - subagent.tokens_used', () => {
    it('TeamPerformance_FoldsTokenAtom_AttributesTokensToTeammate', () => {
      let state = teamPerformanceProjection.init();
      state = teamPerformanceProjection.apply(state, makeEvent('subagent.tokens_used', {
        agentId: 'a1', teammateName: 'alice', outputTokens: 1000, taskId: 'T-1',
      }, 1));
      state = teamPerformanceProjection.apply(state, makeEvent('subagent.tokens_used', {
        agentId: 'a2', teammateName: 'alice', outputTokens: 3000, taskId: 'T-2',
      }, 2));

      const alice = state.teammates['alice'];
      expect(alice).toBeDefined();
      expect(alice.totalOutputTokens).toBe(4000);
      expect(alice.subagentRuns).toBe(2);
      expect(alice.avgOutputTokensPerRun).toBe(2000);
    });

    /** `team.task.completed` rebuilds the teammate object, and must carry the token fields forward. */
    it('TeamPerformance_TokenAtom_SurvivesSubsequentTaskCompleted', () => {
      let state = teamPerformanceProjection.init();
      state = teamPerformanceProjection.apply(state, makeEvent('subagent.tokens_used', {
        agentId: 'a1', teammateName: 'bob', outputTokens: 500,
      }, 1));
      state = teamPerformanceProjection.apply(state, makeEvent('team.task.completed', {
        taskId: 'T-1', teammateName: 'bob', durationMs: 100,
        filesChanged: ['src/x.ts'], testsPassed: true, qualityGateResults: {},
      }, 2));

      expect(state.teammates['bob'].totalOutputTokens).toBe(500);
      expect(state.teammates['bob'].tasksCompleted).toBe(1);
    });

    /**
     * An event with no `teammateName` leaves the view unchanged. An event with no numeric
     * `outputTokens` creates no teammate.
     */
    it('TeamPerformance_TokenAtom_IgnoresMissingTeammateOrTokens', () => {
      let state = teamPerformanceProjection.init();
      const before = state;
      state = teamPerformanceProjection.apply(state, makeEvent('subagent.tokens_used', {
        agentId: 'a1', outputTokens: 100,
      }, 1));
      expect(state).toBe(before);
      state = teamPerformanceProjection.apply(state, makeEvent('subagent.tokens_used', {
        agentId: 'a1', teammateName: 'x',
      }, 2));
      expect(state.teammates['x']).toBeUndefined();
    });
  });
});
