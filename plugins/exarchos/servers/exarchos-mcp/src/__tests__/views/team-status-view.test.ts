import { describe, it, expect, beforeEach } from 'vitest';
import { ViewMaterializer } from '../../views/materializer.js';
import {
  teamStatusProjection,
  TEAM_STATUS_VIEW,
} from '../../views/team-status-view.js';
import type { TeamStatusViewState } from '../../views/team-status-view.js';
import type { WorkflowEvent } from '../../event-store/schemas.js';

function makeEvent(
  seq: number,
  type: string,
  data?: Record<string, unknown>,
  streamId = 'wf-001',
): WorkflowEvent {
  return {
    streamId,
    sequence: seq,
    timestamp: new Date().toISOString(),
    type,
    schemaVersion: '1.0',
    data,
  };
}

describe('TeamStatusView', () => {
  let materializer: ViewMaterializer;

  beforeEach(() => {
    materializer = new ViewMaterializer();
    materializer.register(TEAM_STATUS_VIEW, teamStatusProjection);
  });

  describe('TeamFormed_ListsTeammates', () => {
    it('should populate teammates from team.formed event', () => {
      const events = [
        makeEvent(1, 'team.formed', {
          teammates: [
            { name: 'agent-1', role: 'coder', model: 'claude' },
            { name: 'agent-2', role: 'reviewer' },
          ],
        }),
      ];

      const view = materializer.materialize<TeamStatusViewState>(
        'wf-001',
        TEAM_STATUS_VIEW,
        events,
      );

      expect(view.teammates).toHaveLength(2);
      expect(view.teammates[0]).toEqual({ name: 'agent-1', role: 'coder', model: 'claude' });
      expect(view.teammates[1]).toEqual({ name: 'agent-2', role: 'reviewer', model: undefined });
    });
  });

  describe('TaskClaimed_UpdatesCurrentTask', () => {
    it('should track the current task for each agent', () => {
      const events = [
        makeEvent(1, 'team.formed', {
          teammates: [{ name: 'agent-1', role: 'coder' }],
        }),
        makeEvent(2, 'task.claimed', {
          taskId: 'task-42',
          agentId: 'agent-1',
          claimedAt: '2025-06-15T10:00:00.000Z',
        }),
      ];

      const view = materializer.materialize<TeamStatusViewState>(
        'wf-001',
        TEAM_STATUS_VIEW,
        events,
      );

      expect(view.currentTasks).toEqual({ 'agent-1': 'task-42' });
    });
  });

  describe('NoTeam_ReturnsEmptyView', () => {
    it('should return empty teammates array when no team.formed event', () => {
      const view = materializer.materialize<TeamStatusViewState>(
        'wf-001',
        TEAM_STATUS_VIEW,
        [],
      );

      expect(view.teammates).toEqual([]);
      expect(view.currentTasks).toEqual({});
    });
  });

  describe('TaskCompleted_ClearsCurrentTask', () => {
    it('should clear current task when agent completes it', () => {
      const events = [
        makeEvent(1, 'team.formed', {
          teammates: [{ name: 'agent-1', role: 'coder' }],
        }),
        makeEvent(2, 'task.claimed', {
          taskId: 'task-42',
          agentId: 'agent-1',
          claimedAt: '2025-06-15T10:00:00.000Z',
        }),
        makeEvent(3, 'task.completed', { taskId: 'task-42' }),
      ];

      const view = materializer.materialize<TeamStatusViewState>(
        'wf-001',
        TEAM_STATUS_VIEW,
        events,
      );

      expect(view.currentTasks['agent-1']).toBeUndefined();
    });
  });

  describe('MultipleAgents_IndependentTracking', () => {
    it('should track tasks independently for each agent', () => {
      const events = [
        makeEvent(1, 'team.formed', {
          teammates: [
            { name: 'agent-1', role: 'coder' },
            { name: 'agent-2', role: 'coder' },
          ],
        }),
        makeEvent(2, 'task.claimed', { taskId: 't1', agentId: 'agent-1', claimedAt: '2025-01-01T00:00:00Z' }),
        makeEvent(3, 'task.claimed', { taskId: 't2', agentId: 'agent-2', claimedAt: '2025-01-01T00:00:00Z' }),
        makeEvent(4, 'task.completed', { taskId: 't1' }),
      ];

      const view = materializer.materialize<TeamStatusViewState>(
        'wf-001',
        TEAM_STATUS_VIEW,
        events,
      );

      expect(view.currentTasks['agent-1']).toBeUndefined();
      expect(view.currentTasks['agent-2']).toBe('t2');
    });
  });
});
