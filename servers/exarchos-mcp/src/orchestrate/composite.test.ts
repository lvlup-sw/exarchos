// ─── Composite Orchestrate Handler Tests ────────────────────────────────────

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ToolResult } from '../format.js';
import type { DispatchContext } from '../core/dispatch.js';
import { EventStore } from '../event-store/store.js';

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

vi.mock('./prune-stale-workflows.js', () => ({
  handlePruneStaleWorkflows: vi.fn(),
}));

vi.mock('./request-synthesize.js', () => ({
  handleRequestSynthesize: vi.fn(),
}));

vi.mock('./finalize-oneshot.js', () => ({
  handleFinalizeOneshot: vi.fn(),
}));

vi.mock('./doctor/index.js', () => ({
  handleDoctor: vi.fn(),
}));

vi.mock('./init/index.js', () => ({
  handleInit: vi.fn(),
}));

vi.mock('../agents/handler.js', async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>;
  return {
    ...actual,
    handleAgentSpec: vi.fn(),
  };
});

vi.mock('../runbooks/handler.js', () => ({
  handleRunbook: vi.fn(),
}));

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
import { handleRunbook } from '../runbooks/handler.js';
import { handlePruneStaleWorkflows } from './prune-stale-workflows.js';
import { handleRequestSynthesize } from './request-synthesize.js';
import { handleFinalizeOneshot } from './finalize-oneshot.js';
import { handleDoctor } from './doctor/index.js';
import { handleInit } from './init/index.js';
import { TOOL_REGISTRY } from '../registry.js';
import { handleOrchestrate } from './composite.js';

const STATE_DIR = '/tmp/test-state';

function makeCtx(stateDir: string): DispatchContext {
  return { stateDir, eventStore: new EventStore(stateDir), enableTelemetry: false };
}

