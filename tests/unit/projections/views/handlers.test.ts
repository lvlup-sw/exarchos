import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  getOrCreateMaterializer,
  resetMaterializerCache,
  handleViewWorkflowStatus,
  handleViewTasks,
  handleViewPipeline,
  handleViewTeamPerformance,
  handleViewDelegationTimeline,
  handleViewCodeQuality,
  handleViewEvalResults,
  handleViewQualityCorrelation,
  handleViewQualityAttribution,
  handleViewProvenance,
  handleViewSynthesisReadiness,
  handleViewConvergence,
} from '../../../../src/projections/views/tools.js';
import { EventStore } from '../../../../src/events/store.js';
import { TOOL_REGISTRY } from '../../../../src/registry.js';
import { rmrfAsync } from '../../../../tools/test-helpers/temp-dir.js';

describe('Materializer Cache', () => {
  beforeEach(() => {
    resetMaterializerCache();
  });

  it('returns same materializer for same stateDir', () => {
    const mat1 = getOrCreateMaterializer('/tmp/dir-A');
    const mat2 = getOrCreateMaterializer('/tmp/dir-A');
    expect(mat1).toBe(mat2);
  });

  it('creates new materializer when stateDir changes', () => {
    const matA = getOrCreateMaterializer('/tmp/dir-A');
    const matB = getOrCreateMaterializer('/tmp/dir-B');
    expect(matA).not.toBe(matB);
  });
});

