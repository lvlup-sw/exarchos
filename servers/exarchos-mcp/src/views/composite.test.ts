import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the view tools module
vi.mock('./tools.js', () => ({
  handleViewPipeline: vi.fn(),
  handleViewTasks: vi.fn(),
  handleViewWorkflowStatus: vi.fn(),
  handleViewTeamPerformance: vi.fn(),
  handleViewDelegationTimeline: vi.fn(),
  handleViewCodeQuality: vi.fn(),
  handleViewQualityHints: vi.fn(),
  handleViewEvalResults: vi.fn(),
  handleViewQualityCorrelation: vi.fn(),
  handleViewSessionProvenance: vi.fn(),
}));

// Mock the stack tools module
vi.mock('../stack/tools.js', () => ({
  handleStackStatus: vi.fn(),
  handleStackPlace: vi.fn(),
}));

// Mock the telemetry tools module
vi.mock('../telemetry/tools.js', () => ({
  handleViewTelemetry: vi.fn(),
}));

import { handleView } from './composite.js';
import {
  handleViewPipeline,
  handleViewTasks,
  handleViewWorkflowStatus,
  handleViewTeamPerformance,
  handleViewDelegationTimeline,
  handleViewCodeQuality,
  handleViewQualityHints,
  handleViewEvalResults,
  handleViewQualityCorrelation,
  handleViewSessionProvenance,
} from './tools.js';
import { handleStackStatus, handleStackPlace } from '../stack/tools.js';
import { handleViewTelemetry } from '../telemetry/tools.js';

const STATE_DIR = '/tmp/test-state';

