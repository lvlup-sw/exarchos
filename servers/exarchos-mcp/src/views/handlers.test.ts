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
  handleViewIdeateReadiness,
  handleViewSynthesisReadiness,
  handleViewConvergence,
} from './tools.js';
import { EventStore } from '../event-store/store.js';
import { TOOL_REGISTRY } from '../registry.js';

// The "Singleton Cache" describe block that previously tested
// `getOrCreateEventStore` was deleted alongside that function. The
// constructor-injection refactor (#1182) eliminated the registry
// entirely; handlers receive EventStore via DispatchContext, and the
// composition-root CI script enforces no rogue instantiations.
// See docs/plans/2026-04-26-eventstore-constructor-injection.md.

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

// ─── View Handler Tests ──────────────────────────────────────────────────────

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
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  describe('handleViewTeamPerformance', () => {
    it('handleViewTeamPerformance_WithTeamEvents_ReturnsMaterializedView', async () => {
      // Arrange: seed event store with team.task.completed events
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

      // Act
      const result = await handleViewTeamPerformance({ workflowId: 'test-wf' }, tmpDir, store);

      // Assert
      expect(result.success).toBe(true);
      const data = result.data as Record<string, unknown>;
      expect(data).toHaveProperty('teammates');
      const teammates = data.teammates as Record<string, unknown>;
      expect(teammates).toHaveProperty('worker-1');
    });
  });

  describe('handleViewDelegationTimeline', () => {
    it('handleViewDelegationTimeline_WithTeamEvents_ReturnsTimeline', async () => {
      // Arrange: seed event store with team events
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

      // Act
      const result = await handleViewDelegationTimeline({ workflowId: 'test-wf' }, tmpDir, store);

      // Assert
      expect(result.success).toBe(true);
      const data = result.data as Record<string, unknown>;
      expect(data).toHaveProperty('tasks');
      const tasks = data.tasks as unknown[];
      expect(tasks).toHaveLength(1);
    });
  });

  // ─── T17: handleViewCodeQuality ────────────────────────────────────────────

  describe('handleViewCodeQuality', () => {
    it('HandleViewCodeQuality_ReturnsEmptyState_WhenNoEvents', async () => {
      // Act
      const result = await handleViewCodeQuality({}, tmpDir, store);

      // Assert
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
      // Arrange: seed events in specific stream
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

      // Seed a different stream
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

      // Act: query specific stream
      const result = await handleViewCodeQuality({ workflowId: 'quality-wf' }, tmpDir, store);

      // Assert
      expect(result.success).toBe(true);
      const data = result.data as Record<string, unknown>;
      const gates = data.gates as Record<string, unknown>;
      expect(gates).toHaveProperty('typecheck');
      expect(gates).not.toHaveProperty('lint');
    });

    it('HandleViewCodeQuality_WithSkillFilter_ReturnsOnlyMatchingSkill', async () => {
      // Arrange: seed events with two different skills
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

      // Act: filter to delegation skill only
      const result = await handleViewCodeQuality({ workflowId: 'skill-wf', skill: 'delegation' }, tmpDir, store);

      // Assert
      expect(result.success).toBe(true);
      const data = result.data as Record<string, unknown>;
      const skills = data.skills as Record<string, unknown>;
      expect(Object.keys(skills)).toEqual(['delegation']);
      expect(skills).not.toHaveProperty('synthesis');
    });

    it('HandleViewCodeQuality_WithGateFilter_ReturnsOnlyMatchingGate', async () => {
      // Arrange: seed events with two different gates
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

      // Act: filter to typecheck gate only
      const result = await handleViewCodeQuality({ workflowId: 'gate-wf', gate: 'typecheck' }, tmpDir, store);

      // Assert
      expect(result.success).toBe(true);
      const data = result.data as Record<string, unknown>;
      const gates = data.gates as Record<string, unknown>;
      expect(Object.keys(gates)).toEqual(['typecheck']);
      expect(gates).not.toHaveProperty('lint');
    });

    it('HandleViewCodeQuality_WithRegressions_EmitsQualityRegressionEvents', async () => {
      // Arrange: seed 3 consecutive gate failures for same gate+skill combo
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

      // Act
      await handleViewCodeQuality({ workflowId: 'regression-wf' }, tmpDir, store);

      // Assert: query event store for quality.regression events
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
      // Arrange: seed 3 consecutive gate failures
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

      // Act: call twice
      await handleViewCodeQuality({ workflowId: 'dedup-wf' }, tmpDir, store);
      await handleViewCodeQuality({ workflowId: 'dedup-wf' }, tmpDir, store);

      // Assert: should have exactly 1 quality.regression event, not 2
      const allEvents = await store.query('dedup-wf');
      const regressionEvents = allEvents.filter(e => e.type === 'quality.regression');
      expect(regressionEvents).toHaveLength(1);
    });

    it('HandleViewCodeQuality_WithLimit_LimitsArrays', async () => {
      // Arrange: seed events that produce multiple benchmark entries
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

      // Also seed multiple gate failures to produce regressions
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

      // Act: limit to 1 entry
      const result = await handleViewCodeQuality({ workflowId: 'limit-wf', limit: 1 }, tmpDir, store);

      // Assert
      expect(result.success).toBe(true);
      const data = result.data as Record<string, unknown>;
      const benchmarks = data.benchmarks as unknown[];
      expect(benchmarks).toHaveLength(1);
      const regressions = data.regressions as unknown[];
      expect(regressions).toHaveLength(1);
    });
  });

  // ─── Wave 5 / Task 13 (#1437) — Group A view actions honor correlation filters ─
  //
  // Each handler in Group A (`telemetry`, `delegation_timeline`, `code_quality`)
  // must thread the new `operationId / correlationId / causationId` optional
  // filter args into `EventStore.queryEvents` so callers can slice the view by
  // dispatch boundary. Telemetry is exercised in `telemetry/tools.test.ts`
  // because its handler lives in a different file (no materializer hop). The
  // other two actions plumb through `queryDeltaEvents` and are exercised here
  // against real EventStore + tmpDir fixtures so the filter behavior is
  // genuinely observable (composite.test.ts mocks the handlers and would
  // false-pass on the spread-passthrough cast).

  describe('Wave 5 — ViewActions_GroupA_AcceptCorrelationFilters_ScopeResultsCorrectly', () => {
    it('handleViewCodeQuality_WithCorrelationIdFilter_ReturnsOnlyMatchingEvents', async () => {
      // GIVEN: a single workflow stream that carries gate.executed events
      // stamped with two distinct correlationIds. The view by default folds
      // the whole stream — under the new filter contract it must fold only
      // the cor-X subset.
      const store = new EventStore(tmpDir);
      const streamId = 'corr-wf';

      // Three events tagged cor-X with skill "delegation"
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
      // Three events tagged cor-Y with skill "synthesis"
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

      // WHEN: handler invoked with a correlationId filter scoping to cor-X
      const result = await handleViewCodeQuality(
        { workflowId: streamId, correlationId: 'cor-X' },
        tmpDir,
        store,
      );

      // THEN: only the cor-X gate ("typecheck"/"delegation") is folded into
      // the view; the cor-Y gate ("lint"/"synthesis") is absent.
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
      // delegation_timeline projects from team.* events. Seed a split stream
      // and assert the filtered call returns only the cor-X side.
      const store = new EventStore(tmpDir);
      const streamId = 'timeline-wf';

      // cor-X side: a single task end-to-end
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

      // cor-Y side: a different task
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
      // Only task-X should be visible; task-Y was tagged cor-Y and must be
      // filtered out by the indexed-correlation WHERE clause.
      expect(tasks).toHaveLength(1);
      expect(tasks[0].taskId).toBe('task-X');
    });
  });

  // ─── Wave 5 / Task 14 (#1437) — Group B view actions honor correlation filters ─
  //
  // `eval_results`, `quality_correlation`, `quality_attribution` thread the
  // same operationId/correlationId/causationId tuple into their underlying
  // EventStore queries so callers can slice the rollup by dispatch boundary.
  // quality_correlation and quality_attribution each pull from BOTH the
  // CODE_QUALITY_VIEW and EVAL_RESULTS_VIEW projections; both fetches must
  // honor the filter so the joined result is internally consistent.

  describe('Wave 5 — ViewActions_GroupB_AcceptCorrelationFilters_ScopeResultsCorrectly', () => {
    it('handleViewEvalResults_WithCorrelationIdFilter_ReturnsOnlyMatchingEvents', async () => {
      // GIVEN: two eval.run.completed events in the same stream, tagged with
      // different correlationIds. Pre-filter the view sees both skills;
      // post-filter only the cor-X subset is folded.
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
      // Only "delegation" was tagged cor-X; "synthesis" is filtered out.
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
      // GIVEN: a stream with code-quality + eval events tagged across two
      // correlation IDs. quality_correlation joins both projections; the
      // filtered call must return only the cor-X intersection.
      const store = new EventStore(tmpDir);
      const streamId = 'qc-wf';

      // cor-X: code quality gate + eval run for "delegation"
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

      // cor-Y: code quality gate + eval run for "synthesis"
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
      // GIVEN: two skills exercised with different correlationIds. The
      // attribution for `skill` dimension must roll up only the filtered
      // subset — both projections (CQ + ER) honor the filter.
      const store = new EventStore(tmpDir);
      const streamId = 'qa-wf';

      // cor-X: delegation
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
      // cor-Y: synthesis
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

      // Seed eval slices for both correlations so the test exercises the
      // eval-side projection too. handleViewQualityAttribution folds both
      // CodeQuality + EvalResults projections under the same correlation
      // filter — without these appends a regression that breaks eval-side
      // filtering would still pass via the gate-only path.
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

  // ─── T10: handleViewEvalResults ────────────────────────────────────────────

  describe('handleViewEvalResults', () => {
    it('handleViewEvalResults_NoEvents_ReturnsEmptyState', async () => {
      // Act
      const result = await handleViewEvalResults({}, tmpDir, store);

      // Assert
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
      // Arrange: seed eval events for two skills
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

      // Act: filter to delegation skill only
      const result = await handleViewEvalResults({ workflowId: 'eval-stream', skill: 'delegation' }, tmpDir, store);

      // Assert
      expect(result.success).toBe(true);
      const data = result.data as Record<string, unknown>;
      const skills = data.skills as Record<string, unknown>;
      expect(Object.keys(skills)).toEqual(['delegation']);
      expect(skills).not.toHaveProperty('quality-review');
    });

    it('handleViewEvalResults_WithLimit_LimitsRunsAndRegressions', async () => {
      // Arrange: seed multiple eval runs
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

      // Act: limit to 2 entries
      const result = await handleViewEvalResults({ workflowId: 'eval-limit', limit: 2 }, tmpDir, store);

      // Assert
      expect(result.success).toBe(true);
      const data = result.data as Record<string, unknown>;
      const runs = data.runs as unknown[];
      expect(runs).toHaveLength(2);
    });
  });

  // ─── T13: handleViewProvenance ─────────────────────────────────────────────

  describe('handleViewProvenance', () => {
    it('handleViewProvenance_ReturnsProvenanceState', async () => {
      // Arrange: seed event store with provenance-relevant events
      const store = new EventStore(tmpDir);
      await store.append('test-id', {
        streamId: 'test-id',
        sequence: 1,
        timestamp: new Date().toISOString(),
        type: 'workflow.started',
        data: { featureId: 'test-id', workflowType: 'feature' },
        schemaVersion: '1.0',
      });

      // Act
      const result = await handleViewProvenance({ workflowId: 'test-id' }, tmpDir, store);

      // Assert
      expect(result.success).toBe(true);
      const data = result.data as Record<string, unknown>;
      expect(data).toHaveProperty('featureId');
      expect(data).toHaveProperty('requirements');
      expect(data).toHaveProperty('coverage');
      expect(data).toHaveProperty('orphanTasks');
    });
  });

  // ─── T13: handleViewIdeateReadiness ──────────────────────────────────────────

  describe('handleViewIdeateReadiness', () => {
    it('handleViewIdeateReadiness_ReturnsReadinessState', async () => {
      // Arrange: seed event store with ideate-readiness-relevant events
      const store = new EventStore(tmpDir);
      await store.append('test-id', {
        streamId: 'test-id',
        sequence: 1,
        timestamp: new Date().toISOString(),
        type: 'workflow.started',
        data: { featureId: 'test-id', workflowType: 'feature' },
        schemaVersion: '1.0',
      });

      // Act
      const result = await handleViewIdeateReadiness({ workflowId: 'test-id' }, tmpDir, store);

      // Assert
      expect(result.success).toBe(true);
      const data = result.data as Record<string, unknown>;
      expect(data).toHaveProperty('ready');
      expect(data).toHaveProperty('designArtifactExists');
      expect(data).toHaveProperty('gateResult');
    });
  });

  // ─── handleViewQualityCorrelation ──────────────────────────────────────────

  describe('handleViewQualityCorrelation', () => {
    it('HandleViewQualityCorrelation_NoEvents_ReturnsEmptyCorrelation', async () => {
      // Act
      const result = await handleViewQualityCorrelation({}, tmpDir, store);

      // Assert
      expect(result.success).toBe(true);
      const data = result.data as Record<string, unknown>;
      expect(data).toHaveProperty('skills');
      expect(data.skills).toEqual({});
    });

    it('HandleViewQualityCorrelation_WithMatchingEvents_ReturnsCorrelatedData', async () => {
      // Arrange: seed both code quality and eval events for the same skill
      const store = new EventStore(tmpDir);
      const streamId = 'corr-wf';

      // Seed code quality events
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

      // Seed eval events
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

      // Act
      const result = await handleViewQualityCorrelation({ workflowId: streamId }, tmpDir, store);

      // Assert
      expect(result.success).toBe(true);
      const data = result.data as Record<string, unknown>;
      expect(data).toHaveProperty('skills');
      const skills = data.skills as Record<string, Record<string, unknown>>;
      expect(skills).toHaveProperty('delegation');
      expect(skills['delegation'].evalScore).toBe(0.9);
      expect(skills['delegation'].gatePassRate).toBe(1);
    });
  });

  // ─── Fix 2 (T2.2 / T2.3) — view handlers source from state.json ──────────
  //
  // Issue #1184: CQRS views disagree with state.json. View projections derived
  // facts only from the event stream — when dedicated events were missing or
  // the planner stamped state directly, the views silently dropped that data.
  //
  // Fix: the affected view handlers must consult `<id>.state.json` as the
  // authoritative source for plan-state facts (review status, declared task
  // count, declared task list) and use events only for execution facts.
  //
  // Spec deviation note: the plan (Fix 2 / T2.2) names `views/composite.test.ts`
  // as the test file. composite.test.ts mocks every handler in `./tools.js`, so
  // tests there cannot actually exercise the handler logic that pulls from
  // state.json. tools.test.ts is the existing handler-integration test surface
  // (real EventStore + tmpDir) — placing the integration tests here lets them
  // genuinely fail RED and pass GREEN. composite.test.ts continues to validate
  // routing only.

  /** Build a minimally schema-valid state.json file at <tmpDir>/<id>.state.json. */
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

  describe('Fix 2 — synthesis_readiness sources review status from state.json', () => {
    it('SynthesisReadiness_StateReviewsPassed_NoGateExecutedEvents_ReportsSpecAndQualityPassed', async () => {
      // GIVEN: state.json declares both spec-review and quality-review passed
      // — but NO `gate.executed` events exist. Pre-fix the view sees both as
      // false because the projection only watches events.
      const featureId = 'wf-fix2-reviews';
      await writeStateJson(tmpDir, featureId, {
        reviews: {
          'spec-review': { status: 'passed' },
          'quality-review': { status: 'passed' },
        },
      });

      // Act
      const result = await handleViewSynthesisReadiness(
        { workflowId: featureId },
        tmpDir,
        store,
      );

      // Assert
      expect(result.success).toBe(true);
      const data = result.data as {
        review: { specPassed: boolean; qualityPassed: boolean };
      };
      expect(data.review.specPassed).toBe(true);
      expect(data.review.qualityPassed).toBe(true);
    });
  });

  describe('Fix 2 — workflow_status sources tasksTotal from state.json', () => {
    it('WorkflowStatus_StateTasksLengthFive_OnlyTwoCompletedEvents_ReportsTasksTotalFive', async () => {
      // GIVEN: state.json declares 5 tasks, but the event stream only has
      // task.completed for 2 of them (no task.assigned events at all — the
      // planner stamped tasks directly via workflow set without dispatching).
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

      // Act
      const result = await handleViewWorkflowStatus(
        { workflowId: featureId },
        tmpDir,
        store,
      );

      // Assert: tasksTotal must reflect state.json (5), not event count (0).
      expect(result.success).toBe(true);
      const data = result.data as { tasksTotal: number };
      expect(data.tasksTotal).toBe(5);
    });
  });

  describe('Fix 2 — view tasks returns full state.tasks list', () => {
    it('ViewTasks_StateTasksDeclaredButFewEvents_ReturnsAllStateEntries', async () => {
      // GIVEN: state.json with 5 tasks, only 2 have task.assigned events
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

      // Act
      const result = await handleViewTasks(
        { workflowId: featureId },
        tmpDir,
        store,
      );

      // Assert: all 5 entries returned
      expect(result.success).toBe(true);
      const tasks = result.data as Array<{ taskId?: string; id?: string }>;
      expect(tasks).toHaveLength(5);
      const ids = tasks.map((t) => (t.taskId ?? t.id) as string).sort();
      expect(ids).toEqual(['T1', 'T2', 'T3', 'T4', 'T5']);
    });
  });

  describe('Fix 2 — synthesis_readiness distinguishes null (not measured) from false (failed)', () => {
    it('SynthesisReadiness_TestsAndTypecheckNeverRan_ReportsNotMeasuredBlockers', async () => {
      // GIVEN: state.json with no test.result or typecheck.result events
      // (the projection's `tests.lastRunPassed` and `tests.typecheckPassed`
      // initialize to `null` in this case). Pre-fix the blocker text says
      // "tests not passing" / "typecheck not passing" — which is misleading
      // because they were never measured. Post-fix the wording must distinguish.
      const featureId = 'wf-fix2-tests-null';
      await writeStateJson(tmpDir, featureId, {
        // Make tasks fully accounted for so they don't add their own blocker
        // that masks the test/typecheck assertion.
        tasks: [
          { id: 'T1', title: 'Task 1', status: 'complete', blockedBy: [] },
        ],
        reviews: {
          'spec-review': { status: 'passed' },
          'quality-review': { status: 'passed' },
        },
      });

      // Seed an aligned task event so the tasks block doesn't crowd the assertion
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

      // Act
      const result = await handleViewSynthesisReadiness(
        { workflowId: featureId },
        tmpDir,
        store,
      );

      // Assert: blockers reflect "not measured" not "not passing"
      expect(result.success).toBe(true);
      const data = result.data as { blockers: string[] };
      expect(data.blockers).not.toContain('tests not passing');
      expect(data.blockers).not.toContain('typecheck not passing');
      expect(data.blockers).toContain('tests not measured');
      expect(data.blockers).toContain('typecheck not measured');
    });
  });

  describe('Fix 2 — convergence falls back to state.reviews.findingsByDimension', () => {
    it('Convergence_StateFindingsCoverDimensions_RemovesFromUnchecked', async () => {
      // GIVEN: state.reviews.findingsByDimension stamps findings for D1 + D2,
      // but no gate.executed events ever fired for those dimensions. Pre-fix
      // the convergence view kept D1 + D2 in uncheckedDimensions because it
      // only consumed gate events. Post-fix the state.json fallback kicks in.
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
      // D1 and D2 must NOT appear in uncheckedDimensions — state.json
      // covered them. Other dimensions may still be unchecked depending on
      // the projection's defaults.
      expect(data.uncheckedDimensions).not.toContain('D1');
      expect(data.uncheckedDimensions).not.toContain('D2');
    });
  });
});

// ─── Task 1: sinceSequence Delta Queries ─────────────────────────────────────

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
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('handleViewWorkflowStatus_WarmCall_QueriesOnlyDeltaEvents', async () => {
    // Arrange: seed events and do a first (cold) call
    await store.append('wf-delta', {
      type: 'workflow.started',
      data: { featureId: 'delta-feature', workflowType: 'feature' },
    });
    await store.append('wf-delta', {
      type: 'workflow.transition',
      data: { from: 'started', to: 'delegating', trigger: 'auto', featureId: 'delta-feature' },
    });

    // Cold call to populate materializer state
    const coldResult = await handleViewWorkflowStatus({ workflowId: 'wf-delta' }, tmpDir, store);
    expect(coldResult.success).toBe(true);

    // Add more events
    await store.append('wf-delta', {
      type: 'task.assigned',
      data: { taskId: 't1', title: 'Build login', branch: 'feat/login' },
    });

    // Spy on the store passed to handler
    const storeQuerySpy = vi.spyOn(store, 'query');

    // Act: warm call
    const warmResult = await handleViewWorkflowStatus({ workflowId: 'wf-delta' }, tmpDir, store);
    expect(warmResult.success).toBe(true);

    // Assert: store.query was called with sinceSequence filter
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
    // Arrange: seed events and do a first (cold) call
    await store.append('wf-delta-tasks', {
      type: 'task.assigned',
      data: { taskId: 't1', title: 'Task 1', branch: 'feat/t1' },
    });

    // Cold call
    await handleViewTasks({ workflowId: 'wf-delta-tasks' }, tmpDir, store);

    // Add more events
    await store.append('wf-delta-tasks', {
      type: 'task.assigned',
      data: { taskId: 't2', title: 'Task 2', branch: 'feat/t2' },
    });

    // Spy on the cached store
    const storeQuerySpy = vi.spyOn(store, 'query');

    // Act: warm call
    const warmResult = await handleViewTasks({ workflowId: 'wf-delta-tasks' }, tmpDir, store);
    expect(warmResult.success).toBe(true);

    // Assert: store.query was called with sinceSequence filter
    expect(storeQuerySpy).toHaveBeenCalledWith(
      'wf-delta-tasks',
      expect.objectContaining({ sinceSequence: expect.any(Number) }),
    );

    storeQuerySpy.mockRestore();
  });

  it('handleViewPipeline_WarmCall_QueriesOnlyDeltaEvents', async () => {
    // Arrange: seed events and do a first (cold) call
    await store.append('wf-delta-pipe', {
      type: 'workflow.started',
      data: { featureId: 'pipe-feature', workflowType: 'feature' },
    });

    // Cold call
    await handleViewPipeline({}, tmpDir, store);

    // Add more events
    await store.append('wf-delta-pipe', {
      type: 'task.assigned',
      data: { taskId: 't1', title: 'Task 1', branch: 'feat/t1' },
    });

    // Spy on the cached store
    const storeQuerySpy = vi.spyOn(store, 'query');

    // Act: warm call
    const warmResult = await handleViewPipeline({}, tmpDir, store);
    expect(warmResult.success).toBe(true);

    // Assert: store.query was called with sinceSequence filter for the stream
    expect(storeQuerySpy).toHaveBeenCalledWith(
      'wf-delta-pipe',
      expect.objectContaining({ sinceSequence: expect.any(Number) }),
    );

    storeQuerySpy.mockRestore();
  });

  it('handleViewTeamPerformance_WarmCall_QueriesOnlyDeltaEvents', async () => {
    // Arrange: seed events and do a first (cold) call
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

    // Cold call
    await handleViewTeamPerformance({ workflowId: 'wf-delta-team' }, tmpDir, store);

    // Add more events
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

    // Spy on the cached store
    const storeQuerySpy = vi.spyOn(store, 'query');

    // Act: warm call
    const warmResult = await handleViewTeamPerformance({ workflowId: 'wf-delta-team' }, tmpDir, store);
    expect(warmResult.success).toBe(true);

    // Assert: store.query was called with sinceSequence filter
    expect(storeQuerySpy).toHaveBeenCalledWith(
      'wf-delta-team',
      expect.objectContaining({ sinceSequence: expect.any(Number) }),
    );

    storeQuerySpy.mockRestore();
  });
});