describe('View Handlers', () => {
  let tmpDir: string;
  let store: EventStore;

  beforeEach(async () => {
    resetMaterializerCache();
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'exarchos-view-test-'));
    store = new EventStore(tmpDir);
  });

  afterEach(async () => {
    resetMaterializerCache();
    await rmrfAsync(tmpDir);
  });

  describe('handleViewTeamPerformance', () => {
    it('handleViewTeamPerformance_WithTeamEvents_ReturnsMaterializedView', async () => {
      const store = new EventStore(tmpDir);
      await store.append('test-wf', {
        streamId: 'test-wf',
        sequence: 1,
        timestamp: new Date().toISOString(),
        type: 'team.task.completed',
        data: {
          taskId: 'task-1',
          teammateName: 'worker-1',
          durationMs: 5000,
          filesChanged: ['src/auth/login.ts'],
          testsPassed: true,
          qualityGateResults: {},
        },
        schemaVersion: '1.0',
      });

      const result = await handleViewTeamPerformance({ workflowId: 'test-wf' }, tmpDir, store);

      expect(result.success).toBe(true);
      const data = result.data as Record<string, unknown>;
      expect(data).toHaveProperty('teammates');
      const teammates = data.teammates as Record<string, unknown>;
      expect(teammates).toHaveProperty('worker-1');
    });

    /** The handler output must carry the token fields that the team-performance view folds. */
    it('handleViewTeamPerformance_SurfacesTokenTelemetry', async () => {
      const store = new EventStore(tmpDir);
      await store.append('tok-wf', {
        streamId: 'tok-wf',
        sequence: 1,
        timestamp: new Date().toISOString(),
        type: 'subagent.tokens_used',
        data: { agentId: 'a1', teammateName: 'worker-1', outputTokens: 1234 },
        schemaVersion: '1.0',
      });

      const result = await handleViewTeamPerformance({ workflowId: 'tok-wf' }, tmpDir, store);
      expect(result.success).toBe(true);
      const data = result.data as {
        teammates: Record<string, { totalOutputTokens?: number; avgOutputTokensPerRun?: number }>;
      };
      expect(data.teammates['worker-1']?.totalOutputTokens).toBe(1234);
      expect(data.teammates['worker-1']?.avgOutputTokensPerRun).toBe(1234);
    });
  });

  describe('handleViewDelegationTimeline', () => {
    it('handleViewDelegationTimeline_WithTeamEvents_ReturnsTimeline', async () => {
      const store = new EventStore(tmpDir);
      await store.append('test-wf', {
        streamId: 'test-wf',
        sequence: 1,
        timestamp: new Date().toISOString(),
        type: 'team.spawned',
        data: {
          teamSize: 2,
          teammateNames: ['w1', 'w2'],
          taskCount: 4,
          dispatchMode: 'parallel',
        },
        schemaVersion: '1.0',
      });
      await store.append('test-wf', {
        streamId: 'test-wf',
        sequence: 2,
        timestamp: new Date().toISOString(),
        type: 'team.task.assigned',
        data: {
          taskId: 'task-1',
          teammateName: 'w1',
          worktreePath: '/tmp/wt-1',
          modules: ['auth'],
        },
        schemaVersion: '1.0',
      });

      const result = await handleViewDelegationTimeline({ workflowId: 'test-wf' }, tmpDir, store);

      expect(result.success).toBe(true);
      const data = result.data as Record<string, unknown>;
      expect(data).toHaveProperty('tasks');
      const tasks = data.tasks as unknown[];
      expect(tasks).toHaveLength(1);
    });

    it('handleViewDelegationTimeline_SurfacesPerTaskTokens', async () => {
      const store = new EventStore(tmpDir);
      await store.append('tok-wf', {
        streamId: 'tok-wf',
        sequence: 1,
        timestamp: new Date().toISOString(),
        type: 'team.task.assigned',
        data: { taskId: 'task-1', teammateName: 'w1', worktreePath: '/tmp/wt-1', modules: [] },
        schemaVersion: '1.0',
      });
      await store.append('tok-wf', {
        streamId: 'tok-wf',
        sequence: 2,
        timestamp: new Date().toISOString(),
        type: 'subagent.tokens_used',
        data: { agentId: 'a1', teammateName: 'w1', taskId: 'task-1', outputTokens: 777 },
        schemaVersion: '1.0',
      });

      const result = await handleViewDelegationTimeline({ workflowId: 'tok-wf' }, tmpDir, store);
      expect(result.success).toBe(true);
      const data = result.data as { tasks: Array<{ taskId: string; outputTokens?: number }> };
      expect(data.tasks.find((t) => t.taskId === 'task-1')?.outputTokens).toBe(777);
    });
  });

  describe('handleViewCodeQuality', () => {
    it('HandleViewCodeQuality_ReturnsEmptyState_WhenNoEvents', async () => {
      const result = await handleViewCodeQuality({}, tmpDir, store);

      expect(result.success).toBe(true);
      const data = result.data as Record<string, unknown>;
      expect(data).toHaveProperty('skills');
      expect(data).toHaveProperty('gates');
      expect(data).toHaveProperty('regressions');
      expect(data).toHaveProperty('benchmarks');
      expect(data.skills).toEqual({});
      expect(data.gates).toEqual({});
    });

    it('HandleViewCodeQuality_WithWorkflowId_FiltersToStream', async () => {
      const store = new EventStore(tmpDir);
      await store.append('quality-wf', {
        streamId: 'quality-wf',
        sequence: 1,
        timestamp: new Date().toISOString(),
        type: 'gate.executed',
        data: {
          gateName: 'typecheck',
          layer: 'build',
          passed: true,
          duration: 1200,
          details: {},
        },
        schemaVersion: '1.0',
      });

      await store.append('other-wf', {
        streamId: 'other-wf',
        sequence: 1,
        timestamp: new Date().toISOString(),
        type: 'gate.executed',
        data: {
          gateName: 'lint',
          layer: 'build',
          passed: false,
          duration: 800,
          details: {},
        },
        schemaVersion: '1.0',
      });

      const result = await handleViewCodeQuality({ workflowId: 'quality-wf' }, tmpDir, store);

      expect(result.success).toBe(true);
      const data = result.data as Record<string, unknown>;
      const gates = data.gates as Record<string, unknown>;
      expect(gates).toHaveProperty('typecheck');
      expect(gates).not.toHaveProperty('lint');
    });

    it('HandleViewCodeQuality_WithSkillFilter_ReturnsOnlyMatchingSkill', async () => {
      const store = new EventStore(tmpDir);
      await store.append('skill-wf', {
        streamId: 'skill-wf',
        sequence: 1,
        timestamp: new Date().toISOString(),
        type: 'gate.executed',
        data: {
          gateName: 'typecheck',
          layer: 'build',
          passed: true,
          duration: 1200,
          details: { skill: 'delegation' },
        },
        schemaVersion: '1.0',
      });
      await store.append('skill-wf', {
        streamId: 'skill-wf',
        sequence: 2,
        timestamp: new Date().toISOString(),
        type: 'gate.executed',
        data: {
          gateName: 'lint',
          layer: 'build',
          passed: true,
          duration: 800,
          details: { skill: 'synthesis' },
        },
        schemaVersion: '1.0',
      });

      const result = await handleViewCodeQuality({ workflowId: 'skill-wf', skill: 'delegation' }, tmpDir, store);

      expect(result.success).toBe(true);
      const data = result.data as Record<string, unknown>;
      const skills = data.skills as Record<string, unknown>;
      expect(Object.keys(skills)).toEqual(['delegation']);
      expect(skills).not.toHaveProperty('synthesis');
    });

    it('HandleViewCodeQuality_WithGateFilter_ReturnsOnlyMatchingGate', async () => {
      const store = new EventStore(tmpDir);
      await store.append('gate-wf', {
        streamId: 'gate-wf',
        sequence: 1,
        timestamp: new Date().toISOString(),
        type: 'gate.executed',
        data: {
          gateName: 'typecheck',
          layer: 'build',
          passed: true,
          duration: 1200,
          details: {},
        },
        schemaVersion: '1.0',
      });
      await store.append('gate-wf', {
        streamId: 'gate-wf',
        sequence: 2,
        timestamp: new Date().toISOString(),
        type: 'gate.executed',
        data: {
          gateName: 'lint',
          layer: 'build',
          passed: false,
          duration: 800,
          details: {},
        },
        schemaVersion: '1.0',
      });

      const result = await handleViewCodeQuality({ workflowId: 'gate-wf', gate: 'typecheck' }, tmpDir, store);

      expect(result.success).toBe(true);
      const data = result.data as Record<string, unknown>;
      const gates = data.gates as Record<string, unknown>;
      expect(Object.keys(gates)).toEqual(['typecheck']);
      expect(gates).not.toHaveProperty('lint');
    });

    /** Three consecutive failures of one gate for one skill make the handler append a `quality.regression` event. */
    it('HandleViewCodeQuality_WithRegressions_EmitsQualityRegressionEvents', async () => {
      const store = new EventStore(tmpDir);
      for (let i = 1; i <= 3; i++) {
        await store.append('regression-wf', {
          streamId: 'regression-wf',
          sequence: i,
          timestamp: new Date().toISOString(),
          type: 'gate.executed',
          data: {
            gateName: 'typecheck',
            layer: 'build',
            passed: false,
            duration: 100,
            details: { skill: 'delegation', commit: `commit-${i}`, reason: 'type error' },
          },
          schemaVersion: '1.0',
        });
      }

      await handleViewCodeQuality({ workflowId: 'regression-wf' }, tmpDir, store);

      const allEvents = await store.query('regression-wf');
      const regressionEvents = allEvents.filter(e => e.type === 'quality.regression');
      expect(regressionEvents.length).toBeGreaterThanOrEqual(1);
      const regressionData = regressionEvents[0].data as Record<string, unknown>;
      expect(regressionData).toMatchObject({
        skill: 'delegation',
        gate: 'typecheck',
        consecutiveFailures: 3,
        firstFailureCommit: 'commit-1',
        lastFailureCommit: 'commit-3',
      });
    });

    it('HandleViewCodeQuality_CalledTwice_DoesNotEmitDuplicateRegressions', async () => {
      const store = new EventStore(tmpDir);
      for (let i = 1; i <= 3; i++) {
        await store.append('dedup-wf', {
          streamId: 'dedup-wf',
          sequence: i,
          timestamp: new Date().toISOString(),
          type: 'gate.executed',
          data: {
            gateName: 'typecheck',
            layer: 'build',
            passed: false,
            duration: 100,
            details: { skill: 'delegation', commit: `commit-${i}`, reason: 'type error' },
          },
          schemaVersion: '1.0',
        });
      }

      await handleViewCodeQuality({ workflowId: 'dedup-wf' }, tmpDir, store);
      await handleViewCodeQuality({ workflowId: 'dedup-wf' }, tmpDir, store);

      const allEvents = await store.query('dedup-wf');
      const regressionEvents = allEvents.filter(e => e.type === 'quality.regression');
      expect(regressionEvents).toHaveLength(1);
    });

    /** The seed gives three benchmark entries and two regressions, so a limit of 1 must cut both arrays. */
    it('HandleViewCodeQuality_WithLimit_LimitsArrays', async () => {
      const store = new EventStore(tmpDir);
      await store.append('limit-wf', {
        streamId: 'limit-wf',
        sequence: 1,
        timestamp: new Date().toISOString(),
        type: 'benchmark.completed',
        data: {
          taskId: 'task-1',
          results: [
            { operation: 'op-a', metric: 'p99', value: 10, unit: 'ms', passed: true },
            { operation: 'op-b', metric: 'p99', value: 20, unit: 'ms', passed: true },
            { operation: 'op-c', metric: 'p99', value: 30, unit: 'ms', passed: true },
          ],
        },
        schemaVersion: '1.0',
      });

      for (let i = 2; i <= 7; i++) {
        await store.append('limit-wf', {
          streamId: 'limit-wf',
          sequence: i,
          timestamp: new Date().toISOString(),
          type: 'gate.executed',
          data: {
            gateName: i <= 4 ? 'typecheck' : 'lint',
            layer: 'build',
            passed: false,
            duration: 100,
            details: { skill: 'delegation', commit: `commit-${i}`, reason: 'error' },
          },
          schemaVersion: '1.0',
        });
      }

      const result = await handleViewCodeQuality({ workflowId: 'limit-wf', limit: 1 }, tmpDir, store);

      expect(result.success).toBe(true);
      const data = result.data as Record<string, unknown>;
      const benchmarks = data.benchmarks as unknown[];
      expect(benchmarks).toHaveLength(1);
      const regressions = data.regressions as unknown[];
      expect(regressions).toHaveLength(1);
    });

    /** The handler output must carry the mutation-score trend that the code-quality view folds for each skill. */
    it('HandleViewCodeQuality_SurfacesMutationScoreTrend_PerSkill', async () => {
      const store = new EventStore(tmpDir);
      const scores = [0.5, 0.6, 0.72];
      for (let i = 0; i < scores.length; i++) {
        await store.append('mut-wf', {
          streamId: 'mut-wf',
          sequence: i + 1,
          timestamp: new Date().toISOString(),
          type: 'gate.executed',
          data: {
            gateName: 'mutation-adequacy',
            layer: 'verification',
            passed: true,
            details: { skill: 'delegation', mutationScore: scores[i], commit: `c${i}` },
          },
          schemaVersion: '1.0',
        });
      }

      const result = await handleViewCodeQuality({ workflowId: 'mut-wf' }, tmpDir, store);

      expect(result.success).toBe(true);
      const data = result.data as {
        skills: Record<string, { mutationScoreTrend?: { values: Array<{ value: number }>; trend: string } }>;
      };
      const trend = data.skills['delegation']?.mutationScoreTrend;
      expect(trend).toBeDefined();
      expect(trend!.values.map((v) => v.value)).toEqual([0.5, 0.6, 0.72]);
      expect(trend!.trend).toBe('improving');
    });
  });

  /**
   * `code_quality` and `delegation_timeline` must pass the `operationId`, `correlationId` and `causationId` filters to the event query.
   * These tests use a real `EventStore`, because `composite.test.ts` mocks the handlers and cannot observe the filter.
   * `projections/telemetry/tools.test.ts` covers the `telemetry` action.
   */
  describe('Wave 5 — ViewActions_GroupA_AcceptCorrelationFilters_ScopeResultsCorrectly', () => {
    it('handleViewCodeQuality_WithCorrelationIdFilter_ReturnsOnlyMatchingEvents', async () => {
      const store = new EventStore(tmpDir);
      const streamId = 'corr-wf';

      for (let i = 1; i <= 3; i++) {
        await store.append(streamId, {
          streamId,
          sequence: i,
          timestamp: new Date().toISOString(),
          type: 'gate.executed',
          operationId: 'op-X',
          correlationId: 'cor-X',
          causationId: 'cause-X',
          data: {
            gateName: 'typecheck',
            layer: 'build',
            passed: true,
            duration: 100,
            details: { skill: 'delegation' },
          },
          schemaVersion: '1.0',
        });
      }
      for (let i = 4; i <= 6; i++) {
        await store.append(streamId, {
          streamId,
          sequence: i,
          timestamp: new Date().toISOString(),
          type: 'gate.executed',
          operationId: 'op-Y',
          correlationId: 'cor-Y',
          causationId: 'cause-Y',
          data: {
            gateName: 'lint',
            layer: 'build',
            passed: true,
            duration: 200,
            details: { skill: 'synthesis' },
          },
          schemaVersion: '1.0',
        });
      }

      const result = await handleViewCodeQuality(
        { workflowId: streamId, correlationId: 'cor-X' },
        tmpDir,
        store,
      );

      expect(result.success).toBe(true);
      const data = result.data as Record<string, unknown>;
      const gates = data.gates as Record<string, unknown>;
      expect(gates).toHaveProperty('typecheck');
      expect(gates).not.toHaveProperty('lint');
      const skills = data.skills as Record<string, unknown>;
      expect(skills).toHaveProperty('delegation');
      expect(skills).not.toHaveProperty('synthesis');
    });

    it('handleViewCodeQuality_WithOperationIdFilter_ReturnsOnlyMatchingEvents', async () => {
      const store = new EventStore(tmpDir);
      const streamId = 'op-wf';

      await store.append(streamId, {
        streamId,
        sequence: 1,
        timestamp: new Date().toISOString(),
        type: 'gate.executed',
        operationId: 'op-A',
        correlationId: 'cor-shared',
        data: {
          gateName: 'typecheck',
          layer: 'build',
          passed: true,
          duration: 100,
          details: { skill: 'delegation' },
        },
        schemaVersion: '1.0',
      });
      await store.append(streamId, {
        streamId,
        sequence: 2,
        timestamp: new Date().toISOString(),
        type: 'gate.executed',
        operationId: 'op-B',
        correlationId: 'cor-shared',
        data: {
          gateName: 'lint',
          layer: 'build',
          passed: true,
          duration: 200,
          details: { skill: 'synthesis' },
        },
        schemaVersion: '1.0',
      });

      const result = await handleViewCodeQuality(
        { workflowId: streamId, operationId: 'op-A' },
        tmpDir,
        store,
      );

      expect(result.success).toBe(true);
      const data = result.data as Record<string, unknown>;
      const gates = data.gates as Record<string, unknown>;
      expect(gates).toHaveProperty('typecheck');
      expect(gates).not.toHaveProperty('lint');
    });

    it('handleViewCodeQuality_WithCausationIdFilter_ReturnsOnlyMatchingEvents', async () => {
      const store = new EventStore(tmpDir);
      const streamId = 'cause-wf';

      await store.append(streamId, {
        streamId,
        sequence: 1,
        timestamp: new Date().toISOString(),
        type: 'gate.executed',
        causationId: 'cause-A',
        correlationId: 'cor-shared',
        data: {
          gateName: 'typecheck',
          layer: 'build',
          passed: true,
          duration: 100,
          details: { skill: 'delegation' },
        },
        schemaVersion: '1.0',
      });
      await store.append(streamId, {
        streamId,
        sequence: 2,
        timestamp: new Date().toISOString(),
        type: 'gate.executed',
        causationId: 'cause-B',
        correlationId: 'cor-shared',
        data: {
          gateName: 'lint',
          layer: 'build',
          passed: true,
          duration: 200,
          details: { skill: 'synthesis' },
        },
        schemaVersion: '1.0',
      });

      const result = await handleViewCodeQuality(
        { workflowId: streamId, causationId: 'cause-A' },
        tmpDir,
        store,
      );

      expect(result.success).toBe(true);
      const data = result.data as Record<string, unknown>;
      const gates = data.gates as Record<string, unknown>;
      expect(gates).toHaveProperty('typecheck');
      expect(gates).not.toHaveProperty('lint');
    });

    it('handleViewDelegationTimeline_WithCorrelationIdFilter_ReturnsOnlyMatchingEvents', async () => {
      const store = new EventStore(tmpDir);
      const streamId = 'timeline-wf';

      await store.append(streamId, {
        streamId,
        sequence: 1,
        timestamp: new Date().toISOString(),
        type: 'team.task.assigned',
        operationId: 'op-X',
        correlationId: 'cor-X',
        data: {
          taskId: 'task-X',
          teammateName: 'worker-X',
          worktreePath: '/tmp/wt-X',
          modules: ['auth'],
        },
        schemaVersion: '1.0',
      });

      await store.append(streamId, {
        streamId,
        sequence: 2,
        timestamp: new Date().toISOString(),
        type: 'team.task.assigned',
        operationId: 'op-Y',
        correlationId: 'cor-Y',
        data: {
          taskId: 'task-Y',
          teammateName: 'worker-Y',
          worktreePath: '/tmp/wt-Y',
          modules: ['billing'],
        },
        schemaVersion: '1.0',
      });

      const result = await handleViewDelegationTimeline(
        { workflowId: streamId, correlationId: 'cor-X' },
        tmpDir,
        store,
      );

      expect(result.success).toBe(true);
      const data = result.data as Record<string, unknown>;
      const tasks = data.tasks as Array<Record<string, unknown>>;
      expect(tasks).toHaveLength(1);
      expect(tasks[0].taskId).toBe('task-X');
    });
  });

  /**
   * `eval_results`, `quality_correlation` and `quality_attribution` must pass the same three filters to their event queries.
   * `quality_correlation` and `quality_attribution` read two projections, and both reads must apply the filter.
   */
  describe('Wave 5 — ViewActions_GroupB_AcceptCorrelationFilters_ScopeResultsCorrectly', () => {
    it('handleViewEvalResults_WithCorrelationIdFilter_ReturnsOnlyMatchingEvents', async () => {
      const store = new EventStore(tmpDir);
      const streamId = 'eval-corr-wf';

      await store.append(streamId, {
        streamId,
        sequence: 1,
        timestamp: new Date().toISOString(),
        type: 'eval.run.completed',
        operationId: 'op-X',
        correlationId: 'cor-X',
        data: {
          runId: 'run-X',
          suiteId: 'delegation',
          total: 10,
          passed: 8,
          failed: 2,
          avgScore: 0.8,
          duration: 5000,
          regressions: [],
        },
        schemaVersion: '1.0',
      });
      await store.append(streamId, {
        streamId,
        sequence: 2,
        timestamp: new Date().toISOString(),
        type: 'eval.run.completed',
        operationId: 'op-Y',
        correlationId: 'cor-Y',
        data: {
          runId: 'run-Y',
          suiteId: 'synthesis',
          total: 5,
          passed: 5,
          failed: 0,
          avgScore: 1.0,
          duration: 3000,
          regressions: [],
        },
        schemaVersion: '1.0',
      });

      const result = await handleViewEvalResults(
        { workflowId: streamId, correlationId: 'cor-X' },
        tmpDir,
        store,
      );

      expect(result.success).toBe(true);
      const data = result.data as Record<string, unknown>;
      const skills = data.skills as Record<string, unknown>;
      expect(skills).toHaveProperty('delegation');
      expect(skills).not.toHaveProperty('synthesis');
      const runs = data.runs as Array<{ runId: string }>;
      expect(runs).toHaveLength(1);
      expect(runs[0].runId).toBe('run-X');
    });

    it('handleViewEvalResults_WithOperationIdFilter_ReturnsOnlyMatchingEvents', async () => {
      const store = new EventStore(tmpDir);
      const streamId = 'eval-op-wf';

      await store.append(streamId, {
        streamId,
        sequence: 1,
        timestamp: new Date().toISOString(),
        type: 'eval.run.completed',
        operationId: 'op-A',
        correlationId: 'cor-shared',
        data: {
          runId: 'run-A',
          suiteId: 'delegation',
          total: 10,
          passed: 9,
          failed: 1,
          avgScore: 0.9,
          duration: 4000,
          regressions: [],
        },
        schemaVersion: '1.0',
      });
      await store.append(streamId, {
        streamId,
        sequence: 2,
        timestamp: new Date().toISOString(),
        type: 'eval.run.completed',
        operationId: 'op-B',
        correlationId: 'cor-shared',
        data: {
          runId: 'run-B',
          suiteId: 'synthesis',
          total: 5,
          passed: 5,
          failed: 0,
          avgScore: 1.0,
          duration: 3000,
          regressions: [],
        },
        schemaVersion: '1.0',
      });

      const result = await handleViewEvalResults(
        { workflowId: streamId, operationId: 'op-A' },
        tmpDir,
        store,
      );

      expect(result.success).toBe(true);
      const data = result.data as Record<string, unknown>;
      const runs = data.runs as Array<{ runId: string }>;
      expect(runs).toHaveLength(1);
      expect(runs[0].runId).toBe('run-A');
    });

    it('handleViewQualityCorrelation_WithCorrelationIdFilter_ReturnsOnlyMatchingSlice', async () => {
      const store = new EventStore(tmpDir);
      const streamId = 'qc-wf';

      await store.append(streamId, {
        streamId,
        sequence: 1,
        timestamp: new Date().toISOString(),
        type: 'gate.executed',
        operationId: 'op-X',
        correlationId: 'cor-X',
        data: {
          gateName: 'typecheck',
          layer: 'build',
          passed: true,
          duration: 1200,
          details: { skill: 'delegation' },
        },
        schemaVersion: '1.0',
      });
      await store.append(streamId, {
        streamId,
        sequence: 2,
        timestamp: new Date().toISOString(),
        type: 'eval.run.completed',
        operationId: 'op-X',
        correlationId: 'cor-X',
        data: {
          runId: 'run-X',
          suiteId: 'delegation',
          total: 10,
          passed: 9,
          failed: 1,
          avgScore: 0.9,
          duration: 5000,
          regressions: [],
        },
        schemaVersion: '1.0',
      });

      await store.append(streamId, {
        streamId,
        sequence: 3,
        timestamp: new Date().toISOString(),
        type: 'gate.executed',
        operationId: 'op-Y',
        correlationId: 'cor-Y',
        data: {
          gateName: 'lint',
          layer: 'build',
          passed: false,
          duration: 800,
          details: { skill: 'synthesis' },
        },
        schemaVersion: '1.0',
      });
      await store.append(streamId, {
        streamId,
        sequence: 4,
        timestamp: new Date().toISOString(),
        type: 'eval.run.completed',
        operationId: 'op-Y',
        correlationId: 'cor-Y',
        data: {
          runId: 'run-Y',
          suiteId: 'synthesis',
          total: 5,
          passed: 3,
          failed: 2,
          avgScore: 0.6,
          duration: 3000,
          regressions: [],
        },
        schemaVersion: '1.0',
      });

      const result = await handleViewQualityCorrelation(
        { workflowId: streamId, correlationId: 'cor-X' },
        tmpDir,
        store,
      );

      expect(result.success).toBe(true);
      const data = result.data as Record<string, unknown>;
      const skills = data.skills as Record<string, Record<string, unknown>>;
      expect(skills).toHaveProperty('delegation');
      expect(skills).not.toHaveProperty('synthesis');
      expect(skills['delegation'].evalScore).toBe(0.9);
      expect(skills['delegation'].gatePassRate).toBe(1);
    });

    it('handleViewQualityAttribution_WithCorrelationIdFilter_AttributesOnlyMatchingSlice', async () => {
      const store = new EventStore(tmpDir);
      const streamId = 'qa-wf';

      await store.append(streamId, {
        streamId,
        sequence: 1,
        timestamp: new Date().toISOString(),
        type: 'gate.executed',
        operationId: 'op-X',
        correlationId: 'cor-X',
        data: {
          gateName: 'typecheck',
          layer: 'build',
          passed: true,
          duration: 1200,
          details: { skill: 'delegation' },
        },
        schemaVersion: '1.0',
      });
      await store.append(streamId, {
        streamId,
        sequence: 2,
        timestamp: new Date().toISOString(),
        type: 'gate.executed',
        operationId: 'op-Y',
        correlationId: 'cor-Y',
        data: {
          gateName: 'lint',
          layer: 'build',
          passed: true,
          duration: 800,
          details: { skill: 'synthesis' },
        },
        schemaVersion: '1.0',
      });

      await store.append(streamId, {
        streamId,
        sequence: 3,
        timestamp: new Date().toISOString(),
        type: 'eval.run.completed',
        operationId: 'op-X',
        correlationId: 'cor-X',
        data: {
          runId: 'run-X',
          suiteId: 'delegation',
          total: 10,
          passed: 9,
          failed: 1,
          avgScore: 0.9,
          duration: 5000,
          regressions: [],
        },
        schemaVersion: '1.0',
      });
      await store.append(streamId, {
        streamId,
        sequence: 4,
        timestamp: new Date().toISOString(),
        type: 'eval.run.completed',
        operationId: 'op-Y',
        correlationId: 'cor-Y',
        data: {
          runId: 'run-Y',
          suiteId: 'synthesis',
          total: 5,
          passed: 3,
          failed: 2,
          avgScore: 0.6,
          duration: 3000,
          regressions: [],
        },
        schemaVersion: '1.0',
      });

      const result = await handleViewQualityAttribution(
        { workflowId: streamId, dimension: 'skill', correlationId: 'cor-X' },
        tmpDir,
        store,
      );

      expect(result.success).toBe(true);
      const data = result.data as { entries: Array<{ key: string }> };
      const skillNames = data.entries.map((e) => e.key);
      expect(skillNames).toContain('delegation');
      expect(skillNames).not.toContain('synthesis');
    });
  });

  describe('handleViewEvalResults', () => {
    it('handleViewEvalResults_NoEvents_ReturnsEmptyState', async () => {
      const result = await handleViewEvalResults({}, tmpDir, store);

      expect(result.success).toBe(true);
      const data = result.data as Record<string, unknown>;
      expect(data).toHaveProperty('skills');
      expect(data).toHaveProperty('runs');
      expect(data).toHaveProperty('regressions');
      expect(data.skills).toEqual({});
      expect(data.runs).toEqual([]);
      expect(data.regressions).toEqual([]);
    });

    it('handleViewEvalResults_WithSkillFilter_FiltersResults', async () => {
      const store = new EventStore(tmpDir);
      await store.append('eval-stream', {
        streamId: 'eval-stream',
        sequence: 1,
        timestamp: new Date().toISOString(),
        type: 'eval.run.completed',
        data: {
          runId: 'run-001',
          suiteId: 'delegation',
          total: 10,
          passed: 8,
          failed: 2,
          avgScore: 0.8,
          duration: 5000,
          regressions: [],
        },
        schemaVersion: '1.0',
      });
      await store.append('eval-stream', {
        streamId: 'eval-stream',
        sequence: 2,
        timestamp: new Date().toISOString(),
        type: 'eval.run.completed',
        data: {
          runId: 'run-002',
          suiteId: 'quality-review',
          total: 5,
          passed: 5,
          failed: 0,
          avgScore: 1.0,
          duration: 3000,
          regressions: [],
        },
        schemaVersion: '1.0',
      });

      const result = await handleViewEvalResults({ workflowId: 'eval-stream', skill: 'delegation' }, tmpDir, store);

      expect(result.success).toBe(true);
      const data = result.data as Record<string, unknown>;
      const skills = data.skills as Record<string, unknown>;
      expect(Object.keys(skills)).toEqual(['delegation']);
      expect(skills).not.toHaveProperty('quality-review');
    });

    it('handleViewEvalResults_WithLimit_LimitsRunsAndRegressions', async () => {
      const store = new EventStore(tmpDir);
      for (let i = 1; i <= 5; i++) {
        await store.append('eval-limit', {
          streamId: 'eval-limit',
          sequence: i,
          timestamp: new Date().toISOString(),
          type: 'eval.run.completed',
          data: {
            runId: `run-${String(i).padStart(3, '0')}`,
            suiteId: 'delegation',
            total: 10,
            passed: 10 - i,
            failed: i,
            avgScore: (10 - i) / 10,
            duration: 5000,
            regressions: [],
          },
          schemaVersion: '1.0',
        });
      }

      const result = await handleViewEvalResults({ workflowId: 'eval-limit', limit: 2 }, tmpDir, store);

      expect(result.success).toBe(true);
      const data = result.data as Record<string, unknown>;
      const runs = data.runs as unknown[];
      expect(runs).toHaveLength(2);
    });
  });

  describe('handleViewProvenance', () => {
    it('handleViewProvenance_ReturnsProvenanceState', async () => {
      const store = new EventStore(tmpDir);
      await store.append('test-id', {
        streamId: 'test-id',
        sequence: 1,
        timestamp: new Date().toISOString(),
        type: 'workflow.started',
        data: { featureId: 'test-id', workflowType: 'feature' },
        schemaVersion: '1.0',
      });

      const result = await handleViewProvenance({ workflowId: 'test-id' }, tmpDir, store);

      expect(result.success).toBe(true);
      const data = result.data as Record<string, unknown>;
      expect(data).toHaveProperty('featureId');
      expect(data).toHaveProperty('requirements');
      expect(data).toHaveProperty('coverage');
      expect(data).toHaveProperty('orphanTasks');
    });
  });

  describe('handleViewQualityCorrelation', () => {
    it('HandleViewQualityCorrelation_NoEvents_ReturnsEmptyCorrelation', async () => {
      const result = await handleViewQualityCorrelation({}, tmpDir, store);

      expect(result.success).toBe(true);
      const data = result.data as Record<string, unknown>;
      expect(data).toHaveProperty('skills');
      expect(data.skills).toEqual({});
    });

    it('HandleViewQualityCorrelation_WithMatchingEvents_ReturnsCorrelatedData', async () => {
      const store = new EventStore(tmpDir);
      const streamId = 'corr-wf';

      await store.append(streamId, {
        streamId,
        sequence: 1,
        timestamp: new Date().toISOString(),
        type: 'gate.executed',
        data: {
          gateName: 'typecheck',
          layer: 'build',
          passed: true,
          duration: 1200,
          details: { skill: 'delegation' },
        },
        schemaVersion: '1.0',
      });

      await store.append(streamId, {
        streamId,
        sequence: 2,
        timestamp: new Date().toISOString(),
        type: 'eval.run.completed',
        data: {
          runId: 'run-001',
          suiteId: 'delegation',
          total: 10,
          passed: 9,
          failed: 1,
          avgScore: 0.9,
          duration: 5000,
        },
        schemaVersion: '1.0',
      });

      const result = await handleViewQualityCorrelation({ workflowId: streamId }, tmpDir, store);

      expect(result.success).toBe(true);
      const data = result.data as Record<string, unknown>;
      expect(data).toHaveProperty('skills');
      const skills = data.skills as Record<string, Record<string, unknown>>;
      expect(skills).toHaveProperty('delegation');
      expect(skills['delegation'].evalScore).toBe(0.9);
      expect(skills['delegation'].gatePassRate).toBe(1);
    });
  });

  async function writeStateJson(
    dir: string,
    featureId: string,
    overrides: Record<string, unknown>,
  ): Promise<string> {
    const now = new Date().toISOString();
    const base: Record<string, unknown> = {
      version: '1.1',
      featureId,
      workflowType: 'feature',
      createdAt: now,
      updatedAt: now,
      phase: 'delegate',
      artifacts: { design: null, plan: null, pr: null },
      tasks: [],
      worktrees: {},
      reviews: {},
      synthesis: {
        integrationBranch: null,
        mergeOrder: [],
        mergedBranches: [],
        prUrl: null,
        prFeedback: [],
      },
      _version: 1,
      _history: {},
      _checkpoint: {
        timestamp: now,
        phase: 'delegate',
        summary: 'Test state',
        operationsSince: 0,
        fixCycleCount: 0,
        lastActivityTimestamp: now,
        staleAfterMinutes: 120,
      },
      ...overrides,
    };
    const file = path.join(dir, `${featureId}.state.json`);
    await fs.writeFile(file, JSON.stringify(base, null, 2), 'utf-8');
    return file;
  }

  /**
   * The view handlers read `<featureId>.state.json` for facts that the event projection cannot derive.
   * The `Fix 2` suites cover the review status, the review findings, the task count and the task list.
   * They write the state file with `writeStateJson` and use a real `EventStore`.
   */
  describe('Fix 2 — synthesis_readiness sources review status from state.json', () => {
    /** The state file marks the `review` dimension as passed, and the stream holds no `gate.executed` event. */
    it('SynthesisReadiness_StateReviewPassed_NoGateExecutedEvents_ReportsReviewPassed', async () => {
      const featureId = 'wf-fix2-reviews';
      await writeStateJson(tmpDir, featureId, {
        reviews: {
          review: { status: 'passed' },
        },
      });

      const result = await handleViewSynthesisReadiness(
        { workflowId: featureId },
        tmpDir,
        store,
      );

      expect(result.success).toBe(true);
      const data = result.data as {
        review: { reviewPassed: boolean };
      };
      expect(data.review.reviewPassed).toBe(true);
    });
  });

  describe('Fix 2 — workflow_status sources tasksTotal from state.json', () => {
    /** The state file declares five tasks, and the stream holds no `task.assigned` event. `tasksTotal` must come from the state file. */
    it('WorkflowStatus_StateTasksLengthFive_OnlyTwoCompletedEvents_ReportsTasksTotalFive', async () => {
      const featureId = 'wf-fix2-tasks-total';
      await writeStateJson(tmpDir, featureId, {
        tasks: [
          { id: 'T1', title: 'Task 1', status: 'pending', blockedBy: [] },
          { id: 'T2', title: 'Task 2', status: 'pending', blockedBy: [] },
          { id: 'T3', title: 'Task 3', status: 'complete', blockedBy: [] },
          { id: 'T4', title: 'Task 4', status: 'complete', blockedBy: [] },
          { id: 'T5', title: 'Task 5', status: 'pending', blockedBy: [] },
        ],
      });

      await store.append(featureId, {
        streamId: featureId,
        sequence: 1,
        timestamp: new Date().toISOString(),
        type: 'task.completed',
        data: { taskId: 'T3' },
        schemaVersion: '1.0',
      });
      await store.append(featureId, {
        streamId: featureId,
        sequence: 2,
        timestamp: new Date().toISOString(),
        type: 'task.completed',
        data: { taskId: 'T4' },
        schemaVersion: '1.0',
      });

      const result = await handleViewWorkflowStatus(
        { workflowId: featureId },
        tmpDir,
        store,
      );

      expect(result.success).toBe(true);
      const data = result.data as { tasksTotal: number };
      expect(data.tasksTotal).toBe(5);
    });
  });

  describe('Fix 2 — view tasks returns full state.tasks list', () => {
    it('ViewTasks_StateTasksDeclaredButFewEvents_ReturnsAllStateEntries', async () => {
      const featureId = 'wf-fix2-tasks-list';
      await writeStateJson(tmpDir, featureId, {
        tasks: [
          { id: 'T1', title: 'Task 1', status: 'pending', blockedBy: [] },
          { id: 'T2', title: 'Task 2', status: 'pending', blockedBy: [] },
          { id: 'T3', title: 'Task 3', status: 'pending', blockedBy: [] },
          { id: 'T4', title: 'Task 4', status: 'pending', blockedBy: [] },
          { id: 'T5', title: 'Task 5', status: 'pending', blockedBy: [] },
        ],
      });

      await store.append(featureId, {
        streamId: featureId,
        sequence: 1,
        timestamp: new Date().toISOString(),
        type: 'task.assigned',
        data: { taskId: 'T1', title: 'Task 1' },
        schemaVersion: '1.0',
      });
      await store.append(featureId, {
        streamId: featureId,
        sequence: 2,
        timestamp: new Date().toISOString(),
        type: 'task.assigned',
        data: { taskId: 'T2', title: 'Task 2' },
        schemaVersion: '1.0',
      });

      const result = await handleViewTasks(
        { workflowId: featureId },
        tmpDir,
        store,
      );

      expect(result.success).toBe(true);
      const tasks = result.data as Array<{ taskId?: string; id?: string }>;
      expect(tasks).toHaveLength(5);
      const ids = tasks.map((t) => (t.taskId ?? t.id) as string).sort();
      expect(ids).toEqual(['T1', 'T2', 'T3', 'T4', 'T5']);
    });
  });

  describe('Fix 2 — synthesis_readiness distinguishes null (not measured) from false (failed)', () => {
    /**
     * With no test result and no typecheck result, the projection holds `null` for both.
     * The blockers must say "not measured", because "not passing" is false for a check that never ran.
     * The single task is complete in the state file and in the stream, so no task blocker hides the assertion.
     */
    it('SynthesisReadiness_TestsAndTypecheckNeverRan_ReportsNotMeasuredBlockers', async () => {
      const featureId = 'wf-fix2-tests-null';
      await writeStateJson(tmpDir, featureId, {
        tasks: [
          { id: 'T1', title: 'Task 1', status: 'complete', blockedBy: [] },
        ],
        reviews: {
          'spec-review': { status: 'passed' },
          'quality-review': { status: 'passed' },
        },
      });

      await store.append(featureId, {
        streamId: featureId,
        sequence: 1,
        timestamp: new Date().toISOString(),
        type: 'task.assigned',
        data: { taskId: 'T1', title: 'Task 1' },
        schemaVersion: '1.0',
      });
      await store.append(featureId, {
        streamId: featureId,
        sequence: 2,
        timestamp: new Date().toISOString(),
        type: 'task.completed',
        data: { taskId: 'T1' },
        schemaVersion: '1.0',
      });

      const result = await handleViewSynthesisReadiness(
        { workflowId: featureId },
        tmpDir,
        store,
      );

      expect(result.success).toBe(true);
      const data = result.data as { blockers: string[] };
      expect(data.blockers).not.toContain('tests not passing');
      expect(data.blockers).not.toContain('typecheck not passing');
      expect(data.blockers).toContain('tests not measured');
      expect(data.blockers).toContain('typecheck not measured');
    });
  });

  describe('Fix 2 — convergence falls back to state.reviews.findingsByDimension', () => {
    /**
     * The state file holds findings for D1 and D2, and the stream holds no `gate.executed` event for them.
     * The view must count both dimensions as checked. Other dimensions can stay unchecked.
     */
    it('Convergence_StateFindingsCoverDimensions_RemovesFromUnchecked', async () => {
      const featureId = 'wf-fix2-convergence';
      await writeStateJson(tmpDir, featureId, {
        reviews: {
          findingsByDimension: {
            D1: [{ severity: 'low', summary: 'minor doc nit' }],
            D2: [],
          },
        },
      });

      const result = await handleViewConvergence(
        { workflowId: featureId },
        tmpDir,
        store,
      );

      expect(result.success).toBe(true);
      const data = result.data as { uncheckedDimensions: string[] };
      expect(data.uncheckedDimensions).not.toContain('D1');
      expect(data.uncheckedDimensions).not.toContain('D2');
    });
  });
});