describe('handleView', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  describe('pipeline', () => {
    it('should delegate to handleViewPipeline', async () => {
      // Arrange
      const expected = { success: true, data: { workflows: [], total: 0 } };
      vi.mocked(handleViewPipeline).mockResolvedValue(expected);
      const args = { action: 'pipeline', limit: 10, offset: 0 };

      // Act
      const result = await handleView(args, STATE_DIR);

      // Assert
      expect(result).toBe(expected);
      expect(handleViewPipeline).toHaveBeenCalledWith(
        { limit: 10, offset: 0 },
        STATE_DIR,
      );
    });
  });

  describe('tasks', () => {
    it('should delegate to handleViewTasks', async () => {
      // Arrange
      const expected = { success: true, data: [] };
      vi.mocked(handleViewTasks).mockResolvedValue(expected);
      const args = {
        action: 'tasks',
        workflowId: 'wf-1',
        filter: { status: 'done' },
        limit: 5,
        offset: 2,
        fields: ['taskId', 'status'],
      };

      // Act
      const result = await handleView(args, STATE_DIR);

      // Assert
      expect(result).toBe(expected);
      expect(handleViewTasks).toHaveBeenCalledWith(
        {
          workflowId: 'wf-1',
          filter: { status: 'done' },
          limit: 5,
          offset: 2,
          fields: ['taskId', 'status'],
        },
        STATE_DIR,
      );
    });
  });

  describe('workflow_status', () => {
    it('should delegate to handleViewWorkflowStatus', async () => {
      // Arrange
      const expected = { success: true, data: { phase: 'delegate' } };
      vi.mocked(handleViewWorkflowStatus).mockResolvedValue(expected);
      const args = { action: 'workflow_status', workflowId: 'wf-2' };

      // Act
      const result = await handleView(args, STATE_DIR);

      // Assert
      expect(result).toBe(expected);
      expect(handleViewWorkflowStatus).toHaveBeenCalledWith(
        { workflowId: 'wf-2' },
        STATE_DIR,
      );
    });
  });

  describe('removed team_status', () => {
    it('should return UNKNOWN_ACTION for team_status', async () => {
      // Arrange
      const args = { action: 'team_status', workflowId: 'wf-3' };

      // Act
      const result = await handleView(args, STATE_DIR);

      // Assert
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('UNKNOWN_ACTION');
    });
  });

  describe('stack_status', () => {
    it('should delegate to handleStackStatus', async () => {
      // Arrange
      const expected = { success: true, data: [] };
      vi.mocked(handleStackStatus).mockResolvedValue(expected);
      const args = {
        action: 'stack_status',
        streamId: 'stream-1',
        limit: 3,
        offset: 1,
      };

      // Act
      const result = await handleView(args, STATE_DIR);

      // Assert
      expect(result).toBe(expected);
      expect(handleStackStatus).toHaveBeenCalledWith(
        { streamId: 'stream-1', limit: 3, offset: 1 },
        STATE_DIR,
      );
    });
  });

  describe('stack_place', () => {
    it('should delegate to handleStackPlace', async () => {
      // Arrange
      const expected = {
        success: true,
        data: { streamId: 's1', sequence: 1, type: 'stack.position-filled' },
      };
      vi.mocked(handleStackPlace).mockResolvedValue(expected);
      const args = {
        action: 'stack_place',
        streamId: 'stream-1',
        position: 2,
        taskId: 'task-A',
        branch: 'feat/foo',
        prUrl: 'https://github.com/org/repo/pull/1',
      };

      // Act
      const result = await handleView(args, STATE_DIR);

      // Assert
      expect(result).toBe(expected);
      expect(handleStackPlace).toHaveBeenCalledWith(
        {
          streamId: 'stream-1',
          position: 2,
          taskId: 'task-A',
          branch: 'feat/foo',
          prUrl: 'https://github.com/org/repo/pull/1',
        },
        STATE_DIR,
      );
    });
  });

  describe('telemetry', () => {
    it('should delegate to handleViewTelemetry', async () => {
      // Arrange
      const expected = {
        success: true,
        data: { session: { totalInvocations: 5 }, tools: [], hints: [] },
      };
      vi.mocked(handleViewTelemetry).mockResolvedValue(expected);
      const args = { action: 'telemetry', compact: true, tool: 'workflow_get' };

      // Act
      const result = await handleView(args, STATE_DIR);

      // Assert
      expect(result).toBe(expected);
      expect(handleViewTelemetry).toHaveBeenCalledWith(
        { compact: true, tool: 'workflow_get' },
        STATE_DIR,
      );
    });
  });

  describe('team_performance', () => {
    it('handleView_TeamPerformanceAction_DispatchesToHandler', async () => {
      // Arrange
      const expected = {
        success: true,
        data: { teammates: {}, modules: {}, teamSizing: { avgTasksPerTeammate: 0, dataPoints: 0 } },
      };
      vi.mocked(handleViewTeamPerformance).mockResolvedValue(expected);
      const args = { action: 'team_performance', workflowId: 'wf-4' };

      // Act
      const result = await handleView(args, STATE_DIR);

      // Assert
      expect(result).toBe(expected);
      expect(result.success).toBe(true);
      expect(handleViewTeamPerformance).toHaveBeenCalledWith(
        { workflowId: 'wf-4' },
        STATE_DIR,
      );
    });
  });

  describe('delegation_timeline', () => {
    it('handleView_DelegationTimelineAction_DispatchesToHandler', async () => {
      // Arrange
      const expected = {
        success: true,
        data: { featureId: '', tasks: [], bottleneck: null },
      };
      vi.mocked(handleViewDelegationTimeline).mockResolvedValue(expected);
      const args = { action: 'delegation_timeline', workflowId: 'test' };

      // Act
      const result = await handleView(args, STATE_DIR);

      // Assert
      expect(result).toBe(expected);
      expect(result.success).toBe(true);
      expect(handleViewDelegationTimeline).toHaveBeenCalledWith(
        { workflowId: 'test' },
        STATE_DIR,
      );
    });
  });

  describe('code_quality', () => {
    it('HandleView_CodeQuality_RoutesToHandler', async () => {
      // Arrange
      const expected = {
        success: true,
        data: { skills: {}, gates: {}, regressions: [], benchmarks: [] },
      };
      vi.mocked(handleViewCodeQuality).mockResolvedValue(expected);
      const args = { action: 'code_quality', workflowId: 'wf-5' };

      // Act
      const result = await handleView(args, STATE_DIR);

      // Assert
      expect(result).toBe(expected);
      expect(result.success).toBe(true);
      expect(handleViewCodeQuality).toHaveBeenCalledWith(
        { workflowId: 'wf-5' },
        STATE_DIR,
      );
    });
  });

  describe('quality_hints', () => {
    it('handleView_QualityHintsAction_ReturnsHints', async () => {
      // Arrange
      const expected = {
        success: true,
        data: {
          hints: [{ skill: 'my-skill', category: 'gate', severity: 'warning', hint: 'test hint' }],
          generatedAt: '2024-01-01T00:00:00.000Z',
        },
      };
      vi.mocked(handleViewQualityHints).mockResolvedValue(expected);
      const args = { action: 'quality_hints', workflowId: 'wf-6' };

      // Act
      const result = await handleView(args, STATE_DIR);

      // Assert
      expect(result).toBe(expected);
      expect(result.success).toBe(true);
      expect(handleViewQualityHints).toHaveBeenCalledWith(
        { workflowId: 'wf-6' },
        STATE_DIR,
      );
    });

    it('handleView_QualityHintsWithSkillFilter_ReturnsFilteredHints', async () => {
      // Arrange
      const expected = {
        success: true,
        data: {
          hints: [{ skill: 'target-skill', category: 'gate', severity: 'warning', hint: 'filtered hint' }],
          generatedAt: '2024-01-01T00:00:00.000Z',
        },
      };
      vi.mocked(handleViewQualityHints).mockResolvedValue(expected);
      const args = { action: 'quality_hints', workflowId: 'wf-7', skill: 'target-skill' };

      // Act
      const result = await handleView(args, STATE_DIR);

      // Assert
      expect(result).toBe(expected);
      expect(handleViewQualityHints).toHaveBeenCalledWith(
        { workflowId: 'wf-7', skill: 'target-skill' },
        STATE_DIR,
      );
    });

    it('handleView_QualityHintsNoData_ReturnsEmptyArray', async () => {
      // Arrange
      const expected = {
        success: true,
        data: { hints: [], generatedAt: '2024-01-01T00:00:00.000Z' },
      };
      vi.mocked(handleViewQualityHints).mockResolvedValue(expected);
      const args = { action: 'quality_hints' };

      // Act
      const result = await handleView(args, STATE_DIR);

      // Assert
      expect(result).toBe(expected);
      expect(result.success).toBe(true);
      expect((result.data as { hints: unknown[] }).hints).toEqual([]);
    });
  });

  describe('eval_results', () => {
    it('handleView_EvalResultsAction_DispatchesToHandler', async () => {
      // Arrange
      const expected = {
        success: true,
        data: { skills: {}, runs: [], regressions: [] },
      };
      vi.mocked(handleViewEvalResults).mockResolvedValue(expected);
      const args = { action: 'eval_results', workflowId: 'eval-wf', skill: 'delegation', limit: 5 };

      // Act
      const result = await handleView(args, STATE_DIR);

      // Assert
      expect(result).toBe(expected);
      expect(result.success).toBe(true);
      expect(handleViewEvalResults).toHaveBeenCalledWith(
        { workflowId: 'eval-wf', skill: 'delegation', limit: 5 },
        STATE_DIR,
      );
    });
  });

  describe('quality_correlation', () => {
    it('HandleView_QualityCorrelation_DispatchesToHandler', async () => {
      // Arrange
      const expected = {
        success: true,
        data: { skills: { delegation: { skill: 'delegation', gatePassRate: 0.9, evalScore: 0.85, evalTrend: 'stable', qualityTrend: 'stable', regressionCount: 0 } } },
      };
      vi.mocked(handleViewQualityCorrelation).mockResolvedValue(expected);
      const args = { action: 'quality_correlation', workflowId: 'corr-wf' };

      // Act
      const result = await handleView(args, STATE_DIR);

      // Assert
      expect(result).toBe(expected);
      expect(result.success).toBe(true);
      expect(handleViewQualityCorrelation).toHaveBeenCalledWith(
        { workflowId: 'corr-wf' },
        STATE_DIR,
      );
    });

    it('HandleView_QualityCorrelation_NoWorkflowId_DelegatesWithoutIt', async () => {
      // Arrange
      const expected = {
        success: true,
        data: { skills: {} },
      };
      vi.mocked(handleViewQualityCorrelation).mockResolvedValue(expected);
      const args = { action: 'quality_correlation' };

      // Act
      const result = await handleView(args, STATE_DIR);

      // Assert
      expect(result).toBe(expected);
      expect(handleViewQualityCorrelation).toHaveBeenCalledWith(
        {},
        STATE_DIR,
      );
    });
  });

  describe('session_provenance', () => {
    it('exarchosView_SessionProvenance_BySession_ReturnsSessionData', async () => {
      // Arrange
      const expected = {
        success: true,
        sessionId: 'sess-1',
        tools: { Read: 5 },
        toolsByCategory: { native: 5, mcp_exarchos: 0, mcp_other: 0 },
        tokens: { in: 1000, out: 500, cacheR: 200, cacheW: 100 },
      };
      vi.mocked(handleViewSessionProvenance).mockResolvedValue(expected);
      const args = { action: 'session_provenance', sessionId: 'sess-1' };

      // Act
      const result = await handleView(args, STATE_DIR);

      // Assert
      expect(result).toBe(expected);
      expect(handleViewSessionProvenance).toHaveBeenCalledWith(
        { sessionId: 'sess-1' },
        STATE_DIR,
      );
    });

    it('exarchosView_SessionProvenance_ByWorkflow_ReturnsAggregatedData', async () => {
      // Arrange
      const expected = {
        success: true,
        workflowId: 'wf-1',
        sessions: 3,
        tokens: { in: 5000, out: 2500, cacheR: 1000, cacheW: 500 },
      };
      vi.mocked(handleViewSessionProvenance).mockResolvedValue(expected);
      const args = { action: 'session_provenance', workflowId: 'wf-1' };

      // Act
      const result = await handleView(args, STATE_DIR);

      // Assert
      expect(result).toBe(expected);
      expect(handleViewSessionProvenance).toHaveBeenCalledWith(
        { workflowId: 'wf-1' },
        STATE_DIR,
      );
    });

    it('exarchosView_SessionProvenance_InvalidQuery_ReturnsError', async () => {
      // Arrange
      const expected = {
        success: false,
        error: { code: 'INVALID_QUERY', message: 'Either sessionId or workflowId is required' },
      };
      vi.mocked(handleViewSessionProvenance).mockResolvedValue(expected);
      const args = { action: 'session_provenance' };

      // Act
      const result = await handleView(args, STATE_DIR);

      // Assert
      expect(result).toBe(expected);
      expect(handleViewSessionProvenance).toHaveBeenCalledWith(
        {},
        STATE_DIR,
      );
    });
  });

  describe('unknown action', () => {
    it('HandleView_UnknownAction_IncludesEvalResultsAndCodeQuality', async () => {
      // Arrange
      const args = { action: 'nonexistent' };

      // Act
      const result = await handleView(args, STATE_DIR);

      // Assert
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('UNKNOWN_ACTION');
      const validTargets = (result.error as Record<string, unknown>)?.validTargets as string[];
      expect(validTargets).toContain('code_quality');
      expect(validTargets).toContain('quality_hints');
      expect(validTargets).toContain('eval_results');
      expect(validTargets).toContain('quality_correlation');
      expect(validTargets).toContain('session_provenance');
    });

    it('should return error for unknown action', async () => {
      // Arrange
      const args = { action: 'nonexistent' };

      // Act
      const result = await handleView(args, STATE_DIR);

      // Assert
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('UNKNOWN_ACTION');
      expect(result.error?.message).toContain('nonexistent');
    });
  });

  describe('missing action', () => {
    it('should return error when action is not provided', async () => {
      // Arrange
      const args = {};

      // Act
      const result = await handleView(args, STATE_DIR);

      // Assert
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('UNKNOWN_ACTION');
    });
  });
});
