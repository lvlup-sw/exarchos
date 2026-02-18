import { describe, it, expect } from 'vitest';
import {
  validateAgentEvent,
  AGENT_EVENT_TYPES,
  EventTypes,
  WorkflowEventBase,
  TeamSpawnedData,
  TeamTaskAssignedData,
  TeamTaskCompletedData,
  TeamTaskFailedData,
  TeamDisbandedData,
  TeamContextInjectedData,
  TeamTaskPlannedData,
  TeamTeammateDispatchedData,
  QualityRegressionData,
  WorkflowCasFailedData,
} from './schemas.js';

describe('validateAgentEvent', () => {
  describe('agent event types', () => {
    it('should reject task.claimed when agentId is missing', () => {
      expect(() =>
        validateAgentEvent({ type: 'task.claimed', source: 'test' }),
      ).toThrow();
    });

    it('should reject task.claimed when source is missing', () => {
      expect(() =>
        validateAgentEvent({ type: 'task.claimed', agentId: 'agent-1' }),
      ).toThrow();
    });

    it('should reject task.progressed when source is missing', () => {
      expect(() =>
        validateAgentEvent({ type: 'task.progressed', agentId: 'agent-1' }),
      ).toThrow();
    });

    it('should pass task.claimed when both agentId and source are present', () => {
      expect(
        validateAgentEvent({ type: 'task.claimed', agentId: 'agent-1', source: 'test' }),
      ).toBe(true);
    });

    it('should pass task.progressed when both agentId and source are present', () => {
      expect(
        validateAgentEvent({ type: 'task.progressed', agentId: 'agent-1', source: 'test' }),
      ).toBe(true);
    });
  });

  describe('system event types', () => {
    it('should pass workflow.started without agentId or source', () => {
      expect(
        validateAgentEvent({ type: 'workflow.started' }),
      ).toBe(true);
    });

    it('should pass workflow.transition without agentId or source', () => {
      expect(
        validateAgentEvent({ type: 'workflow.transition' }),
      ).toBe(true);
    });

    it('should pass task.assigned without agentId or source', () => {
      expect(
        validateAgentEvent({ type: 'task.assigned' }),
      ).toBe(true);
    });
  });

  describe('AGENT_EVENT_TYPES constant', () => {
    it('should contain all agent event types', () => {
      expect(AGENT_EVENT_TYPES).toEqual([
        'task.claimed',
        'task.progressed',
        'team.task.completed',
        'team.task.failed',
      ]);
    });
  });
});

describe('Team Event Data Schemas', () => {
  describe('TeamSpawnedData', () => {
    it('should parse valid payload successfully', () => {
      const result = TeamSpawnedData.safeParse({
        teamSize: 3,
        teammateNames: ['a', 'b', 'c'],
        taskCount: 5,
        dispatchMode: 'agent-team',
      });
      expect(result.success).toBe(true);
    });
  });

  describe('TeamTaskCompletedData', () => {
    it('should parse valid payload successfully', () => {
      const result = TeamTaskCompletedData.safeParse({
        taskId: 'task-001',
        teammateName: 'worker-1',
        durationMs: 5000,
        filesChanged: ['a.ts'],
        testsPassed: true,
        qualityGateResults: {},
      });
      expect(result.success).toBe(true);
    });
  });

  describe('TeamTaskFailedData', () => {
    it('should parse valid payload successfully', () => {
      const result = TeamTaskFailedData.safeParse({
        taskId: 'task-001',
        teammateName: 'worker-1',
        failureReason: 'typecheck',
        gateResults: {},
      });
      expect(result.success).toBe(true);
    });
  });

  describe('TeamDisbandedData', () => {
    it('should parse valid payload successfully', () => {
      const result = TeamDisbandedData.safeParse({
        totalDurationMs: 60000,
        tasksCompleted: 5,
        tasksFailed: 0,
      });
      expect(result.success).toBe(true);
    });
  });

  describe('TeamContextInjectedData', () => {
    it('should parse valid payload successfully', () => {
      const result = TeamContextInjectedData.safeParse({
        phase: 'delegate',
        toolsAvailable: 3,
        historicalHints: ['hint'],
      });
      expect(result.success).toBe(true);
    });
  });

  describe('TeamTaskAssignedData', () => {
    it('should parse valid payload successfully', () => {
      const result = TeamTaskAssignedData.safeParse({
        taskId: 'task-001',
        teammateName: 'worker-1',
        worktreePath: '/tmp/wt',
        modules: ['auth'],
      });
      expect(result.success).toBe(true);
    });
  });
});

describe('EventTypes', () => {
  it('should include all 8 team event types', () => {
    const teamEventTypes = [
      'team.spawned',
      'team.task.assigned',
      'team.task.completed',
      'team.task.failed',
      'team.disbanded',
      'team.context.injected',
      'team.task.planned',
      'team.teammate.dispatched',
    ];
    for (const eventType of teamEventTypes) {
      expect(EventTypes).toContain(eventType);
    }
  });
});