// ─── Task 2: Skip loadFromSnapshot on Warm Calls ────────────────────────────

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
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('handleViewWorkflowStatus_WarmCall_SkipsSnapshotLoad', async () => {
    // Arrange: seed events and do a first (cold) call
    await store.append('wf-snap', {
      type: 'workflow.started',
      data: { featureId: 'snap-feature', workflowType: 'feature' },
    });

    // Cold call to populate materializer state
    await handleViewWorkflowStatus({ workflowId: 'wf-snap' }, tmpDir, store);

    // Spy on materializer.loadFromSnapshot for warm call
    const materializer = getOrCreateMaterializer(tmpDir);
    const loadSpy = vi.spyOn(materializer, 'loadFromSnapshot');

    // Act: warm call (materializer already has state)
    const warmResult = await handleViewWorkflowStatus({ workflowId: 'wf-snap' }, tmpDir, store);
    expect(warmResult.success).toBe(true);

    // Assert: loadFromSnapshot should NOT have been called
    expect(loadSpy).not.toHaveBeenCalled();

    loadSpy.mockRestore();
  });

  it('handleViewWorkflowStatus_ColdCall_LoadsSnapshot', async () => {
    // Arrange: seed events
    await store.append('wf-cold', {
      type: 'workflow.started',
      data: { featureId: 'cold-feature', workflowType: 'feature' },
    });

    // Spy on materializer.loadFromSnapshot BEFORE the cold call
    const materializer = getOrCreateMaterializer(tmpDir);
    const loadSpy = vi.spyOn(materializer, 'loadFromSnapshot');

    // Act: cold call (no cached state)
    const coldResult = await handleViewWorkflowStatus({ workflowId: 'wf-cold' }, tmpDir, store);
    expect(coldResult.success).toBe(true);

    // Assert: loadFromSnapshot SHOULD have been called (cold = no cached state)
    expect(loadSpy).toHaveBeenCalledWith('wf-cold', expect.any(String));

    loadSpy.mockRestore();
  });
});

