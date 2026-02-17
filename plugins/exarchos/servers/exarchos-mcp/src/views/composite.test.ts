import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the view tools module
vi.mock('./tools.js', () => ({
  handleViewPipeline: vi.fn(),
  handleViewTasks: vi.fn(),
  handleViewWorkflowStatus: vi.fn(),
  handleViewTeamPerformance: vi.fn(),
  handleViewDelegationTimeline: vi.fn(),
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

  describe('unknown action', () => {
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
