import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  getOrCreateMaterializer,
  getOrCreateEventStore,
  resetMaterializerCache,
  handleViewTeamPerformance,
  handleViewDelegationTimeline,
  handleViewCodeQuality,
} from './tools.js';
import { EventStore } from '../event-store/store.js';

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
  });
});
