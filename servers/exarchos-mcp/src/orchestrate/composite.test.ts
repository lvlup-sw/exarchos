// ─── Composite Orchestrate Handler Tests ────────────────────────────────────

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ToolResult } from '../format.js';

// ─── Mock task handler functions ────────────────────────────────────────────

vi.mock('../tasks/tools.js', () => ({
  handleTaskClaim: vi.fn(),
  handleTaskComplete: vi.fn(),
  handleTaskFail: vi.fn(),
}));

vi.mock('../review/tools.js', () => ({
  handleReviewTriage: vi.fn(),
}));

vi.mock('./prepare-delegation.js', () => ({
  handlePrepareDelegation: vi.fn(),
}));

vi.mock('./prepare-synthesis.js', () => ({
  handlePrepareSynthesis: vi.fn(),
}));

vi.mock('./assess-stack.js', () => ({
  handleAssessStack: vi.fn(),
}));

import { handleTaskClaim, handleTaskComplete, handleTaskFail } from '../tasks/tools.js';
import { handleReviewTriage } from '../review/tools.js';
import { handlePrepareDelegation } from './prepare-delegation.js';
import { handlePrepareSynthesis } from './prepare-synthesis.js';
import { handleAssessStack } from './assess-stack.js';
import { handleOrchestrate } from './composite.js';

const STATE_DIR = '/tmp/test-state';

function successResult(data: unknown): ToolResult {
  return { success: true, data };
}

describe('handleOrchestrate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ─── Task Actions ───────────────────────────────────────────────────────

  describe('task actions', () => {
    it('handleOrchestrate_TaskClaim_DelegatesToHandleTaskClaim', async () => {
      // Arrange
      const expected = successResult({ streamId: 's1', sequence: 1, type: 'task.claimed' });
      vi.mocked(handleTaskClaim).mockResolvedValue(expected);
      const args = {
        action: 'task_claim',
        taskId: 't1',
        agentId: 'agent-1',
        streamId: 's1',
      };

      // Act
      const result = await handleOrchestrate(args, STATE_DIR);

      // Assert
      expect(result).toBe(expected);
      expect(handleTaskClaim).toHaveBeenCalledWith(
        { taskId: 't1', agentId: 'agent-1', streamId: 's1' },
        STATE_DIR,
      );
    });

    it('handleOrchestrate_TaskComplete_DelegatesToHandleTaskComplete', async () => {
      // Arrange
      const expected = successResult({ streamId: 's1', sequence: 2, type: 'task.completed' });
      vi.mocked(handleTaskComplete).mockResolvedValue(expected);
      const args = {
        action: 'task_complete',
        taskId: 't1',
        result: { artifacts: ['file.ts'] },
        streamId: 's1',
      };

      // Act
      const result = await handleOrchestrate(args, STATE_DIR);

      // Assert
      expect(result).toBe(expected);
      expect(handleTaskComplete).toHaveBeenCalledWith(
        { taskId: 't1', result: { artifacts: ['file.ts'] }, streamId: 's1' },
        STATE_DIR,
      );
    });

    it('handleOrchestrate_TaskFail_DelegatesToHandleTaskFail', async () => {
      // Arrange
      const expected = successResult({ streamId: 's1', sequence: 3, type: 'task.failed' });
      vi.mocked(handleTaskFail).mockResolvedValue(expected);
      const args = {
        action: 'task_fail',
        taskId: 't1',
        error: 'something broke',
        diagnostics: { log: 'details' },
        streamId: 's1',
      };

      // Act
      const result = await handleOrchestrate(args, STATE_DIR);

      // Assert
      expect(result).toBe(expected);
      expect(handleTaskFail).toHaveBeenCalledWith(
        { taskId: 't1', error: 'something broke', diagnostics: { log: 'details' }, streamId: 's1' },
        STATE_DIR,
      );
    });
  });

  // ─── Composite Actions ──────────────────────────────────────────────

  describe('composite actions', () => {
    it('HandleOrchestrate_PrepareDelegation_DelegatesToHandler', async () => {
      // Arrange
      const expected = successResult({ ready: true, readiness: { planApproved: true, tasksExist: true } });
      vi.mocked(handlePrepareDelegation).mockResolvedValue(expected);
      const args = {
        action: 'prepare_delegation',
        featureId: 'feat-123',
        tasks: [{ id: 't1', title: 'Task 1' }],
      };

      // Act
      const result = await handleOrchestrate(args, STATE_DIR);

      // Assert
      expect(result).toBe(expected);
      expect(handlePrepareDelegation).toHaveBeenCalledWith(
        { featureId: 'feat-123', tasks: [{ id: 't1', title: 'Task 1' }] },
        STATE_DIR,
      );
    });

    it('HandleOrchestrate_PrepareSynthesis_DelegatesToHandler', async () => {
      // Arrange
      const expected = successResult({ ready: true, readiness: { allPassed: true } });
      vi.mocked(handlePrepareSynthesis).mockResolvedValue(expected);
      const args = {
        action: 'prepare_synthesis',
        featureId: 'feat-456',
      };

      // Act
      const result = await handleOrchestrate(args, STATE_DIR);

      // Assert
      expect(result).toBe(expected);
      expect(handlePrepareSynthesis).toHaveBeenCalledWith(
        { featureId: 'feat-456' },
        STATE_DIR,
      );
    });

    it('HandleOrchestrate_AssessStack_DelegatesToHandler', async () => {
      // Arrange
      const expected = successResult({ status: 'healthy', actionItems: [], recommendation: 'proceed' });
      vi.mocked(handleAssessStack).mockResolvedValue(expected);
      const args = {
        action: 'assess_stack',
        featureId: 'feat-789',
        prNumbers: [101, 102],
      };

      // Act
      const result = await handleOrchestrate(args, STATE_DIR);

      // Assert
      expect(result).toBe(expected);
      expect(handleAssessStack).toHaveBeenCalledWith(
        { featureId: 'feat-789', prNumbers: [101, 102] },
        STATE_DIR,
      );
    });
  });

  // ─── Removed Team Actions ─────────────────────────────────────────────

  describe('removed team actions', () => {
    it('should reject removed team actions', async () => {
      for (const action of ['team_spawn', 'team_message', 'team_broadcast', 'team_shutdown', 'team_status']) {
        const result = await handleOrchestrate({ action }, '/tmp/test');
        expect(result.success).toBe(false);
        expect(result.error?.code).toBe('UNKNOWN_ACTION');
      }
    });
  });

  // ─── Error Handling ─────────────────────────────────────────────────────

  describe('error handling', () => {
    it('handleOrchestrate_UnknownAction_ReturnsError', async () => {
      // Arrange
      const args = { action: 'unknown_action' };

      // Act
      const result = await handleOrchestrate(args, STATE_DIR);

      // Assert
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('UNKNOWN_ACTION');
      expect(result.error?.message).toContain('unknown_action');
    });
  });
});