/** A warm call must query only the events after the high-water mark of the cached view. */
describe('Delta Query (sinceSequence)', () => {
  let tmpDir: string;
  let store: EventStore;

  beforeEach(async () => {
    resetMaterializerCache();
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'exarchos-delta-test-'));
    store = new EventStore(tmpDir);
  });

  afterEach(async () => {
    resetMaterializerCache();
    await rmrfAsync(tmpDir);
  });

  it('handleViewWorkflowStatus_WarmCall_QueriesOnlyDeltaEvents', async () => {
    await store.append('wf-delta', {
      type: 'workflow.started',
      data: { featureId: 'delta-feature', workflowType: 'feature' },
    });
    await store.append('wf-delta', {
      type: 'workflow.transition',
      data: { from: 'started', to: 'delegating', trigger: 'auto', featureId: 'delta-feature' },
    });

    const coldResult = await handleViewWorkflowStatus({ workflowId: 'wf-delta' }, tmpDir, store);
    expect(coldResult.success).toBe(true);

    await store.append('wf-delta', {
      type: 'task.assigned',
      data: { taskId: 't1', title: 'Build login', branch: 'feat/login' },
    });

    const storeQuerySpy = vi.spyOn(store, 'query');

    const warmResult = await handleViewWorkflowStatus({ workflowId: 'wf-delta' }, tmpDir, store);
    expect(warmResult.success).toBe(true);

    expect(storeQuerySpy).toHaveBeenCalledWith(
      'wf-delta',
      expect.objectContaining({ sinceSequence: expect.any(Number) }),
    );
    const callArgs = storeQuerySpy.mock.calls[0];
    expect(callArgs[1]).toHaveProperty('sinceSequence');
    expect((callArgs[1] as { sinceSequence: number }).sinceSequence).toBeGreaterThan(0);

    storeQuerySpy.mockRestore();
  });

  it('handleViewTasks_WarmCall_QueriesOnlyDeltaEvents', async () => {
    await store.append('wf-delta-tasks', {
      type: 'task.assigned',
      data: { taskId: 't1', title: 'Task 1', branch: 'feat/t1' },
    });

    await handleViewTasks({ workflowId: 'wf-delta-tasks' }, tmpDir, store);

    await store.append('wf-delta-tasks', {
      type: 'task.assigned',
      data: { taskId: 't2', title: 'Task 2', branch: 'feat/t2' },
    });

    const storeQuerySpy = vi.spyOn(store, 'query');

    const warmResult = await handleViewTasks({ workflowId: 'wf-delta-tasks' }, tmpDir, store);
    expect(warmResult.success).toBe(true);

    expect(storeQuerySpy).toHaveBeenCalledWith(
      'wf-delta-tasks',
      expect.objectContaining({ sinceSequence: expect.any(Number) }),
    );

    storeQuerySpy.mockRestore();
  });

  it('handleViewPipeline_WarmCall_QueriesOnlyDeltaEvents', async () => {
    await store.append('wf-delta-pipe', {
      type: 'workflow.started',
      data: { featureId: 'pipe-feature', workflowType: 'feature' },
    });

    await handleViewPipeline({}, tmpDir, store);

    await store.append('wf-delta-pipe', {
      type: 'task.assigned',
      data: { taskId: 't1', title: 'Task 1', branch: 'feat/t1' },
    });

    const storeQuerySpy = vi.spyOn(store, 'query');

    const warmResult = await handleViewPipeline({}, tmpDir, store);
    expect(warmResult.success).toBe(true);

    expect(storeQuerySpy).toHaveBeenCalledWith(
      'wf-delta-pipe',
      expect.objectContaining({ sinceSequence: expect.any(Number) }),
    );

    storeQuerySpy.mockRestore();
  });

  it('handleViewTeamPerformance_WarmCall_QueriesOnlyDeltaEvents', async () => {
    await store.append('wf-delta-team', {
      type: 'team.task.completed',
      data: {
        taskId: 'task-1',
        teammateName: 'worker-1',
        durationMs: 5000,
        filesChanged: ['src/auth/login.ts'],
        testsPassed: true,
        qualityGateResults: {},
      },
    });

    await handleViewTeamPerformance({ workflowId: 'wf-delta-team' }, tmpDir, store);

    await store.append('wf-delta-team', {
      type: 'team.task.completed',
      data: {
        taskId: 'task-2',
        teammateName: 'worker-2',
        durationMs: 3000,
        filesChanged: ['src/auth/signup.ts'],
        testsPassed: true,
        qualityGateResults: {},
      },
    });

    const storeQuerySpy = vi.spyOn(store, 'query');

    const warmResult = await handleViewTeamPerformance({ workflowId: 'wf-delta-team' }, tmpDir, store);
    expect(warmResult.success).toBe(true);

    expect(storeQuerySpy).toHaveBeenCalledWith(
      'wf-delta-team',
      expect.objectContaining({ sinceSequence: expect.any(Number) }),
    );

    storeQuerySpy.mockRestore();
  });
});

