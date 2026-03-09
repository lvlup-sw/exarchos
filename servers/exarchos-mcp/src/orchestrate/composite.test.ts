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

vi.mock('./design-completeness.js', () => ({
  handleDesignCompleteness: vi.fn(),
}));

vi.mock('./plan-coverage.js', () => ({
  handlePlanCoverage: vi.fn(),
}));

vi.mock('./tdd-compliance.js', () => ({
  handleTddCompliance: vi.fn(),
}));

vi.mock('./post-merge.js', () => ({
  handlePostMerge: vi.fn(),
}));

vi.mock('../agents/handler.js', async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>;
  return {
    ...actual,
    handleAgentSpec: vi.fn(),
  };
});

import { handleTaskClaim, handleTaskComplete, handleTaskFail } from '../tasks/tools.js';
import { handleReviewTriage } from '../review/tools.js';
import { handlePrepareDelegation } from './prepare-delegation.js';
import { handlePrepareSynthesis } from './prepare-synthesis.js';
import { handleAssessStack } from './assess-stack.js';
import { handleDesignCompleteness } from './design-completeness.js';
import { handlePlanCoverage } from './plan-coverage.js';
import { handleTddCompliance } from './tdd-compliance.js';
import { handlePostMerge } from './post-merge.js';
import { handleAgentSpec } from '../agents/handler.js';
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

    it('HandleOrchestrate_CheckPostMerge_DelegatesToHandler', async () => {
      // Arrange
      const expected = successResult({ passed: true, prUrl: 'https://github.com/org/repo/pull/42', mergeSha: 'abc1234', findings: [], report: '...' });
      vi.mocked(handlePostMerge).mockResolvedValue(expected);
      const args = {
        action: 'check_post_merge',
        featureId: 'feat-123',
        prUrl: 'https://github.com/org/repo/pull/42',
        mergeSha: 'abc1234',
      };

      // Act
      const result = await handleOrchestrate(args, STATE_DIR);

      // Assert
      expect(result).toBe(expected);
      expect(handlePostMerge).toHaveBeenCalledWith(
        { featureId: 'feat-123', prUrl: 'https://github.com/org/repo/pull/42', mergeSha: 'abc1234' },
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

    it('HandleOrchestrate_CheckDesignCompleteness_DelegatesToHandler', async () => {
      // Arrange
      const expected = successResult({ passed: true, advisory: true, findings: [] });
      vi.mocked(handleDesignCompleteness).mockResolvedValue(expected);
      const args = {
        action: 'check_design_completeness',
        featureId: 'feat-200',
        designPath: '/tmp/design.md',
      };

      // Act
      const result = await handleOrchestrate(args, STATE_DIR);

      // Assert
      expect(result).toBe(expected);
      expect(handleDesignCompleteness).toHaveBeenCalledWith(
        { featureId: 'feat-200', designPath: '/tmp/design.md' },
        STATE_DIR,
      );
    });

    it('HandleOrchestrate_CheckTddCompliance_DelegatesToHandler', async () => {
      // Arrange
      const expected = successResult({ passed: true, taskId: 't1', branch: 'feat-branch', compliance: { passCount: 5, failCount: 0, total: 5 } });
      vi.mocked(handleTddCompliance).mockResolvedValue(expected);
      const args = {
        action: 'check_tdd_compliance',
        featureId: 'feat-300',
        taskId: 't1',
        branch: 'feat-branch',
      };

      // Act
      const result = await handleOrchestrate(args, STATE_DIR);

      // Assert
      expect(result).toBe(expected);
      expect(handleTddCompliance).toHaveBeenCalledWith(
        { featureId: 'feat-300', taskId: 't1', branch: 'feat-branch' },
        STATE_DIR,
      );
    });

    it('HandleOrchestrate_CheckPlanCoverage_DelegatesToHandler', async () => {
      // Arrange
      const expected = successResult({ passed: true, coverage: { covered: 5, gaps: 0, deferred: 0, total: 5 } });
      vi.mocked(handlePlanCoverage).mockResolvedValue(expected);
      const args = {
        action: 'check_plan_coverage',
        featureId: 'feat-100',
        designPath: '/tmp/design.md',
        planPath: '/tmp/plan.md',
      };

      // Act
      const result = await handleOrchestrate(args, STATE_DIR);

      // Assert
      expect(result).toBe(expected);
      expect(handlePlanCoverage).toHaveBeenCalledWith(
        { featureId: 'feat-100', designPath: '/tmp/design.md', planPath: '/tmp/plan.md' },
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

  // ─── Describe Routing ────────────────────────────────────────────────

  describe('describe routing', () => {
    it('HandleOrchestrate_Describe_RoutesToDescribeHandler', async () => {
      // Arrange — describe is not mocked; it resolves schemas from the live registry
      const args = { action: 'describe', actions: ['task_claim'] };

      // Act
      const result = await handleOrchestrate(args, STATE_DIR);

      // Assert — verify describe returns schema metadata for the requested action
      expect(result.success).toBe(true);
      const data = result.data as Record<string, unknown>;
      expect(data).toHaveProperty('task_claim');
      const desc = data['task_claim'] as Record<string, unknown>;
      expect(desc).toHaveProperty('description');
      expect(desc).toHaveProperty('schema');
    });
  });

  // ─── Agent Spec Routing ──────────────────────────────────────────────────

  describe('agent spec routing', () => {
    it('OrchestrateComposite_AgentSpecAction_RoutesToHandler', async () => {
      // Arrange
      const expected = successResult({
        agent: 'implementer',
        systemPrompt: 'You are a TDD implementer',
        tools: ['Read', 'Write'],
      });
      vi.mocked(handleAgentSpec).mockResolvedValue(expected);
      const args = {
        action: 'agent_spec',
        agent: 'implementer',
        format: 'full',
      };

      // Act
      const result = await handleOrchestrate(args, STATE_DIR);

      // Assert
      expect(result).toBe(expected);
      expect(handleAgentSpec).toHaveBeenCalledWith(
        { agent: 'implementer', format: 'full' },
        STATE_DIR,
      );
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