// ─── Task 12: Backend Integration Tests ──────────────────────────────────────

describe('Backend Integration (Task 12)', () => {
  let tmpDir: string;
  let store: EventStore;

  beforeEach(async () => {
    resetMaterializerCache();
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'exarchos-backend-test-'));
    // v2.11 Phase 3 (substrate-cut): the InMemoryBackend dual-write
    // fixture this suite used pre-collapse no longer receives writes —
    // EventStore writes only to the appender's owned SqliteBackend.
    // Spy on that backend (the one `getReadBackend()` returns) instead.
    store = new EventStore(tmpDir);
  });

  afterEach(async () => {
    resetMaterializerCache();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('handleViewWorkflowStatus_WithBackend_QueriesSQLite', async () => {
    // Arrange: seed events through the store (single-write to SQLite backend)
    await store.append('wf-backend', {
      type: 'workflow.started',
      data: { featureId: 'backend-feature', workflowType: 'feature' },
    });
    await store.append('wf-backend', {
      type: 'workflow.transition',
      data: { from: 'started', to: 'delegating', trigger: 'auto', featureId: 'backend-feature' },
    });

    // Spy on the SQLite backend's queryEvents to verify view-handler
    // delegation flows through the StorageBackend abstraction.
    const sqliteBackend = store.getAppender().ensureSqliteBackendSync();
    const querySpy = vi.spyOn(sqliteBackend, 'queryEvents');

    resetMaterializerCache();

    // Act
    const result = await handleViewWorkflowStatus({ workflowId: 'wf-backend' }, tmpDir, store);

    // Assert
    expect(result.success).toBe(true);
    expect(querySpy).toHaveBeenCalled();
    const queryCallStreamId = querySpy.mock.calls[0][0];
    expect(queryCallStreamId).toBe('wf-backend');

    querySpy.mockRestore();
  });

  it('handleViewPipeline_WithBackend_DiscoverStreamsFromBackend', async () => {
    // Arrange: seed events for two streams via the store (single-write to SQLite)
    await store.append('wf-one', {
      type: 'workflow.started',
      data: { featureId: 'feature-one', workflowType: 'feature' },
    });
    await store.append('wf-two', {
      type: 'workflow.started',
      data: { featureId: 'feature-two', workflowType: 'feature' },
    });

    // Spy on listStreams of the (sole) SQLite backend.
    const sqliteBackend = store.getAppender().ensureSqliteBackendSync();
    const listStreamsSpy = vi.spyOn(sqliteBackend, 'listStreams');

    resetMaterializerCache();

    // Act
    const result = await handleViewPipeline({}, tmpDir, store);

    // Assert
    expect(result.success).toBe(true);
    // discoverStreams should use the backend's listStreams() abstraction.
    expect(listStreamsSpy).toHaveBeenCalled();

    // Verify both workflows are discovered
    const data = result.data as { workflows: unknown[]; total: number };
    expect(data.total).toBe(2);

    listStreamsSpy.mockRestore();
  });

  it('handleViewTasks_WithBackend_QueriesSQLite', async () => {
    // Arrange: seed task events through the store (single-write to SQLite)
    await store.append('wf-tasks-backend', {
      type: 'task.assigned',
      data: { taskId: 't1', title: 'Build auth', branch: 'feat/auth' },
    });
    await store.append('wf-tasks-backend', {
      type: 'task.assigned',
      data: { taskId: 't2', title: 'Build UI', branch: 'feat/ui' },
    });

    // Spy on the SQLite backend's queryEvents.
    const sqliteBackend = store.getAppender().ensureSqliteBackendSync();
    const querySpy = vi.spyOn(sqliteBackend, 'queryEvents');

    resetMaterializerCache();

    // Act
    const result = await handleViewTasks({ workflowId: 'wf-tasks-backend' }, tmpDir, store);

    // Assert
    expect(result.success).toBe(true);
    expect(querySpy).toHaveBeenCalled();
    const queryCallStreamId = querySpy.mock.calls[0][0];
    expect(queryCallStreamId).toBe('wf-tasks-backend');

    // Verify tasks are returned from the backend-delegated query
    const data = result.data as Array<Record<string, unknown>>;
    expect(data).toHaveLength(2);

    querySpy.mockRestore();
  });

  // ─── #1187: pipeline view filters infra streams ───────────────────────────
  describe('handleViewPipeline infra-stream filter (#1187)', () => {
    it('Pipeline_WithInfraStreams_ExcludesPhantomRows', async () => {
      // GIVEN: one real feature workflow stream alongside the reserved
      // infrastructure streams (exarchos-onboard, exarchos-doctor, telemetry).
      // (The legacy `exarchos-init` stream + its `init.executed` event were
      // retired in DR-5 / task 018 — onboard is its successor.)
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

      // WHEN: pipeline view materializes all discovered streams
      const result = await handleViewPipeline({}, tmpDir, store);

      // THEN: only the feature workflow appears — infra streams are filtered
      // out before materialization, so no phantom rows with empty featureId
      // leak into the response.
      expect(result.success).toBe(true);
      const data = result.data as { workflows: Array<{ featureId: string }>; total: number };
      expect(data.total).toBe(1);
      expect(data.workflows).toHaveLength(1);
      expect(data.workflows[0]?.featureId).toBe('real-feature');
      expect(data.workflows.every((w) => w.featureId !== '')).toBe(true);
    });
  });
});