describe('Skip loadFromSnapshot on warm calls', () => {
  let tmpDir: string;
  let store: EventStore;

  beforeEach(async () => {
    resetMaterializerCache();
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'exarchos-snap-test-'));
    store = new EventStore(tmpDir);
  });

  afterEach(async () => {
    resetMaterializerCache();
    await rmrfAsync(tmpDir);
  });

  it('handleViewWorkflowStatus_WarmCall_SkipsSnapshotLoad', async () => {
    await store.append('wf-snap', {
      type: 'workflow.started',
      data: { featureId: 'snap-feature', workflowType: 'feature' },
    });

    await handleViewWorkflowStatus({ workflowId: 'wf-snap' }, tmpDir, store);

    const materializer = getOrCreateMaterializer(tmpDir);
    const loadSpy = vi.spyOn(materializer, 'loadFromSnapshot');

    const warmResult = await handleViewWorkflowStatus({ workflowId: 'wf-snap' }, tmpDir, store);
    expect(warmResult.success).toBe(true);

    expect(loadSpy).not.toHaveBeenCalled();

    loadSpy.mockRestore();
  });

  it('handleViewWorkflowStatus_ColdCall_LoadsSnapshot', async () => {
    await store.append('wf-cold', {
      type: 'workflow.started',
      data: { featureId: 'cold-feature', workflowType: 'feature' },
    });

    const materializer = getOrCreateMaterializer(tmpDir);
    const loadSpy = vi.spyOn(materializer, 'loadFromSnapshot');

    const coldResult = await handleViewWorkflowStatus({ workflowId: 'wf-cold' }, tmpDir, store);
    expect(coldResult.success).toBe(true);

    expect(loadSpy).toHaveBeenCalledWith('wf-cold', expect.any(String));

    loadSpy.mockRestore();
  });
});