// ─── Task 002: team.task.planned and team.teammate.dispatched ────────────────

describe('TeamTaskPlannedData', () => {
  it('EventSchema_TeamTaskPlanned_ValidatesPayload', () => {
    const result = TeamTaskPlannedData.safeParse({
      taskId: 'task-001',
      title: 'Implement event store',
      modules: ['event-store', 'schemas'],
      blockedBy: ['task-000'],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.taskId).toBe('task-001');
      expect(result.data.title).toBe('Implement event store');
      expect(result.data.modules).toEqual(['event-store', 'schemas']);
      expect(result.data.blockedBy).toEqual(['task-000']);
    }
  });

  it('EventSchema_TeamTaskPlanned_RejectsWithoutTaskId', () => {
    const result = TeamTaskPlannedData.safeParse({
      title: 'Implement event store',
      modules: ['event-store'],
      blockedBy: [],
    });
    expect(result.success).toBe(false);
  });

  it('EventSchema_TeamTaskPlanned_IncludedInEventTypeUnion', () => {
    expect(EventTypes).toContain('team.task.planned');
  });

  it('EventSchema_TeamTaskPlanned_ParsesAsBaseEvent', () => {
    const event = WorkflowEventBase.safeParse({
      streamId: 'my-workflow',
      sequence: 1,
      type: 'team.task.planned',
      data: {
        taskId: 'task-001',
        title: 'Implement event store',
        modules: ['event-store'],
        blockedBy: [],
      },
    });
    expect(event.success).toBe(true);
  });
});

describe('TeamTeammateDispatchedData', () => {
  it('EventSchema_TeamTeammateDispatched_ValidatesPayload', () => {
    const result = TeamTeammateDispatchedData.safeParse({
      teammateName: 'worker-1',
      worktreePath: '/path/.worktrees/wt-001',
      assignedTaskIds: ['task-001', 'task-002'],
      model: 'claude-sonnet-4-20250514',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.teammateName).toBe('worker-1');
      expect(result.data.worktreePath).toBe('/path/.worktrees/wt-001');
      expect(result.data.assignedTaskIds).toEqual(['task-001', 'task-002']);
      expect(result.data.model).toBe('claude-sonnet-4-20250514');
    }
  });

  it('EventSchema_TeamTeammateDispatched_RejectsWithoutTeammateName', () => {
    const result = TeamTeammateDispatchedData.safeParse({
      worktreePath: '/path/.worktrees/wt-001',
      assignedTaskIds: ['task-001'],
      model: 'claude-sonnet-4-20250514',
    });
    expect(result.success).toBe(false);
  });

  it('EventSchema_TeamTeammateDispatched_IncludedInEventTypeUnion', () => {
    expect(EventTypes).toContain('team.teammate.dispatched');
  });

  it('EventSchema_TeamTeammateDispatched_ParsesAsBaseEvent', () => {
    const event = WorkflowEventBase.safeParse({
      streamId: 'my-workflow',
      sequence: 1,
      type: 'team.teammate.dispatched',
      data: {
        teammateName: 'worker-1',
        worktreePath: '/tmp/wt',
        assignedTaskIds: ['task-001'],
        model: 'claude-sonnet-4-20250514',
      },
    });
    expect(event.success).toBe(true);
  });
});

// ─── T11: quality.regression Event Type ──────────────────────────────────────

describe('QualityRegressionData', () => {
  it('QualityRegressionData_Valid_Parses', () => {
    const result = QualityRegressionData.safeParse({
      skill: 'delegation',
      gate: 'typecheck',
      consecutiveFailures: 3,
      firstFailureCommit: 'abc',
      lastFailureCommit: 'def',
      detectedAt: '2026-02-17T00:00:00.000Z',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.skill).toBe('delegation');
      expect(result.data.gate).toBe('typecheck');
      expect(result.data.consecutiveFailures).toBe(3);
      expect(result.data.firstFailureCommit).toBe('abc');
      expect(result.data.lastFailureCommit).toBe('def');
      expect(result.data.detectedAt).toBe('2026-02-17T00:00:00.000Z');
    }
  });
});

// ─── T26: workflow.cas-failed Event Schema ───────────────────────────────────

describe('WorkflowCasFailedData', () => {
  it('WorkflowCasFailedData_Valid_Parses', () => {
    const result = WorkflowCasFailedData.safeParse({
      featureId: 'test',
      phase: 'delegate',
      retries: 3,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.featureId).toBe('test');
      expect(result.data.phase).toBe('delegate');
      expect(result.data.retries).toBe(3);
    }
  });
});

describe('EventTypes', () => {
  it('EventTypes_IncludesQualityRegression', () => {
    expect(EventTypes).toContain('quality.regression');
  });

  it('EventTypes_IncludesWorkflowCasFailed', () => {
    expect(EventTypes).toContain('workflow.cas-failed');
  });

  it('EventTypes_HasExpectedCount', () => {
    expect(EventTypes).toHaveLength(34);
  });
});