// ─── PR3/T10 (#1364): view.telemetry outputSchema declares action-error fields ───
describe('ViewTelemetry_OutputSchema_IncludesActionErrorFields', () => {
  it('the registered outputSchema validates per-tool entries with actionErrors + actionErrorBreakdown', () => {
    const viewTool = TOOL_REGISTRY.find((t) => t.name === 'exarchos_view');
    expect(viewTool).toBeDefined();
    const telemetryAction = viewTool!.actions.find((a) => a.name === 'telemetry');
    expect(telemetryAction).toBeDefined();
    const outputSchema = telemetryAction!.outputSchema;
    expect(outputSchema).toBeDefined();

    // A canonical success envelope as emitted by handleViewTelemetry, post
    // PR3/T9 projection extension.
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
            // PR3/T10 (#1364) — the new fields the outputSchema must
            // recognise on per-tool entries.
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

  it('per-tool data shape advertised by the outputSchema includes actionErrors + actionErrorBreakdown', () => {
    // Stronger contract assertion: the outputSchema must EXPOSE the new
    // fields on its per-tool entry shape, not merely accept them inside
    // a permissive `z.unknown()` payload. We probe via the JSON Schema
    // round-trip so this remains stable across Zod versions.
    const viewTool = TOOL_REGISTRY.find((t) => t.name === 'exarchos_view');
    const telemetryAction = viewTool!.actions.find((a) => a.name === 'telemetry');
    expect(telemetryAction).toBeDefined();

    // The schema must visibly mention the new field names somewhere in its
    // declared shape (e.g., on `data.tools[*].actionErrors`).
    const schemaText = JSON.stringify(telemetryAction!.outputSchema);
    // If the outputSchema is `EnvelopeSchema(z.unknown())` the JSON form
    // will not contain these names; once a typed sub-schema is registered
    // they appear in the parsed schema tree.
    expect(schemaText).toContain('actionErrors');
    expect(schemaText).toContain('actionErrorBreakdown');
  });
});