/** The view handlers must read through the SQLite backend that the `EventStore` appender owns. These tests spy on that backend. */
describe('Backend Integration (Task 12)', () => {
  let tmpDir: string;
  let store: EventStore;

  beforeEach(async () => {
    resetMaterializerCache();
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'exarchos-backend-test-'));
    store = new EventStore(tmpDir);
  });

  afterEach(async () => {
    resetMaterializerCache();
    await rmrfAsync(tmpDir);
  });

  it('handleViewWorkflowStatus_WithBackend_QueriesSQLite', async () => {
    await store.append('wf-backend', {
      type: 'workflow.started',
      data: { featureId: 'backend-feature', workflowType: 'feature' },
    });
    await store.append('wf-backend', {
      type: 'workflow.transition',
      data: { from: 'started', to: 'delegating', trigger: 'auto', featureId: 'backend-feature' },
    });

    const sqliteBackend = store.getAppender().ensureSqliteBackendSync();
    const querySpy = vi.spyOn(sqliteBackend, 'queryEvents');

    resetMaterializerCache();

    const result = await handleViewWorkflowStatus({ workflowId: 'wf-backend' }, tmpDir, store);

    expect(result.success).toBe(true);
    expect(querySpy).toHaveBeenCalled();
    const queryCallStreamId = querySpy.mock.calls[0][0];
    expect(queryCallStreamId).toBe('wf-backend');

    querySpy.mockRestore();
  });

  it('handleViewPipeline_WithBackend_DiscoverStreamsFromBackend', async () => {
    await store.append('wf-one', {
      type: 'workflow.started',
      data: { featureId: 'feature-one', workflowType: 'feature' },
    });
    await store.append('wf-two', {
      type: 'workflow.started',
      data: { featureId: 'feature-two', workflowType: 'feature' },
    });

    const sqliteBackend = store.getAppender().ensureSqliteBackendSync();
    const listStreamsSpy = vi.spyOn(sqliteBackend, 'listStreams');

    resetMaterializerCache();

    const result = await handleViewPipeline({}, tmpDir, store);

    expect(result.success).toBe(true);
    expect(listStreamsSpy).toHaveBeenCalled();

    const data = result.data as { workflows: unknown[]; total: number };
    expect(data.total).toBe(2);

    listStreamsSpy.mockRestore();
  });

  it('handleViewTasks_WithBackend_QueriesSQLite', async () => {
    await store.append('wf-tasks-backend', {
      type: 'task.assigned',
      data: { taskId: 't1', title: 'Build auth', branch: 'feat/auth' },
    });
    await store.append('wf-tasks-backend', {
      type: 'task.assigned',
      data: { taskId: 't2', title: 'Build UI', branch: 'feat/ui' },
    });

    const sqliteBackend = store.getAppender().ensureSqliteBackendSync();
    const querySpy = vi.spyOn(sqliteBackend, 'queryEvents');

    resetMaterializerCache();

    const result = await handleViewTasks({ workflowId: 'wf-tasks-backend' }, tmpDir, store);

    expect(result.success).toBe(true);
    expect(querySpy).toHaveBeenCalled();
    const queryCallStreamId = querySpy.mock.calls[0][0];
    expect(queryCallStreamId).toBe('wf-tasks-backend');

    const data = result.data as Array<Record<string, unknown>>;
    expect(data).toHaveLength(2);

    querySpy.mockRestore();
  });

  describe('handleViewPipeline infra-stream filter (#1187)', () => {
    /**
     * The reserved infrastructure streams (`exarchos-onboard`, `exarchos-doctor`, `telemetry`) are not feature workflows.
     * The pipeline view must filter them before materialization, so no row with an empty `featureId` appears.
     */
    it('Pipeline_WithInfraStreams_ExcludesPhantomRows', async () => {
      await store.append('feat-real', {
        type: 'workflow.started',
        data: { featureId: 'real-feature', workflowType: 'feature' },
      });
      await store.append('exarchos-onboard', {
        type: 'onboard.executed',
        data: { trigger: 'onboard' },
      });
      await store.append('exarchos-doctor', {
        type: 'diagnostic.executed',
        data: { check: 'mcp-handshake' },
      });
      await store.append('telemetry', {
        type: 'tool.invoked',
        data: { tool: 'exarchos_view', argsBytes: 12 },
      });

      const result = await handleViewPipeline({}, tmpDir, store);

      expect(result.success).toBe(true);
      const data = result.data as { workflows: Array<{ featureId: string }>; total: number };
      expect(data.total).toBe(1);
      expect(data.workflows).toHaveLength(1);
      expect(data.workflows[0]?.featureId).toBe('real-feature');
      expect(data.workflows.every((w) => w.featureId !== '')).toBe(true);
    });
  });
});

