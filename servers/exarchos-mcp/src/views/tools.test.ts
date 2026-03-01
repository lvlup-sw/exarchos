import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  getOrCreateMaterializer,
  getOrCreateEventStore,
  resetMaterializerCache,
  handleViewWorkflowStatus,
  handleViewTasks,
  handleViewPipeline,
  handleViewTeamPerformance,
  handleViewDelegationTimeline,
  handleViewCodeQuality,
  handleViewEvalResults,
  handleViewQualityCorrelation,
  handleViewProvenance,
  handleViewIdeateReadiness,
} from './tools.js';
import { EventStore } from '../event-store/store.js';
import { InMemoryBackend } from '../storage/memory-backend.js';

describe('Singleton Cache', () => {
  beforeEach(() => {
    resetMaterializerCache();
  });

  describe('cache synchronization', () => {
    it('should return same instances for same stateDir', () => {
      const mat1 = getOrCreateMaterializer('/tmp/dir-A');
      const mat2 = getOrCreateMaterializer('/tmp/dir-A');
      expect(mat1).toBe(mat2);

      const store1 = getOrCreateEventStore('/tmp/dir-A');
      const store2 = getOrCreateEventStore('/tmp/dir-A');
      expect(store1).toBe(store2);
    });

    it('should create new instances when stateDir changes', () => {
      const matA = getOrCreateMaterializer('/tmp/dir-A');
      const matB = getOrCreateMaterializer('/tmp/dir-B');
      expect(matA).not.toBe(matB);

      const storeA = getOrCreateEventStore('/tmp/dir-A');
      const storeB = getOrCreateEventStore('/tmp/dir-B');
      expect(storeA).not.toBe(storeB);
    });

    it('should invalidate EventStore cache when Materializer stateDir changes', () => {
      // Step 1: Populate both caches with dir-A
      const matA = getOrCreateMaterializer('/tmp/dir-A');
      const storeA = getOrCreateEventStore('/tmp/dir-A');

      // Step 2: Change stateDir via materializer
      const matB = getOrCreateMaterializer('/tmp/dir-B');
      expect(matB).not.toBe(matA);

      // Step 3: EventStore should NOT return dir-A's instance
      // BUG: Before fix, cachedStateDir === "dir-B" but cachedEventStore
      // still points to dir-A's EventStore, so it returns the stale instance.
      const storeB = getOrCreateEventStore('/tmp/dir-B');
      expect(storeB).not.toBe(storeA);
    });

    it('should invalidate Materializer cache when EventStore stateDir changes', () => {
      // Step 1: Populate both caches with dir-A
      const matA = getOrCreateMaterializer('/tmp/dir-A');
      const storeA = getOrCreateEventStore('/tmp/dir-A');

      // Step 2: Change stateDir via event store
      const storeB = getOrCreateEventStore('/tmp/dir-B');
      expect(storeB).not.toBe(storeA);

      // Step 3: Materializer should NOT return dir-A's instance
      const matB = getOrCreateMaterializer('/tmp/dir-B');
      expect(matB).not.toBe(matA);
    });
  });
});

// ─── View Handler Tests ──────────────────────────────────────────────────────

