/**
 * Tests for the `exarchos_view` composite router. Mocks replace the view, stack and
 * telemetry tool modules, so most tests assert only the routing and the envelope.
 * The `ps` action reaches the real worktree handler, so its test folds
 * `worktrees@v1` over a real `EventStore`.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { DispatchContext } from '../../../../src/dispatch/core/dispatch.js';
import { EventStore } from '../../../../src/events/store.js';
import { deriveRepoKey } from '../../../../src/utils/paths.js';

vi.mock('../../../../src/projections/views/tools.js', () => ({
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
  handleViewQualityAttribution: vi.fn(),
  handleViewDelegationReadiness: vi.fn(),
  handleViewSynthesisReadiness: vi.fn(),
  handleViewShepherdStatus: vi.fn(),
  handleViewProvenance: vi.fn(),
}));

vi.mock('../../../../src/verbs/stack/tools.js', () => ({
  handleStackStatus: vi.fn(),
  handleStackPlace: vi.fn(),
}));

vi.mock('../../../../src/projections/telemetry/tools.js', () => ({
  handleViewTelemetry: vi.fn(),
}));

import { handleView } from '../../../../src/projections/views/composite.js';
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
  handleViewQualityAttribution,
  handleViewDelegationReadiness,
  handleViewSynthesisReadiness,
  handleViewShepherdStatus,
  handleViewProvenance,
} from '../../../../src/projections/views/tools.js';
import { handleStackStatus, handleStackPlace } from '../../../../src/verbs/stack/tools.js';
import { handleViewTelemetry } from '../../../../src/projections/telemetry/tools.js';

import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as nodePath from 'node:path';
import { rmrfAsync } from '../../../../tools/test-helpers/temp-dir.js';
import { WORKTREES_STREAM } from '../../../../src/verbs/worktree/manager.js';
import {
  emitLaunchExecutingStarted,
  emitLaunchExecuted,
} from '../../../../src/runtime/launcher/liveness.js';
import type { WorktreeEntry } from '../../../../src/verbs/worktree/projections/worktrees.js';
import type {
  ProcessRecord,
  ProcessTableSource,
} from '../../../../src/verbs/worktree/pure/probe.js';

const STATE_DIR = '/tmp/test-state';

function makeCtx(stateDir: string): DispatchContext {
  return { stateDir, eventStore: new EventStore(stateDir), enableTelemetry: false };
}

const CTX = makeCtx(STATE_DIR);

describe('handleView', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  describe('pipeline', () => {
    /**
     * The composite passes `ctx.config` as the fourth argument and the caller repo
     * key as the fifth. `CTX` has no `cwd`, so the key comes from `process.cwd()`.
     */
    it('should delegate to handleViewPipeline', async () => {
      const expected = { success: true, data: { workflows: [], total: 0 } };
      vi.mocked(handleViewPipeline).mockResolvedValue(expected);
      const args = { action: 'pipeline', limit: 10, offset: 0 };

      const result = await handleView(args, CTX);

      expect(result.success).toBe(true);
      expect(result.data).toEqual({ workflows: [], total: 0 });
      expect((result as Record<string, unknown>).next_actions).toEqual([]);
      expect(handleViewPipeline).toHaveBeenCalledWith(
        { limit: 10, offset: 0 },
        STATE_DIR,
        CTX.eventStore,
        CTX.config,
        deriveRepoKey(process.cwd()),
      );
    }, 20000);
  });

  describe('tasks', () => {
    it('should delegate to handleViewTasks', async () => {
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

      const result = await handleView(args, CTX);

      expect(result.success).toBe(true);
      expect(result.data).toEqual([]);
      expect((result as Record<string, unknown>).next_actions).toEqual([]);
      expect(handleViewTasks).toHaveBeenCalledWith(
        {
          workflowId: 'wf-1',
          filter: { status: 'done' },
          limit: 5,
          offset: 2,
          fields: ['taskId', 'status'],
        },
        STATE_DIR,
        CTX.eventStore,
      );
    });
  });

  describe('workflow_status', () => {
    it('should delegate to handleViewWorkflowStatus', async () => {
      const expected = { success: true, data: { phase: 'delegate' } };
      vi.mocked(handleViewWorkflowStatus).mockResolvedValue(expected);
      const args = { action: 'workflow_status', workflowId: 'wf-2' };

      const result = await handleView(args, CTX);

      expect(result.success).toBe(true);
      expect(result.data).toEqual({ phase: 'delegate' });
      expect((result as Record<string, unknown>).next_actions).toEqual([]);
      expect(handleViewWorkflowStatus).toHaveBeenCalledWith(
        { workflowId: 'wf-2' },
        STATE_DIR,
        CTX.eventStore,
      );
    });
  });

  describe('removed team_status', () => {
    it('should return UNKNOWN_ACTION for team_status', async () => {
      const args = { action: 'team_status', workflowId: 'wf-3' };

      const result = await handleView(args, CTX);

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('UNKNOWN_ACTION');
    });
  });

  describe('stack_status', () => {
    it('should delegate to handleStackStatus', async () => {
      const expected = { success: true, data: [] };
      vi.mocked(handleStackStatus).mockResolvedValue(expected);
      const args = {
        action: 'stack_status',
        streamId: 'stream-1',
        limit: 3,
        offset: 1,
      };

      const result = await handleView(args, CTX);

      expect(result.success).toBe(true);
      expect(result.data).toEqual([]);
      expect((result as Record<string, unknown>).next_actions).toEqual([]);
      expect(handleStackStatus).toHaveBeenCalledWith(
        { streamId: 'stream-1', limit: 3, offset: 1 },
        STATE_DIR,
        CTX.eventStore,
      );
    });
  });

  describe('stack_place', () => {
    /**
     * `stack_place` appends `stack.position-filled`, so it is an `exarchos_orchestrate`
     * action and not a view action. The view router must not reach the writer.
     * `tests/unit/registry.test.ts` requires a handler route for each registered
     * action, so this file does not repeat that check.
     */
    it('ViewComposite_StackPlace_NoLongerRouted', async () => {
      const args = {
        action: 'stack_place',
        streamId: 'stream-1',
        position: 2,
        taskId: 'task-A',
      };

      const result = await handleView(args, CTX);

      expect(result.success).toBe(false);
      expect(handleStackPlace).not.toHaveBeenCalled();
    });
  });

  describe('telemetry', () => {
    /** The composite passes `ctx.config` as the fourth argument. `CTX` has no config, so the argument is `undefined`. */
    it('should delegate to handleViewTelemetry', async () => {
      const expected = {
        success: true,
        data: { session: { totalInvocations: 5 }, tools: [], hints: [] },
      };
      vi.mocked(handleViewTelemetry).mockResolvedValue(expected);
      const args = { action: 'telemetry', compact: true, tool: 'workflow_get' };

      const result = await handleView(args, CTX);

      expect(result.success).toBe(true);
      expect(result.data).toEqual({ session: { totalInvocations: 5 }, tools: [], hints: [] });
      expect((result as Record<string, unknown>).next_actions).toEqual([]);
      expect(handleViewTelemetry).toHaveBeenCalledWith(
        { compact: true, tool: 'workflow_get' },
        STATE_DIR,
        CTX.eventStore,
        undefined,
      );
    });
  });

  describe('team_performance', () => {
    it('handleView_TeamPerformanceAction_DispatchesToHandler', async () => {
      const expected = {
        success: true,
        data: { teammates: {}, modules: {}, teamSizing: { avgTasksPerTeammate: 0, dataPoints: 0 } },
      };
      vi.mocked(handleViewTeamPerformance).mockResolvedValue(expected);
      const args = { action: 'team_performance', workflowId: 'wf-4' };

      const result = await handleView(args, CTX);

      expect(result.success).toBe(true);
      expect(result.data).toEqual({ teammates: {}, modules: {}, teamSizing: { avgTasksPerTeammate: 0, dataPoints: 0 } });
      expect((result as Record<string, unknown>).next_actions).toEqual([]);
      expect(handleViewTeamPerformance).toHaveBeenCalledWith(
        { workflowId: 'wf-4' },
        STATE_DIR,
        CTX.eventStore,
      );
    });
  });

  describe('delegation_timeline', () => {
    it('handleView_DelegationTimelineAction_DispatchesToHandler', async () => {
      const expected = {
        success: true,
        data: { featureId: '', tasks: [], bottleneck: null },
      };
      vi.mocked(handleViewDelegationTimeline).mockResolvedValue(expected);
      const args = { action: 'delegation_timeline', workflowId: 'test' };

      const result = await handleView(args, CTX);

      expect(result.success).toBe(true);
      expect(result.data).toEqual({ featureId: '', tasks: [], bottleneck: null });
      expect((result as Record<string, unknown>).next_actions).toEqual([]);
      expect(handleViewDelegationTimeline).toHaveBeenCalledWith(
        { workflowId: 'test' },
        STATE_DIR,
        CTX.eventStore,
      );
    });
  });

  describe('code_quality', () => {
    it('HandleView_CodeQuality_RoutesToHandler', async () => {
      const expected = {
        success: true,
        data: { skills: {}, gates: {}, regressions: [], benchmarks: [] },
      };
      vi.mocked(handleViewCodeQuality).mockResolvedValue(expected);
      const args = { action: 'code_quality', workflowId: 'wf-5' };

      const result = await handleView(args, CTX);

      expect(result.success).toBe(true);
      expect(result.data).toEqual({ skills: {}, gates: {}, regressions: [], benchmarks: [] });
      expect((result as Record<string, unknown>).next_actions).toEqual([]);
      expect(handleViewCodeQuality).toHaveBeenCalledWith(
        { workflowId: 'wf-5' },
        STATE_DIR,
        CTX.eventStore,
      );
    });
  });

  describe('quality_hints', () => {
    it('handleView_QualityHintsAction_ReturnsHints', async () => {
      const expected = {
        success: true,
        data: {
          hints: [{ skill: 'my-skill', category: 'gate', severity: 'warning', hint: 'test hint' }],
          generatedAt: '2024-01-01T00:00:00.000Z',
        },
      };
      vi.mocked(handleViewQualityHints).mockResolvedValue(expected);
      const args = { action: 'quality_hints', workflowId: 'wf-6' };

      const result = await handleView(args, CTX);

      expect(result.success).toBe(true);
      expect(result.data).toEqual({
        hints: [{ skill: 'my-skill', category: 'gate', severity: 'warning', hint: 'test hint' }],
        generatedAt: '2024-01-01T00:00:00.000Z',
      });
      expect((result as Record<string, unknown>).next_actions).toEqual([]);
      expect(handleViewQualityHints).toHaveBeenCalledWith(
        { workflowId: 'wf-6' },
        STATE_DIR,
        CTX.eventStore,
      );
    });

    it('handleView_QualityHintsWithSkillFilter_ReturnsFilteredHints', async () => {
      const expected = {
        success: true,
        data: {
          hints: [{ skill: 'target-skill', category: 'gate', severity: 'warning', hint: 'filtered hint' }],
          generatedAt: '2024-01-01T00:00:00.000Z',
        },
      };
      vi.mocked(handleViewQualityHints).mockResolvedValue(expected);
      const args = { action: 'quality_hints', workflowId: 'wf-7', skill: 'target-skill' };

      const result = await handleView(args, CTX);

      expect(result.success).toBe(true);
      expect(result.data).toEqual({
        hints: [{ skill: 'target-skill', category: 'gate', severity: 'warning', hint: 'filtered hint' }],
        generatedAt: '2024-01-01T00:00:00.000Z',
      });
      expect((result as Record<string, unknown>).next_actions).toEqual([]);
      expect(handleViewQualityHints).toHaveBeenCalledWith(
        { workflowId: 'wf-7', skill: 'target-skill' },
        STATE_DIR,
        CTX.eventStore,
      );
    });

    it('handleView_QualityHintsNoData_ReturnsEmptyArray', async () => {
      const expected = {
        success: true,
        data: { hints: [], generatedAt: '2024-01-01T00:00:00.000Z' },
      };
      vi.mocked(handleViewQualityHints).mockResolvedValue(expected);
      const args = { action: 'quality_hints' };

      const result = await handleView(args, CTX);

      expect(result.success).toBe(true);
      expect((result as Record<string, unknown>).next_actions).toEqual([]);
      expect((result.data as { hints: unknown[] }).hints).toEqual([]);
    });
  });

  describe('eval_results', () => {
    it('handleView_EvalResultsAction_DispatchesToHandler', async () => {
      const expected = {
        success: true,
        data: { skills: {}, runs: [], regressions: [] },
      };
      vi.mocked(handleViewEvalResults).mockResolvedValue(expected);
      const args = { action: 'eval_results', workflowId: 'eval-wf', skill: 'delegation', limit: 5 };

      const result = await handleView(args, CTX);

      expect(result.success).toBe(true);
      expect(result.data).toEqual({ skills: {}, runs: [], regressions: [] });
      expect((result as Record<string, unknown>).next_actions).toEqual([]);
      expect(handleViewEvalResults).toHaveBeenCalledWith(
        { workflowId: 'eval-wf', skill: 'delegation', limit: 5 },
        STATE_DIR,
        CTX.eventStore,
      );
    });
  });

  describe('quality_correlation', () => {
    it('HandleView_QualityCorrelation_DispatchesToHandler', async () => {
      const expected = {
        success: true,
        data: { skills: { delegation: { skill: 'delegation', gatePassRate: 0.9, evalScore: 0.85, evalTrend: 'stable', qualityTrend: 'stable', regressionCount: 0 } } },
      };
      vi.mocked(handleViewQualityCorrelation).mockResolvedValue(expected);
      const args = { action: 'quality_correlation', workflowId: 'corr-wf' };

      const result = await handleView(args, CTX);

      expect(result.success).toBe(true);
      expect(result.data).toEqual({ skills: { delegation: { skill: 'delegation', gatePassRate: 0.9, evalScore: 0.85, evalTrend: 'stable', qualityTrend: 'stable', regressionCount: 0 } } });
      expect((result as Record<string, unknown>).next_actions).toEqual([]);
      expect(handleViewQualityCorrelation).toHaveBeenCalledWith(
        { workflowId: 'corr-wf' },
        STATE_DIR,
        CTX.eventStore,
      );
    });

    it('HandleView_QualityCorrelation_NoWorkflowId_DelegatesWithoutIt', async () => {
      const expected = {
        success: true,
        data: { skills: {} },
      };
      vi.mocked(handleViewQualityCorrelation).mockResolvedValue(expected);
      const args = { action: 'quality_correlation' };

      const result = await handleView(args, CTX);

      expect(result.success).toBe(true);
      expect(result.data).toEqual({ skills: {} });
      expect((result as Record<string, unknown>).next_actions).toEqual([]);
      expect(handleViewQualityCorrelation).toHaveBeenCalledWith(
        {},
        STATE_DIR,
        CTX.eventStore,
      );
    });
  });

  describe('session_provenance', () => {
    it('exarchosView_SessionProvenance_BySession_ReturnsSessionData', async () => {
      const payload = {
        sessionId: 'sess-1',
        tools: { Read: 5 },
        toolsByCategory: { native: 5, mcp_exarchos: 0, mcp_other: 0 },
        tokens: { in: 1000, out: 500, cacheR: 200, cacheW: 100 },
      };
      vi.mocked(handleViewSessionProvenance).mockResolvedValue({ success: true, data: payload });
      const args = { action: 'session_provenance', sessionId: 'sess-1' };

      const result = await handleView(args, CTX);

      expect(result.success).toBe(true);
      expect(result.data).toEqual(payload);
      expect((result as Record<string, unknown>).next_actions).toEqual([]);
      expect(handleViewSessionProvenance).toHaveBeenCalledWith(
        { sessionId: 'sess-1' },
        STATE_DIR,
      );
    });

    it('exarchosView_SessionProvenance_ByWorkflow_ReturnsAggregatedData', async () => {
      const payload = {
        workflowId: 'wf-1',
        sessions: 3,
        tokens: { in: 5000, out: 2500, cacheR: 1000, cacheW: 500 },
      };
      vi.mocked(handleViewSessionProvenance).mockResolvedValue({ success: true, data: payload });
      const args = { action: 'session_provenance', workflowId: 'wf-1' };

      const result = await handleView(args, CTX);

      expect(result.success).toBe(true);
      expect(result.data).toEqual(payload);
      expect((result as Record<string, unknown>).next_actions).toEqual([]);
      expect(handleViewSessionProvenance).toHaveBeenCalledWith(
        { workflowId: 'wf-1' },
        STATE_DIR,
      );
    });

    it('exarchosView_SessionProvenance_InvalidQuery_ReturnsError', async () => {
      const expected = {
        success: false,
        error: { code: 'INVALID_QUERY', message: 'Either sessionId or workflowId is required' },
      };
      vi.mocked(handleViewSessionProvenance).mockResolvedValue(expected);
      const args = { action: 'session_provenance' };

      const result = await handleView(args, CTX);

      expect(result).toBe(expected);
      expect(handleViewSessionProvenance).toHaveBeenCalledWith(
        {},
        STATE_DIR,
      );
    });
  });

  describe('delegation_readiness', () => {
    it('HandleView_DelegationReadiness_RoutesToHandler', async () => {
      const expected = {
        success: true,
        data: {
          ready: false,
          blockers: ['Plan not yet approved'],
          plan: { approved: false, taskCount: 0 },
          quality: { queried: false, gatePassRate: 0, regressions: 0 },
          worktrees: { expected: 0, ready: 0, failed: 0 },
        },
      };
      vi.mocked(handleViewDelegationReadiness).mockResolvedValue(expected);
      const args = { action: 'delegation_readiness', workflowId: 'wf-dr' };

      const result = await handleView(args, CTX);

      expect(result.success).toBe(true);
      expect(result.data).toEqual({
        ready: false,
        blockers: ['Plan not yet approved'],
        plan: { approved: false, taskCount: 0 },
        quality: { queried: false, gatePassRate: 0, regressions: 0 },
        worktrees: { expected: 0, ready: 0, failed: 0 },
      });
      expect((result as Record<string, unknown>).next_actions).toEqual([]);
      expect(handleViewDelegationReadiness).toHaveBeenCalledWith(
        { workflowId: 'wf-dr' },
        STATE_DIR,
        CTX.eventStore,
      );
    });
  });

  describe('synthesis_readiness', () => {
    it('HandleView_SynthesisReadiness_RoutesToHandler', async () => {
      const expected = {
        success: true,
        data: {
          ready: false,
          blockers: ['No tasks assigned'],
          tasks: { total: 0, completed: 0, failed: 0 },
          review: { specPassed: false, qualityPassed: false, findingsBySeverity: {} },
          tests: { lastRunPassed: false, typecheckPassed: false, coveragePercent: 0 },
          stack: { restacked: false, conflicts: 0 },
        },
      };
      vi.mocked(handleViewSynthesisReadiness).mockResolvedValue(expected);
      const args = { action: 'synthesis_readiness', workflowId: 'wf-sr' };

      const result = await handleView(args, CTX);

      expect(result.success).toBe(true);
      expect(result.data).toEqual({
        ready: false,
        blockers: ['No tasks assigned'],
        tasks: { total: 0, completed: 0, failed: 0 },
        review: { specPassed: false, qualityPassed: false, findingsBySeverity: {} },
        tests: { lastRunPassed: false, typecheckPassed: false, coveragePercent: 0 },
        stack: { restacked: false, conflicts: 0 },
      });
      expect((result as Record<string, unknown>).next_actions).toEqual([]);
      expect(handleViewSynthesisReadiness).toHaveBeenCalledWith(
        { workflowId: 'wf-sr' },
        STATE_DIR,
        CTX.eventStore,
      );
    });
  });

  describe('shepherd_status', () => {
    it('HandleView_ShepherdStatus_RoutesToHandler', async () => {
      const expected = {
        success: true,
        data: {
          overallStatus: 'unknown',
          prs: [],
          iteration: 0,
          maxIterations: 5,
        },
      };
      vi.mocked(handleViewShepherdStatus).mockResolvedValue(expected);
      const args = { action: 'shepherd_status', workflowId: 'wf-ss' };

      const result = await handleView(args, CTX);

      expect(result.success).toBe(true);
      expect(result.data).toEqual({
        overallStatus: 'unknown',
        prs: [],
        iteration: 0,
        maxIterations: 5,
      });
      expect((result as Record<string, unknown>).next_actions).toEqual([]);
      expect(handleViewShepherdStatus).toHaveBeenCalledWith(
        { workflowId: 'wf-ss' },
        STATE_DIR,
        CTX.eventStore,
      );
    });
  });

  describe('provenance', () => {
    it('handleView_Provenance_DelegatesToHandler', async () => {
      const expected = {
        success: true,
        data: {
          featureId: '',
          requirements: [],
          coverage: 0,
          orphanTasks: [],
        },
      };
      vi.mocked(handleViewProvenance).mockResolvedValue(expected);
      const args = { action: 'provenance', workflowId: 'test-id' };

      const result = await handleView(args, CTX);

      expect(result.success).toBe(true);
      expect(result.data).toEqual({
        featureId: '',
        requirements: [],
        coverage: 0,
        orphanTasks: [],
      });
      expect((result as Record<string, unknown>).next_actions).toEqual([]);
      expect(handleViewProvenance).toHaveBeenCalledWith(
        { workflowId: 'test-id' },
        STATE_DIR,
        CTX.eventStore,
      );
    });
  });

  describe('unknown action', () => {
    it('HandleView_UnknownAction_IncludesAllViewActions', async () => {
      const args = { action: 'nonexistent' };

      const result = await handleView(args, CTX);

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('UNKNOWN_ACTION');
      const validTargets = (result.error as Record<string, unknown>)?.validTargets as string[];
      expect(validTargets).toContain('code_quality');
      expect(validTargets).toContain('quality_hints');
      expect(validTargets).toContain('eval_results');
      expect(validTargets).toContain('quality_correlation');
      expect(validTargets).toContain('session_provenance');
      expect(validTargets).toContain('delegation_readiness');
      expect(validTargets).toContain('synthesis_readiness');
      expect(validTargets).toContain('shepherd_status');
      expect(validTargets).toContain('provenance');
    });

    it('should return error for unknown action', async () => {
      const args = { action: 'nonexistent' };

      const result = await handleView(args, CTX);

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('UNKNOWN_ACTION');
      expect(result.error?.message).toContain('nonexistent');
    });
  });

  describe('quality_attribution', () => {
    it('HandleViewAttribution_ValidQuery_ReturnsAttributionResult', async () => {
      const expected = {
        success: true,
        data: {
          dimension: 'skill',
          entries: [
            { name: 'delegation', dimension: 'skill', contribution: 0.67, passRate: 0.9, executionCount: 20 },
          ],
          totalExecutions: 30,
        },
      };
      vi.mocked(handleViewQualityAttribution).mockResolvedValue(expected);
      const args = { action: 'quality_attribution', workflowId: 'test-wf', dimension: 'skill' };

      const result = await handleView(args, CTX);

      expect(result.success).toBe(true);
      expect(result.data).toEqual({
        dimension: 'skill',
        entries: [
          { name: 'delegation', dimension: 'skill', contribution: 0.67, passRate: 0.9, executionCount: 20 },
        ],
        totalExecutions: 30,
      });
      expect((result as Record<string, unknown>).next_actions).toEqual([]);
      expect(handleViewQualityAttribution).toHaveBeenCalledWith(
        { workflowId: 'test-wf', dimension: 'skill' },
        STATE_DIR,
        CTX.eventStore,
      );
    });

    it('HandleViewAttribution_InvalidDimension_ReturnsError', async () => {
      const expected = {
        success: false,
        error: {
          code: 'VIEW_ERROR',
          message: 'Invalid attribution dimension: invalid',
        },
      };
      vi.mocked(handleViewQualityAttribution).mockResolvedValue(expected);
      const args = { action: 'quality_attribution', dimension: 'invalid' };

      const result = await handleView(args, CTX);

      expect(result.success).toBe(false);
      expect(result.error?.message).toContain('Invalid attribution dimension');
      expect(handleViewQualityAttribution).toHaveBeenCalledWith(
        { dimension: 'invalid' },
        STATE_DIR,
        CTX.eventStore,
      );
    });

    it('HandleViewAttribution_WithSkillFilter_FiltersResults', async () => {
      const expected = {
        success: true,
        data: {
          dimension: 'skill',
          entries: [
            { name: 'delegation', dimension: 'skill', contribution: 1.0, passRate: 0.9, executionCount: 20 },
          ],
          totalExecutions: 20,
        },
      };
      vi.mocked(handleViewQualityAttribution).mockResolvedValue(expected);
      const args = { action: 'quality_attribution', workflowId: 'test-wf', dimension: 'skill', skill: 'delegation' };

      const result = await handleView(args, CTX);

      expect(result.success).toBe(true);
      expect((result as Record<string, unknown>).next_actions).toEqual([]);
      const data = result.data as { entries: Array<{ name: string }> };
      expect(data.entries).toHaveLength(1);
      expect(data.entries[0].name).toBe('delegation');
      expect(handleViewQualityAttribution).toHaveBeenCalledWith(
        { workflowId: 'test-wf', dimension: 'skill', skill: 'delegation' },
        STATE_DIR,
        CTX.eventStore,
      );
    });
  });

  describe('missing action', () => {
    it('should return error when action is not provided', async () => {
      const args = {};

      const result = await handleView(args, CTX);

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('UNKNOWN_ACTION');
    });
  });

  /**
   * `describe` reads each action schema from the registry. The six actions in
   * `TELEMETRY_ACTIONS` take three optional correlation filters, and `describe` must show them.
   * If an action schema moves out of the registry, the filters disappear from
   * `describe` with no error.
   */
  describe('Wave 5 — ExarchosViewDescribe_TelemetryActions_ExposeCorrelationFilters', () => {
    const TELEMETRY_ACTIONS = [
      'telemetry',
      'delegation_timeline',
      'code_quality',
      'eval_results',
      'quality_correlation',
      'quality_attribution',
    ] as const;

    it('describe action returns schemas including operationId/correlationId/causationId for all six telemetry actions', async () => {
      const args = { action: 'describe', actions: [...TELEMETRY_ACTIONS] };
      const result = await handleView(args, CTX);

      expect(result.success).toBe(true);
      const data = result.data as Record<string, unknown>;

      for (const actionName of TELEMETRY_ACTIONS) {
        const actionInfo = data[actionName] as Record<string, unknown> | undefined;
        expect(actionInfo, `describe must include action: ${actionName}`).toBeDefined();
        const schema = actionInfo!.schema as { properties?: Record<string, unknown> };
        expect(
          schema,
          `${actionName}.schema must be present`,
        ).toBeDefined();
        const props = schema.properties ?? {};
        expect(
          props,
          `${actionName}.schema.properties must expose operationId`,
        ).toHaveProperty('operationId');
        expect(
          props,
          `${actionName}.schema.properties must expose correlationId`,
        ).toHaveProperty('correlationId');
        expect(
          props,
          `${actionName}.schema.properties must expose causationId`,
        ).toHaveProperty('causationId');
      }
    });

    /** If a correlation filter becomes required, dispatch rejects each caller that omits it. */
    it('describe action surfaces correlation filters as optional (not in required[])', async () => {
      const args = { action: 'describe', actions: [...TELEMETRY_ACTIONS] };
      const result = await handleView(args, CTX);

      expect(result.success).toBe(true);
      const data = result.data as Record<string, unknown>;

      for (const actionName of TELEMETRY_ACTIONS) {
        const actionInfo = data[actionName] as Record<string, unknown> | undefined;
        expect(actionInfo).toBeDefined();
        const schema = actionInfo!.schema as { required?: string[] };
        const required = schema.required ?? [];
        expect(
          required,
          `${actionName}.schema.required must NOT include operationId`,
        ).not.toContain('operationId');
        expect(
          required,
          `${actionName}.schema.required must NOT include correlationId`,
        ).not.toContain('correlationId');
        expect(
          required,
          `${actionName}.schema.required must NOT include causationId`,
        ).not.toContain('causationId');
      }
    });
  });
});