describe('ViewTelemetry_OutputSchema_IncludesActionErrorFields', () => {
  it('the registered outputSchema validates per-tool entries with actionErrors + actionErrorBreakdown', () => {
    const viewTool = TOOL_REGISTRY.find((t) => t.name === 'exarchos_view');
    expect(viewTool).toBeDefined();
    const telemetryAction = viewTool!.actions.find((a) => a.name === 'telemetry');
    expect(telemetryAction).toBeDefined();
    const outputSchema = telemetryAction!.outputSchema;
    expect(outputSchema).toBeDefined();

    const envelope = {
      success: true,
      data: {
        session: {
          start: '2026-05-15T00:00:00.000Z',
          totalInvocations: 5,
          totalTokens: 100,
        },
        tools: [
          {
            tool: 'exarchos_orchestrate',
            invocations: 5,
            errors: 1,
            totalDurationMs: 50,
            totalBytes: 500,
            totalTokens: 100,
            p50DurationMs: 10,
            p95DurationMs: 10,
            p50Bytes: 100,
            p95Bytes: 100,
            p50Tokens: 20,
            p95Tokens: 20,
            actionErrors: 3,
            actionErrorBreakdown: {
              MERGE_ROLLED_BACK: 2,
              PREFLIGHT_FAILED: 1,
            },
          },
        ],
        hints: [],
      },
      next_actions: [],
      _meta: {},
      _perf: { ms: 1, bytes: 100, tokens: 25 },
    };

    const result = outputSchema.safeParse(envelope);
    expect(result.success).toBe(true);
  });

  /**
   * The schema must declare the two fields on the per-tool entry, not only accept them inside a `z.unknown()` payload.
   * The test reads the `JSON.stringify` form of the schema, which holds the field names only when the schema declares them.
   */
  it('per-tool data shape advertised by the outputSchema includes actionErrors + actionErrorBreakdown', () => {
    const viewTool = TOOL_REGISTRY.find((t) => t.name === 'exarchos_view');
    const telemetryAction = viewTool!.actions.find((a) => a.name === 'telemetry');
    expect(telemetryAction).toBeDefined();

    const schemaText = JSON.stringify(telemetryAction!.outputSchema);
    expect(schemaText).toContain('actionErrors');
    expect(schemaText).toContain('actionErrorBreakdown');
  });
});