const CTX = makeCtx(STATE_DIR);

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
      const result = await handleOrchestrate(args, CTX);

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
      const result = await handleOrchestrate(args, CTX);

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
      const result = await handleOrchestrate(args, CTX);

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
      const result = await handleOrchestrate(args, CTX);

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
      const result = await handleOrchestrate(args, CTX);

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
      const result = await handleOrchestrate(args, CTX);

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
      const result = await handleOrchestrate(args, CTX);

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
      const result = await handleOrchestrate(args, CTX);

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
      const result = await handleOrchestrate(args, CTX);

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
      const result = await handleOrchestrate(args, CTX);

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
        const result = await handleOrchestrate({ action }, makeCtx('/tmp/test'));
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
      const result = await handleOrchestrate(args, CTX);

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
      const result = await handleOrchestrate(args, CTX);

      // Assert
      expect(result).toBe(expected);
      expect(handleAgentSpec).toHaveBeenCalledWith(
        { agent: 'implementer', format: 'full' },
        STATE_DIR,
      );
    });
  });

  // ─── Runbook Routing ──────────────────────────────────────────────────

  describe('runbook routing', () => {
    it('HandleOrchestrate_RunbookList_RoutesToHandleRunbook', async () => {
      // Arrange
      const expected = successResult([{ id: 'task-completion', phase: 'delegate', description: 'Complete a task', stepCount: 3 }]);
      vi.mocked(handleRunbook).mockResolvedValue(expected);
      const args = { action: 'runbook', phase: 'delegate' };

      // Act
      const result = await handleOrchestrate(args, CTX);

      // Assert
      expect(result).toBe(expected);
      expect(handleRunbook).toHaveBeenCalledWith({ phase: 'delegate' });
    });

    it('HandleOrchestrate_RunbookDetail_RoutesToHandleRunbook', async () => {
      // Arrange
      const expected = successResult({ id: 'task-completion', steps: [] });
      vi.mocked(handleRunbook).mockResolvedValue(expected);
      const args = { action: 'runbook', id: 'task-completion' };

      // Act
      const result = await handleOrchestrate(args, CTX);

      // Assert
      expect(result).toBe(expected);
      expect(handleRunbook).toHaveBeenCalledWith({ id: 'task-completion' });
    });
  });

  // ─── Oneshot + Pruning Actions ───────────────────────────────────────────

  describe('oneshot and pruning actions', () => {
    it('compositeHandler_pruneStaleWorkflowsAction_dispatches', async () => {
      // Arrange
      const expected = successResult({ candidates: [], skipped: [], pruned: [] });
      vi.mocked(handlePruneStaleWorkflows).mockResolvedValue(expected);
      const args = {
        action: 'prune_stale_workflows',
        thresholdMinutes: 10080,
        dryRun: true,
        includeOneShot: false,
      };

      // Act
      const result = await handleOrchestrate(args, CTX);

      // Assert — handler is registered directly so it receives (args, stateDir, ctx)
      expect(result).toBe(expected);
      expect(handlePruneStaleWorkflows).toHaveBeenCalledTimes(1);
      const call = vi.mocked(handlePruneStaleWorkflows).mock.calls[0];
      expect(call[0]).toEqual({
        thresholdMinutes: 10080,
        dryRun: true,
        includeOneShot: false,
      });
      expect(call[1]).toBe(STATE_DIR);
      expect(call[2]).toBe(CTX);
    });

    it('compositeHandler_requestSynthesizeAction_dispatches', async () => {
      // Arrange
      const expected = successResult({ eventAppended: true });
      vi.mocked(handleRequestSynthesize).mockResolvedValue(expected);
      const args = {
        action: 'request_synthesize',
        featureId: 'feat-oneshot-1',
        reason: 'user requested PR review',
      };

      // Act
      const result = await handleOrchestrate(args, CTX);

      // Assert — adapter injects both stateDir and eventStore from ctx
      // into args, matching the finalize_oneshot pattern. The stateDir
      // injection replaces the old hardcoded `.exarchos/state/...`
      // fallback inside the handler.
      expect(result).toBe(expected);
      expect(handleRequestSynthesize).toHaveBeenCalledTimes(1);
      const call = vi.mocked(handleRequestSynthesize).mock.calls[0][0];
      expect(call.featureId).toBe('feat-oneshot-1');
      expect(call.reason).toBe('user requested PR review');
      expect(call.eventStore).toBe(CTX.eventStore);
      expect(call.stateDir).toBe(STATE_DIR);
    });

    it('compositeHandler_finalizeOneshotAction_dispatches', async () => {
      // Arrange
      const expected = successResult({
        featureId: 'feat-oneshot-2',
        previousPhase: 'implementing',
        newPhase: 'completed',
      });
      vi.mocked(handleFinalizeOneshot).mockResolvedValue(expected);
      const args = {
        action: 'finalize_oneshot',
        featureId: 'feat-oneshot-2',
      };

      // Act
      const result = await handleOrchestrate(args, CTX);

      // Assert — adapter injects BOTH stateDir and eventStore from ctx into args
      expect(result).toBe(expected);
      expect(handleFinalizeOneshot).toHaveBeenCalledTimes(1);
      const call = vi.mocked(handleFinalizeOneshot).mock.calls[0][0];
      expect(call.featureId).toBe('feat-oneshot-2');
      expect(call.stateDir).toBe(STATE_DIR);
      expect(call.eventStore).toBe(CTX.eventStore);
    });
  });

  // ─── Doctor Routing ─────────────────────────────────────────────────────

  describe('doctor routing', () => {
    it('OrchestrateComposite_DispatchDoctorAction_InvokesHandleDoctor', async () => {
      // Arrange
      const expected = successResult({
        checks: [],
        summary: { passed: 0, warnings: 0, failed: 0, skipped: 0 },
      });
      vi.mocked(handleDoctor).mockResolvedValue(expected);
      const args = { action: 'doctor', timeoutMs: 1500 };

      // Act
      const result = await handleOrchestrate(args, CTX);

      // Assert — doctor handler called with args (minus the action) and ctx
      expect(result).toBe(expected);
      expect(handleDoctor).toHaveBeenCalledTimes(1);
      const call = vi.mocked(handleDoctor).mock.calls[0];
      expect(call[0]).toEqual({ timeoutMs: 1500 });
      expect(call[1]).toBe(CTX);
    });

    it('OrchestrateRegistry_ActionList_IncludesDoctor', () => {
      // Arrange — the orchestrate action registry is the single source of
      // truth consulted by dispatch-level validation; doctor must be in it
      // for `exarchos_orchestrate { action: "doctor" }` to pass schema gate.
      const orchestrate = TOOL_REGISTRY.find((t) => t.name === 'exarchos_orchestrate');
      expect(orchestrate).toBeDefined();

      // Assert
      const actionNames = orchestrate!.actions.map((a) => a.name);
      expect(actionNames).toContain('doctor');
    });
  });

  // ─── Init Routing ──────────────────────────────────────────────────────

  describe('init routing', () => {
    it('OrchestrateComposite_DispatchInitAction_InvokesHandleInit', async () => {
      // Arrange
      const expected = successResult({
        runtimes: [],
        vcs: null,
        durationMs: 42,
      });
      vi.mocked(handleInit).mockResolvedValue(expected);
      const args = { action: 'init', runtime: 'copilot', nonInteractive: true };

      // Act
      const result = await handleOrchestrate(args, CTX);

      // Assert — init handler called with args (minus the action) and ctx
      expect(result).toBe(expected);
      expect(handleInit).toHaveBeenCalledTimes(1);
      const call = vi.mocked(handleInit).mock.calls[0];
      expect(call[0]).toEqual({ runtime: 'copilot', nonInteractive: true });
      expect(call[1]).toBe(CTX);
    });

    it('OrchestrateRegistry_ActionList_IncludesInit', () => {
      // Arrange — the orchestrate action registry is the single source of
      // truth consulted by dispatch-level validation; init must be in it
      // for `exarchos_orchestrate { action: "init" }` to pass schema gate.
      const orchestrate = TOOL_REGISTRY.find((t) => t.name === 'exarchos_orchestrate');
      expect(orchestrate).toBeDefined();

      // Assert
      const actionNames = orchestrate!.actions.map((a) => a.name);
      expect(actionNames).toContain('init');
    });
  });

  // ─── Error Handling ─────────────────────────────────────────────────────

  describe('error handling', () => {
    it('handleOrchestrate_UnknownAction_ReturnsError', async () => {
      // Arrange
      const args = { action: 'unknown_action' };

      // Act
      const result = await handleOrchestrate(args, CTX);

      // Assert
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('UNKNOWN_ACTION');
      expect(result.error?.message).toContain('unknown_action');
    });
  });
});
