import { describe, it, expect } from 'vitest';
import { migrateState, CURRENT_VERSION } from '../../workflow/migration.js';

// Helper: minimal v1.0 state (no _history, _events, _eventSequence, _checkpoint)
function makeV1_0State() {
  return {
    version: '1.0',
    featureId: 'test-feature',
    workflowType: 'feature',
    createdAt: '2025-01-15T10:00:00Z',
    updatedAt: '2025-01-15T10:30:00Z',
    phase: 'ideate',
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
  };
}

// Helper: minimal v1.1 state (full schema)
function makeV1_1State() {
  return {
    ...makeV1_0State(),
    version: '1.1',
    _history: {},
    _events: [],
    _eventSequence: 0,
    _checkpoint: {
      timestamp: '2025-01-15T10:30:00Z',
      phase: 'ideate',
      summary: '',
      operationsSince: 0,
      fixCycleCount: 0,
      lastActivityTimestamp: '2025-01-15T10:30:00Z',
      staleAfterMinutes: 120,
    },
  };
}

describe('Migration', () => {
  describe('MigrateState_V1_0ToV1_1_AddsInternalFields', () => {
    it('should add _history, _events, _eventSequence, _checkpoint when migrating from v1.0', () => {
      const v1_0 = makeV1_0State();
      const result = migrateState(v1_0) as Record<string, unknown>;

      expect(result.version).toBe('1.1');
      expect(result._history).toEqual({});
      expect(result._events).toEqual([]);
      expect(result._eventSequence).toBe(0);
      expect(result._checkpoint).toBeDefined();

      const checkpoint = result._checkpoint as Record<string, unknown>;
      expect(checkpoint.timestamp).toBe('2025-01-15T10:30:00Z');
      expect(checkpoint.phase).toBe('ideate');
      expect(checkpoint.operationsSince).toBe(0);
      expect(checkpoint.fixCycleCount).toBe(0);
      expect(checkpoint.staleAfterMinutes).toBe(120);
    });
  });

  describe('MigrateState_V1_0ToV1_1_NormalizesLegacyAssignee', () => {
    it('should normalize "jules" assignee to "subagent" during migration', () => {
      const v1_0 = makeV1_0State();
      v1_0.tasks = [
        { id: '001', title: 'Task A', status: 'complete', assignee: 'jules' },
        { id: '002', title: 'Task B', status: 'pending', assignee: 'subagent' },
        { id: '003', title: 'Task C', status: 'pending', assignee: 'manual' },
      ] as never;

      const result = migrateState(v1_0) as Record<string, unknown>;
      const tasks = result.tasks as Array<Record<string, unknown>>;

      expect(tasks[0].assignee).toBe('subagent');
      expect(tasks[1].assignee).toBe('subagent');
      expect(tasks[2].assignee).toBe('manual');
    });
  });

  describe('MigrateState_AlreadyCurrent_PassesThrough', () => {
    it('should return v1.1 state unchanged', () => {
      const v1_1 = makeV1_1State();
      const result = migrateState(v1_1);

      expect(result).toEqual(v1_1);
    });
  });

  describe('MigrateState_UnknownVersion_ReturnsMigrationFailed', () => {
    it('should throw MIGRATION_FAILED error for unknown version v2.0', () => {
      const futureState = { ...makeV1_1State(), version: '2.0' };

      expect(() => migrateState(futureState)).toThrow('MIGRATION_FAILED');
    });

    it('should throw MIGRATION_FAILED error for missing version field', () => {
      const noVersion = { featureId: 'test' };

      expect(() => migrateState(noVersion)).toThrow('MIGRATION_FAILED');
    });
  });

  describe('MigrateState_MigrationChain_V1_0ToV1_1ToV1_2', () => {
    it('should chain migrations from v1.0 through v1.1 to v1.2 (if registered)', () => {
      // This test validates that chain migration works.
      // We test with v1.0 input — it should first migrate to v1.1,
      // then (if v1.2 migration is registered) to v1.2.
      // For now, v1.0 -> v1.1 is the only real chain.
      const v1_0 = makeV1_0State();
      const result = migrateState(v1_0) as Record<string, unknown>;

      // After chain migration, should be at CURRENT_VERSION
      expect(result.version).toBe(CURRENT_VERSION);
      // All v1.1 fields should be present
      expect(result._history).toBeDefined();
      expect(result._events).toBeDefined();
      expect(result._eventSequence).toBeDefined();
      expect(result._checkpoint).toBeDefined();
    });
  });

  describe('CURRENT_VERSION export', () => {
    it('should export CURRENT_VERSION as 1.1', () => {
      expect(CURRENT_VERSION).toBe('1.1');
    });
  });
});