describe('View Handlers', () => {
  let tmpDir: string;

  beforeEach(async () => {
    resetMaterializerCache();
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'exarchos-view-test-'));
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
      const result = await handleViewTeamPerformance({ workflowId: 'test-wf' }, tmpDir);

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
      const result = await handleViewDelegationTimeline({ workflowId: 'test-wf' }, tmpDir);

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
      const result = await handleViewCodeQuality({}, tmpDir);

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
      const result = await handleViewCodeQuality({ workflowId: 'quality-wf' }, tmpDir);

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
      const result = await handleViewCodeQuality({ workflowId: 'skill-wf', skill: 'delegation' }, tmpDir);

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
      const result = await handleViewCodeQuality({ workflowId: 'gate-wf', gate: 'typecheck' }, tmpDir);

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
      await handleViewCodeQuality({ workflowId: 'regression-wf' }, tmpDir);

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
      await handleViewCodeQuality({ workflowId: 'dedup-wf' }, tmpDir);
      await handleViewCodeQuality({ workflowId: 'dedup-wf' }, tmpDir);

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
      const result = await handleViewCodeQuality({ workflowId: 'limit-wf', limit: 1 }, tmpDir);

      // Assert
      expect(result.success).toBe(true);
      const data = result.data as Record<string, unknown>;
      const benchmarks = data.benchmarks as unknown[];
      expect(benchmarks).toHaveLength(1);
      const regressions = data.regressions as unknown[];
      expect(regressions).toHaveLength(1);
    });
  });

  // ─── T10: handleViewEvalResults ────────────────────────────────────────────

  describe('handleViewEvalResults', () => {
    it('handleViewEvalResults_NoEvents_ReturnsEmptyState', async () => {
      // Act
      const result = await handleViewEvalResults({}, tmpDir);

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
      const result = await handleViewEvalResults({ workflowId: 'eval-stream', skill: 'delegation' }, tmpDir);

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
      const result = await handleViewEvalResults({ workflowId: 'eval-limit', limit: 2 }, tmpDir);

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
      const result = await handleViewProvenance({ workflowId: 'test-id' }, tmpDir);

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
      const result = await handleViewIdeateReadiness({ workflowId: 'test-id' }, tmpDir);

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
      const result = await handleViewQualityCorrelation({}, tmpDir);

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
      const result = await handleViewQualityCorrelation({ workflowId: streamId }, tmpDir);

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
    const coldResult = await handleViewWorkflowStatus({ workflowId: 'wf-delta' }, tmpDir);
    expect(coldResult.success).toBe(true);

    // Add more events
    await store.append('wf-delta', {
      type: 'task.assigned',
      data: { taskId: 't1', title: 'Build login', branch: 'feat/login' },
    });

    // Spy on the cached store
    const cachedStore = getOrCreateEventStore(tmpDir);
    const storeQuerySpy = vi.spyOn(cachedStore, 'query');

    // Act: warm call
    const warmResult = await handleViewWorkflowStatus({ workflowId: 'wf-delta' }, tmpDir);
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
    await handleViewTasks({ workflowId: 'wf-delta-tasks' }, tmpDir);

    // Add more events
    await store.append('wf-delta-tasks', {
      type: 'task.assigned',
      data: { taskId: 't2', title: 'Task 2', branch: 'feat/t2' },
    });

    // Spy on the cached store
    const cachedStore = getOrCreateEventStore(tmpDir);
    const storeQuerySpy = vi.spyOn(cachedStore, 'query');

    // Act: warm call
    const warmResult = await handleViewTasks({ workflowId: 'wf-delta-tasks' }, tmpDir);
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
    await handleViewPipeline({}, tmpDir);

    // Add more events
    await store.append('wf-delta-pipe', {
      type: 'task.assigned',
      data: { taskId: 't1', title: 'Task 1', branch: 'feat/t1' },
    });

    // Spy on the cached store
    const cachedStore = getOrCreateEventStore(tmpDir);
    const storeQuerySpy = vi.spyOn(cachedStore, 'query');

    // Act: warm call
    const warmResult = await handleViewPipeline({}, tmpDir);
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
    await handleViewTeamPerformance({ workflowId: 'wf-delta-team' }, tmpDir);

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
    const cachedStore = getOrCreateEventStore(tmpDir);
    const storeQuerySpy = vi.spyOn(cachedStore, 'query');

    // Act: warm call
    const warmResult = await handleViewTeamPerformance({ workflowId: 'wf-delta-team' }, tmpDir);
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
    await handleViewWorkflowStatus({ workflowId: 'wf-snap' }, tmpDir);

    // Spy on materializer.loadFromSnapshot for warm call
    const materializer = getOrCreateMaterializer(tmpDir);
    const loadSpy = vi.spyOn(materializer, 'loadFromSnapshot');

    // Act: warm call (materializer already has state)
    const warmResult = await handleViewWorkflowStatus({ workflowId: 'wf-snap' }, tmpDir);
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
    const coldResult = await handleViewWorkflowStatus({ workflowId: 'wf-cold' }, tmpDir);
    expect(coldResult.success).toBe(true);

    // Assert: loadFromSnapshot SHOULD have been called (cold = no cached state)
    expect(loadSpy).toHaveBeenCalledWith('wf-cold', expect.any(String));

    loadSpy.mockRestore();
  });
});