/**
 * The `ps` action reaches the real worktree handler. `ps` answers the liveness of
 * a launcher session from the `launch.executing_started` and `launch.executed`
 * pair in the `worktrees@v1` fold, with no process scan. The composite adds a
 * `next_actions` hint that states this.
 */
describe('ps — launcher-session liveness (DR-7, Task 018)', () => {
  const dirs: string[] = [];

  async function makeLiveCtx(): Promise<DispatchContext> {
    const stateDir = await mkdtemp(nodePath.join(tmpdir(), 'composite-ps-'));
    dirs.push(stateDir);
    const eventStore = new EventStore(stateDir);
    await eventStore.initialize();
    return { stateDir, eventStore, enableTelemetry: false };
  }

  afterEach(async () => {
    while (dirs.length > 0) {
      const d = dirs.pop();
      if (d) await rmrfAsync(d);
    }
  });

  async function seedReserved(ctx: DispatchContext, worktreeId: string): Promise<void> {
    await ctx.eventStore.append(
      WORKTREES_STREAM,
      {
        type: 'worktree.reserved',
        data: {
          worktreeId,
          path: worktreeId,
          featureId: null,
          ownerPid: 4242,
          ownerStartedAt: 'boot-4242',
          operationId: 'op-launch-018',
        },
      },
      { idempotencyKey: 'worktree.reserved:op-launch-018' },
    );
  }

  /**
   * The launcher reserves the worktree first, and then `launch.executing_started`
   * records the claim of the child. Without `probe`, `ps` must not list processes,
   * so the process table is a spy. After `launch.executed`, the launch column and
   * its hint clear.
   */
  it('psView_LauncherSpawnedSession_AnswersFromLaunchEventsAlone', async () => {
    const ctx = await makeLiveCtx();
    const worktreeId = '/wlm/launch-018-wt';

    await seedReserved(ctx, worktreeId);
    await emitLaunchExecutingStarted(ctx.eventStore, {
      worktreeId,
      holderPid: 7777,
      holderStartedAt: 'boot-7777',
    });

    const listSpy = vi.fn((): readonly ProcessRecord[] => []);
    const table: ProcessTableSource = { list: listSpy };

    const inFlight = await handleView({ action: 'ps', scope: 'worktree' }, ctx, {
      processTableSource: table,
      realpath: (p) => p,
    });

    expect(inFlight.success).toBe(true);
    const inFlightData = inFlight.data as {
      launches: WorktreeEntry[];
      launchCount: number;
    };
    expect(inFlightData.launchCount).toBe(1);
    expect(inFlightData.launches[0].worktreeId).toBe(worktreeId);
    expect(inFlightData.launches[0].launch).toEqual({
      holderPid: 7777,
      holderStartedAt: 'boot-7777',
    });
    expect(listSpy).not.toHaveBeenCalled();

    const affordances = (inFlight.next_actions ?? []) as ReadonlyArray<{
      verb?: string;
      reason?: string;
    }>;
    const launchHint = affordances.find(
      (a) => a.verb === 'ps' && /launch\.\* events alone/i.test(a.reason ?? ''),
    );
    expect(launchHint, 'ps must surface the launcher-liveness affordance').toBeDefined();

    await emitLaunchExecuted(ctx.eventStore, { worktreeId, exitCode: 0 });
    const cleared = await handleView({ action: 'ps', scope: 'worktree' }, ctx, { realpath: (p) => p });
    const clearedData = cleared.data as {
      launches: WorktreeEntry[];
      launchCount: number;
    };
    expect(clearedData.launchCount).toBe(0);
    expect(clearedData.launches).toEqual([]);
    const clearedAffordances = (cleared.next_actions ?? []) as ReadonlyArray<{
      verb?: string;
      reason?: string;
    }>;
    expect(
      clearedAffordances.some((a) => /launch\.\* events alone/i.test(a.reason ?? '')),
    ).toBe(false);
  });
});
