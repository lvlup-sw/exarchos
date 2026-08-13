import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { DispatchContext } from '../../../../src/dispatch/core/dispatch.js';
import { EventStore } from '../../../../src/events/store.js';
import { deriveRepoKey } from '../../../../src/utils/paths.js';

// Mock the view tools module
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

// Mock the stack tools module
vi.mock('../../../../src/stack/tools.js', () => ({
  handleStackStatus: vi.fn(),
  handleStackPlace: vi.fn(),
}));

// Mock the telemetry tools module
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
import { handleStackStatus, handleStackPlace } from '../../../../src/stack/tools.js';
import { handleViewTelemetry } from '../../../../src/projections/telemetry/tools.js';

// Real (un-mocked) surfaces for the DR-7 launcher-liveness `ps` test: the
// `ps`/`wait` view actions route to the REAL worktree handlers (only `./tools.js`,
// `../stack/tools.js`, `../telemetry/tools.js` are mocked above), so `handleView`
// exercises the genuine `worktrees@v1` fold over a real EventStore.
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
    it('should delegate to handleViewPipeline', async () => {
      // Arrange
      const expected = { success: true, data: { workflows: [], total: 0 } };
      vi.mocked(handleViewPipeline).mockResolvedValue(expected);
      const args = { action: 'pipeline', limit: 10, offset: 0 };

      // Act
      const result = await handleView(args, CTX);

      // Assert — T039: successful responses are wrapped in Envelope<T>
      expect(result.success).toBe(true);
      expect(result.data).toEqual({ workflows: [], total: 0 });
      expect((result as Record<string, unknown>).next_actions).toEqual([]);
      // DR-6 oracle update (intentional): the composite now threads a 5th arg —
      // the memoized caller repo key `deriveRepoKey(ctx.cwd ?? process.cwd())`.
      // CTX carries no `cwd`, so it resolves the serving process's repo key
      // (mirrors `workflow/composite.ts` threading the same key into handleInit).
      expect(handleViewPipeline).toHaveBeenCalledWith(
        { limit: 10, offset: 0 },
        STATE_DIR,
        CTX.eventStore,
        // DR-3 — the composite threads `ctx.config` (undefined here) so the
        // measured-size summary can resolve `qualityHints.outputTokenThreshold`.
        CTX.config,
        deriveRepoKey(process.cwd()),
      );
    }, 20000);
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
      const result = await handleView(args, CTX);

      // Assert — T039: envelope wrapping
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
      // Arrange
      const expected = { success: true, data: { phase: 'delegate' } };
      vi.mocked(handleViewWorkflowStatus).mockResolvedValue(expected);
      const args = { action: 'workflow_status', workflowId: 'wf-2' };

      // Act
      const result = await handleView(args, CTX);

      // Assert — T039: envelope wrapping
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
      // Arrange
      const args = { action: 'team_status', workflowId: 'wf-3' };

      // Act
      const result = await handleView(args, CTX);

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
      const result = await handleView(args, CTX);

      // Assert — T039: envelope wrapping
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
      const result = await handleView(args, CTX);

      // Assert — T039: envelope wrapping
      expect(result.success).toBe(true);
      expect(result.data).toEqual({ streamId: 's1', sequence: 1, type: 'stack.position-filled' });
      expect((result as Record<string, unknown>).next_actions).toEqual([]);
      expect(handleStackPlace).toHaveBeenCalledWith(
        {
          streamId: 'stream-1',
          position: 2,
          taskId: 'task-A',
          branch: 'feat/foo',
          prUrl: 'https://github.com/org/repo/pull/1',
        },
        STATE_DIR,
        CTX.eventStore,
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
      const result = await handleView(args, CTX);

      // Assert — T039: envelope wrapping
      expect(result.success).toBe(true);
      expect(result.data).toEqual({ session: { totalInvocations: 5 }, tools: [], hints: [] });
      expect((result as Record<string, unknown>).next_actions).toEqual([]);
      expect(handleViewTelemetry).toHaveBeenCalledWith(
        { compact: true, tool: 'workflow_get' },
        STATE_DIR,
        CTX.eventStore,
        // #1262 — `ctx.config` is threaded through so the
        // `qualityHints.outputTokenThreshold` setting reaches the hint
        // generator. The test CTX above doesn't populate config, so
        // `undefined` is the expected fourth argument.
        undefined,
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
      const result = await handleView(args, CTX);

      // Assert — T039: envelope wrapping
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
      // Arrange
      const expected = {
        success: true,
        data: { featureId: '', tasks: [], bottleneck: null },
      };
      vi.mocked(handleViewDelegationTimeline).mockResolvedValue(expected);
      const args = { action: 'delegation_timeline', workflowId: 'test' };

      // Act
      const result = await handleView(args, CTX);

      // Assert — T039: envelope wrapping
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
      // Arrange
      const expected = {
        success: true,
        data: { skills: {}, gates: {}, regressions: [], benchmarks: [] },
      };
      vi.mocked(handleViewCodeQuality).mockResolvedValue(expected);
      const args = { action: 'code_quality', workflowId: 'wf-5' };

      // Act
      const result = await handleView(args, CTX);

      // Assert — T039: envelope wrapping
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
      const result = await handleView(args, CTX);

      // Assert — T039: envelope wrapping
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
      const result = await handleView(args, CTX);

      // Assert — T039: envelope wrapping
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
      // Arrange
      const expected = {
        success: true,
        data: { hints: [], generatedAt: '2024-01-01T00:00:00.000Z' },
      };
      vi.mocked(handleViewQualityHints).mockResolvedValue(expected);
      const args = { action: 'quality_hints' };

      // Act
      const result = await handleView(args, CTX);

      // Assert — T039: envelope wrapping (data field unwraps to original payload)
      expect(result.success).toBe(true);
      expect((result as Record<string, unknown>).next_actions).toEqual([]);
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
      const result = await handleView(args, CTX);

      // Assert — T039: envelope wrapping
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
      // Arrange
      const expected = {
        success: true,
        data: { skills: { delegation: { skill: 'delegation', gatePassRate: 0.9, evalScore: 0.85, evalTrend: 'stable', qualityTrend: 'stable', regressionCount: 0 } } },
      };
      vi.mocked(handleViewQualityCorrelation).mockResolvedValue(expected);
      const args = { action: 'quality_correlation', workflowId: 'corr-wf' };

      // Act
      const result = await handleView(args, CTX);

      // Assert — T039: envelope wrapping
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
      // Arrange
      const expected = {
        success: true,
        data: { skills: {} },
      };
      vi.mocked(handleViewQualityCorrelation).mockResolvedValue(expected);
      const args = { action: 'quality_correlation' };

      // Act
      const result = await handleView(args, CTX);

      // Assert — T039: envelope wrapping
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
      // Arrange — handler returns ToolResult { success, data }; envelope wraps data
      const payload = {
        sessionId: 'sess-1',
        tools: { Read: 5 },
        toolsByCategory: { native: 5, mcp_exarchos: 0, mcp_other: 0 },
        tokens: { in: 1000, out: 500, cacheR: 200, cacheW: 100 },
      };
      vi.mocked(handleViewSessionProvenance).mockResolvedValue({ success: true, data: payload });
      const args = { action: 'session_provenance', sessionId: 'sess-1' };

      // Act
      const result = await handleView(args, CTX);

      // Assert — T039: envelope wrapping
      expect(result.success).toBe(true);
      expect(result.data).toEqual(payload);
      expect((result as Record<string, unknown>).next_actions).toEqual([]);
      expect(handleViewSessionProvenance).toHaveBeenCalledWith(
        { sessionId: 'sess-1' },
        STATE_DIR,
      );
    });

    it('exarchosView_SessionProvenance_ByWorkflow_ReturnsAggregatedData', async () => {
      // Arrange — handler returns ToolResult { success, data }; envelope wraps data
      const payload = {
        workflowId: 'wf-1',
        sessions: 3,
        tokens: { in: 5000, out: 2500, cacheR: 1000, cacheW: 500 },
      };
      vi.mocked(handleViewSessionProvenance).mockResolvedValue({ success: true, data: payload });
      const args = { action: 'session_provenance', workflowId: 'wf-1' };

      // Act
      const result = await handleView(args, CTX);

      // Assert — T039: envelope wrapping
      expect(result.success).toBe(true);
      expect(result.data).toEqual(payload);
      expect((result as Record<string, unknown>).next_actions).toEqual([]);
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
      const result = await handleView(args, CTX);

      // Assert
      expect(result).toBe(expected);
      expect(handleViewSessionProvenance).toHaveBeenCalledWith(
        {},
        STATE_DIR,
      );
    });
  });

  describe('delegation_readiness', () => {
    it('HandleView_DelegationReadiness_RoutesToHandler', async () => {
      // Arrange
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

      // Act
      const result = await handleView(args, CTX);

      // Assert — T039: envelope wrapping
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
      // Arrange
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

      // Act
      const result = await handleView(args, CTX);

      // Assert — T039: envelope wrapping
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
      // Arrange
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

      // Act
      const result = await handleView(args, CTX);

      // Assert — T039: envelope wrapping
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
      // Arrange
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

      // Act
      const result = await handleView(args, CTX);

      // Assert — T039: envelope wrapping
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
      // Arrange
      const args = { action: 'nonexistent' };

      // Act
      const result = await handleView(args, CTX);

      // Assert
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
      // Arrange
      const args = { action: 'nonexistent' };

      // Act
      const result = await handleView(args, CTX);

      // Assert
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('UNKNOWN_ACTION');
      expect(result.error?.message).toContain('nonexistent');
    });
  });

  describe('quality_attribution', () => {
    it('HandleViewAttribution_ValidQuery_ReturnsAttributionResult', async () => {
      // Arrange
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

      // Act
      const result = await handleView(args, CTX);

      // Assert — T039: envelope wrapping
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
      // Arrange
      const expected = {
        success: false,
        error: {
          code: 'VIEW_ERROR',
          message: 'Invalid attribution dimension: invalid',
        },
      };
      vi.mocked(handleViewQualityAttribution).mockResolvedValue(expected);
      const args = { action: 'quality_attribution', dimension: 'invalid' };

      // Act
      const result = await handleView(args, CTX);

      // Assert
      expect(result.success).toBe(false);
      expect(result.error?.message).toContain('Invalid attribution dimension');
      expect(handleViewQualityAttribution).toHaveBeenCalledWith(
        { dimension: 'invalid' },
        STATE_DIR,
        CTX.eventStore,
      );
    });

    it('HandleViewAttribution_WithSkillFilter_FiltersResults', async () => {
      // Arrange
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

      // Act
      const result = await handleView(args, CTX);

      // Assert — T039: envelope wrapping (data unwraps to original payload)
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
      // Arrange
      const args = {};

      // Act
      const result = await handleView(args, CTX);

      // Assert
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('UNKNOWN_ACTION');
    });
  });

  // ─── Wave 5 / Task 15 (#1437) — describe surfaces correlation filters ─
  //
  // `exarchos_view describe` reads action schemas directly from the
  // registry (TOOL_REGISTRY -> viewActions -> action.schema -> zodToJsonSchema).
  // After Tasks 13 + 14 add the three optional correlation-filter slots to
  // the six telemetry action schemas, this test pins that the JSON schema
  // surface emitted by describe also carries those slots. This is a
  // regression guard: if a future refactor moves an action's schema out of
  // the registry (e.g. inlines it in composite.ts), the slot would silently
  // disappear from describe and break the discoverability contract.
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
      // Act: ask describe to surface schemas for all six telemetry actions
      const args = { action: 'describe', actions: [...TELEMETRY_ACTIONS] };
      const result = await handleView(args, CTX);

      // Assert: envelope success
      expect(result.success).toBe(true);
      const data = result.data as Record<string, unknown>;

      // For each action, the surfaced schema MUST include all three
      // optional correlation-filter slots in its `properties`. The schema
      // shape is JSON-Schema 2020-12 (zodToJsonSchema output) — `properties`
      // is an object whose keys are the field names.
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

    it('describe action surfaces correlation filters as optional (not in required[])', async () => {
      // Defense-in-depth: the correlation filters are optional. If they
      // accidentally became required (e.g. via .nonempty() instead of
      // .optional()), describe would list them in `required[]` and any
      // caller that omitted them would get rejected on dispatch.
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

// ─── DR-7 (Task 018) — launcher-session liveness answered from launch.* events ─
//
// The `ps` view action routes through `projections/views/composite.ts` to the real WLM
// worktree handler (only the `tools.js` / `stack` / `telemetry` modules are
// mocked at the top of this file). This pins the DR-7 contract at the composite
// surface: a launcher-spawned session's liveness is answered from the
// `launch.executing_started` / `launch.executed` event pair ALONE — a pure fold
// of `worktrees@v1`, with NO live process scan — and the composite layer
// surfaces that guarantee as an agent-first `next_actions` affordance.
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

  /** The launcher reserves its top-level worktree FIRST, then the child starts. */
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

  it('psView_LauncherSpawnedSession_AnswersFromLaunchEventsAlone', async () => {
    const ctx = await makeLiveCtx();
    const worktreeId = '/wlm/launch-018-wt';

    // Launcher lifecycle: reserve the top-level worktree, then the child's
    // CLAIM lands via `launch.executing_started` — NOTHING else is written.
    await seedReserved(ctx, worktreeId);
    await emitLaunchExecutingStarted(ctx.eventStore, {
      worktreeId,
      holderPid: 7777,
      holderStartedAt: 'boot-7777',
    });

    // The process table is a spy: without `probe`, `ps` must answer from the
    // folded `launch.*` events ALONE and NEVER enumerate live processes.
    const listSpy = vi.fn((): readonly ProcessRecord[] => []);
    const table: ProcessTableSource = { list: listSpy };

    const inFlight = await handleView({ action: 'ps', scope: 'worktree' }, ctx, {
      processTableSource: table,
      realpath: (p) => p,
    });

    // Envelope success, launch column surfaced straight from the event pair.
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
    // Answered from events ALONE — the ground-truth process table was untouched.
    expect(listSpy).not.toHaveBeenCalled();

    // The composite surfaces the DR-7 liveness guarantee as an agent-first hint.
    const affordances = (inFlight.next_actions ?? []) as ReadonlyArray<{
      verb?: string;
      reason?: string;
    }>;
    const launchHint = affordances.find(
      (a) => a.verb === 'ps' && /launch\.\* events alone/i.test(a.reason ?? ''),
    );
    expect(launchHint, 'ps must surface the launcher-liveness affordance').toBeDefined();

    // The terminal folds → the launch column (and its affordance) clear
    // deterministically, again from events alone (no permanent phantom).
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