// ─── Task 12: Backend Integration Tests ──────────────────────────────────────

describe('Backend Integration (Task 12)', () => {
  let tmpDir: string;
  let backend: InMemoryBackend;
  let store: EventStore;

  beforeEach(async () => {
    resetMaterializerCache();
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'exarchos-backend-test-'));
    backend = new InMemoryBackend();
    store = new EventStore(tmpDir, { backend });
  });

  afterEach(async () => {
    resetMaterializerCache();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('handleViewWorkflowStatus_WithBackend_QueriesSQLite', async () => {
    // Arrange: seed events through the store (dual-writes to backend)
    await store.append('wf-backend', {
      type: 'workflow.started',
      data: { featureId: 'backend-feature', workflowType: 'feature' },
    });
    await store.append('wf-backend', {
      type: 'workflow.transition',
      data: { from: 'started', to: 'delegating', trigger: 'auto', featureId: 'backend-feature' },
    });

    // Spy on backend.queryEvents to verify delegation
    const querySpy = vi.spyOn(backend, 'queryEvents');

    // Inject our backend-aware store into the module
    resetMaterializerCache();
    // Use registerViewTools-style injection by setting module store
    // We need handleViewWorkflowStatus to use our backend-aware store
    // Set up the module-level event store by calling getOrCreateEventStore
    // after injecting via the exported setter
    const { registerViewTools } = await import('./tools.js');
    const mockServer = { tool: vi.fn() } as unknown as Parameters<typeof registerViewTools>[0];
    registerViewTools(mockServer, tmpDir, store);

    // Act
    const result = await handleViewWorkflowStatus({ workflowId: 'wf-backend' }, tmpDir);

    // Assert
    expect(result.success).toBe(true);
    expect(querySpy).toHaveBeenCalled();
    const queryCallStreamId = querySpy.mock.calls[0][0];
    expect(queryCallStreamId).toBe('wf-backend');

    querySpy.mockRestore();
  });

  it('handleViewPipeline_WithBackend_DiscoverStreamsFromBackend', async () => {
    // Arrange: seed events for two streams via the store (dual-writes to backend)
    await store.append('wf-one', {
      type: 'workflow.started',
      data: { featureId: 'feature-one', workflowType: 'feature' },
    });
    await store.append('wf-two', {
      type: 'workflow.started',
      data: { featureId: 'feature-two', workflowType: 'feature' },
    });

    // Spy on backend.listStreams to verify it's used for discovery
    const listStreamsSpy = vi.spyOn(backend, 'listStreams');

    // Inject our backend-aware store
    resetMaterializerCache();
    const { registerViewTools } = await import('./tools.js');
    const mockServer = { tool: vi.fn() } as unknown as Parameters<typeof registerViewTools>[0];
    registerViewTools(mockServer, tmpDir, store);

    // Act
    const result = await handleViewPipeline({}, tmpDir);

    // Assert
    expect(result.success).toBe(true);
    // discoverStreams should use backend.listStreams() instead of fs.readdir
    expect(listStreamsSpy).toHaveBeenCalled();

    // Verify both workflows are discovered
    const data = result.data as { workflows: unknown[]; total: number };
    expect(data.total).toBe(2);

    listStreamsSpy.mockRestore();
  });

  it('handleViewTasks_WithBackend_QueriesSQLite', async () => {
    // Arrange: seed task events through the store (dual-writes to backend)
    await store.append('wf-tasks-backend', {
      type: 'task.assigned',
      data: { taskId: 't1', title: 'Build auth', branch: 'feat/auth' },
    });
    await store.append('wf-tasks-backend', {
      type: 'task.assigned',
      data: { taskId: 't2', title: 'Build UI', branch: 'feat/ui' },
    });

    // Spy on backend.queryEvents
    const querySpy = vi.spyOn(backend, 'queryEvents');

    // Inject our backend-aware store
    resetMaterializerCache();
    const { registerViewTools } = await import('./tools.js');
    const mockServer = { tool: vi.fn() } as unknown as Parameters<typeof registerViewTools>[0];
    registerViewTools(mockServer, tmpDir, store);

    // Act
    const result = await handleViewTasks({ workflowId: 'wf-tasks-backend' }, tmpDir);

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
});
