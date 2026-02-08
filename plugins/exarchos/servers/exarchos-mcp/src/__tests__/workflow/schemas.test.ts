import { describe, it, expect } from 'vitest';
import {
  FeaturePhaseSchema,
  DebugPhaseSchema,
  RefactorPhaseSchema,
  EventTypeSchema,
  EventSchema,
  CheckpointStateSchema,
  CheckpointMetaSchema,
  TaskSchema,
  WorktreeSchema,
  SynthesisSchema,
  FeatureWorkflowStateSchema,
  DebugWorkflowStateSchema,
  RefactorWorkflowStateSchema,
  WorkflowStateSchema,
  InitInputSchema,
  ListInputSchema,
  GetInputSchema,
  SetInputSchema,
  SummaryInputSchema,
  ReconcileInputSchema,
  NextActionInputSchema,
  TransitionsInputSchema,
  CancelInputSchema,
  CheckpointInputSchema,
  ErrorCode,
  isReservedField,
  WorkflowTypeSchema,
} from '../../workflow/schemas.js';

// Helper to create a minimal valid checkpoint state
function makeCheckpointState() {
  return {
    timestamp: '2025-01-15T10:00:00Z',
    phase: 'ideate',
    summary: 'Initial checkpoint',
    operationsSince: 0,
    fixCycleCount: 0,
    lastActivityTimestamp: '2025-01-15T10:00:00Z',
    staleAfterMinutes: 120,
  };
}

// Helper to create a minimal valid feature workflow state
function makeValidFeatureState() {
  return {
    version: '1.1',
    workflowType: 'feature' as const,
    featureId: 'my-feature-123',
    createdAt: '2025-01-15T10:00:00Z',
    updatedAt: '2025-01-15T10:30:00Z',
    phase: 'ideate',
    artifacts: {
      design: null,
      plan: null,
      pr: null,
    },
    tasks: [],
    worktrees: {},
    julesSessions: {},
    reviews: {},
    synthesis: {
      integrationBranch: null,
      mergeOrder: [],
      mergedBranches: [],
      prUrl: null,
      prFeedback: [],
    },
    _history: {},
    _events: [],
    _eventSequence: 0,
    _checkpoint: makeCheckpointState(),
  };
}

describe('Workflow State Schemas', () => {
  describe('WorkflowStateSchema — Valid Feature State Parses', () => {
    it('should parse a valid feature state object with all required fields', () => {
      const state = makeValidFeatureState();
      const result = FeatureWorkflowStateSchema.safeParse(state);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.featureId).toBe('my-feature-123');
        expect(result.data.phase).toBe('ideate');
        expect(result.data.workflowType).toBe('feature');
      }
    });

    it('should apply defaults for version, _history, _events, _eventSequence', () => {
      const state = makeValidFeatureState();
      // Remove fields that have defaults
      const { version, _history, _events, _eventSequence, ...rest } = state;
      const result = FeatureWorkflowStateSchema.safeParse(rest);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.version).toBe('1.1');
        expect(result.data._history).toEqual({});
        expect(result.data._events).toEqual([]);
        expect(result.data._eventSequence).toBe(0);
      }
    });

    it('should parse a valid debug workflow state', () => {
      const state = {
        ...makeValidFeatureState(),
        workflowType: 'debug' as const,
        phase: 'triage',
      };
      const result = DebugWorkflowStateSchema.safeParse(state);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.phase).toBe('triage');
        expect(result.data.workflowType).toBe('debug');
      }
    });

    it('should parse a valid refactor workflow state', () => {
      const state = {
        ...makeValidFeatureState(),
        workflowType: 'refactor' as const,
        phase: 'explore',
      };
      const result = RefactorWorkflowStateSchema.safeParse(state);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.phase).toBe('explore');
        expect(result.data.workflowType).toBe('refactor');
      }
    });
  });

  describe('WorkflowStateSchema — Invalid Phase Rejects With Error', () => {
    it('should reject an invalid feature phase value', () => {
      const state = {
        ...makeValidFeatureState(),
        phase: 'nonexistent-phase',
      };
      const result = FeatureWorkflowStateSchema.safeParse(state);

      expect(result.success).toBe(false);
      if (!result.success) {
        const phaseIssue = result.error.issues.find(
          (i) => i.path.includes('phase'),
        );
        expect(phaseIssue).toBeDefined();
      }
    });

    it('should reject an invalid debug phase value', () => {
      const state = {
        ...makeValidFeatureState(),
        workflowType: 'debug' as const,
        phase: 'ideate', // not a valid debug phase
      };
      const result = DebugWorkflowStateSchema.safeParse(state);

      expect(result.success).toBe(false);
    });

    it('should reject an invalid refactor phase value', () => {
      const state = {
        ...makeValidFeatureState(),
        workflowType: 'refactor' as const,
        phase: 'triage', // not a valid refactor phase
      };
      const result = RefactorWorkflowStateSchema.safeParse(state);

      expect(result.success).toBe(false);
    });

    it('should reject featureId with invalid characters', () => {
      const state = {
        ...makeValidFeatureState(),
        featureId: 'My Feature!',
      };
      const result = FeatureWorkflowStateSchema.safeParse(state);

      expect(result.success).toBe(false);
    });

    it('should reject empty featureId', () => {
      const state = {
        ...makeValidFeatureState(),
        featureId: '',
      };
      const result = FeatureWorkflowStateSchema.safeParse(state);

      expect(result.success).toBe(false);
    });
  });

  describe('ToolInputSchemas — All Ten Tools Validate Correctly', () => {
    it('init — accepts valid input with featureId and workflowType', () => {
      const result = InitInputSchema.safeParse({
        featureId: 'test-feature',
        workflowType: 'feature',
      });
      expect(result.success).toBe(true);
    });

    it('init — rejects missing featureId', () => {
      const result = InitInputSchema.safeParse({ workflowType: 'feature' });
      expect(result.success).toBe(false);
    });

    it('init — rejects invalid workflowType', () => {
      const result = InitInputSchema.safeParse({
        featureId: 'test',
        workflowType: 'invalid',
      });
      expect(result.success).toBe(false);
    });

    it('list — accepts empty object', () => {
      const result = ListInputSchema.safeParse({});
      expect(result.success).toBe(true);
    });

    it('get — accepts featureId with optional query', () => {
      const result = GetInputSchema.safeParse({
        featureId: 'test-feature',
        query: '.phase',
      });
      expect(result.success).toBe(true);
    });

    it('get — accepts featureId without query', () => {
      const result = GetInputSchema.safeParse({
        featureId: 'test-feature',
      });
      expect(result.success).toBe(true);
    });

    it('set — accepts featureId with updates', () => {
      const result = SetInputSchema.safeParse({
        featureId: 'test-feature',
        updates: { 'artifacts.design': 'path/to/design.md' },
      });
      expect(result.success).toBe(true);
    });

    it('set — accepts featureId with phase', () => {
      const result = SetInputSchema.safeParse({
        featureId: 'test-feature',
        phase: 'plan',
      });
      expect(result.success).toBe(true);
    });

    it('summary — accepts featureId', () => {
      const result = SummaryInputSchema.safeParse({
        featureId: 'test-feature',
      });
      expect(result.success).toBe(true);
    });

    it('reconcile — accepts featureId', () => {
      const result = ReconcileInputSchema.safeParse({
        featureId: 'test-feature',
      });
      expect(result.success).toBe(true);
    });

    it('next-action — accepts featureId', () => {
      const result = NextActionInputSchema.safeParse({
        featureId: 'test-feature',
      });
      expect(result.success).toBe(true);
    });

    it('transitions — accepts workflowType with optional fromPhase', () => {
      const result = TransitionsInputSchema.safeParse({
        workflowType: 'debug',
        fromPhase: 'triage',
      });
      expect(result.success).toBe(true);
    });

    it('transitions — accepts workflowType without fromPhase', () => {
      const result = TransitionsInputSchema.safeParse({
        workflowType: 'refactor',
      });
      expect(result.success).toBe(true);
    });

    it('cancel — accepts featureId with optional reason and dryRun', () => {
      const result = CancelInputSchema.safeParse({
        featureId: 'test-feature',
        reason: 'No longer needed',
        dryRun: true,
      });
      expect(result.success).toBe(true);
    });

    it('cancel — accepts featureId alone', () => {
      const result = CancelInputSchema.safeParse({
        featureId: 'test-feature',
      });
      expect(result.success).toBe(true);
    });

    it('checkpoint — accepts featureId with optional summary', () => {
      const result = CheckpointInputSchema.safeParse({
        featureId: 'test-feature',
        summary: 'Midpoint checkpoint',
      });
      expect(result.success).toBe(true);
    });

    it('checkpoint — accepts featureId alone', () => {
      const result = CheckpointInputSchema.safeParse({
        featureId: 'test-feature',
      });
      expect(result.success).toBe(true);
    });
  });

  describe('EventSchema — Valid Event Parses With Sequence And Version', () => {
    it('should parse a valid transition event', () => {
      const event = {
        sequence: 1,
        version: '1.0',
        timestamp: '2025-01-15T10:00:00Z',
        type: 'transition',
        from: 'ideate',
        to: 'plan',
        trigger: 'design-approved',
      };
      const result = EventSchema.safeParse(event);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.sequence).toBe(1);
        expect(result.data.version).toBe('1.0');
        expect(result.data.type).toBe('transition');
      }
    });

    it('should parse an event with metadata', () => {
      const event = {
        sequence: 2,
        version: '1.0',
        timestamp: '2025-01-15T10:05:00Z',
        type: 'checkpoint',
        trigger: 'manual',
        metadata: { operationCount: 42 },
      };
      const result = EventSchema.safeParse(event);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.metadata).toEqual({ operationCount: 42 });
      }
    });

    it('should reject event with invalid sequence (zero)', () => {
      const event = {
        sequence: 0,
        version: '1.0',
        timestamp: '2025-01-15T10:00:00Z',
        type: 'transition',
        trigger: 'test',
      };
      const result = EventSchema.safeParse(event);
      expect(result.success).toBe(false);
    });

    it('should reject event with negative sequence', () => {
      const event = {
        sequence: -1,
        version: '1.0',
        timestamp: '2025-01-15T10:00:00Z',
        type: 'transition',
        trigger: 'test',
      };
      const result = EventSchema.safeParse(event);
      expect(result.success).toBe(false);
    });

    it('should reject event with wrong version', () => {
      const event = {
        sequence: 1,
        version: '2.0',
        timestamp: '2025-01-15T10:00:00Z',
        type: 'transition',
        trigger: 'test',
      };
      const result = EventSchema.safeParse(event);
      expect(result.success).toBe(false);
    });

    it('should reject event with invalid type', () => {
      const event = {
        sequence: 1,
        version: '1.0',
        timestamp: '2025-01-15T10:00:00Z',
        type: 'invalid-type',
        trigger: 'test',
      };
      const result = EventSchema.safeParse(event);
      expect(result.success).toBe(false);
    });

    it('should validate all event types', () => {
      const eventTypes = [
        'transition',
        'checkpoint',
        'guard-failed',
        'compound-entry',
        'compound-exit',
        'fix-cycle',
        'circuit-open',
        'compensation',
        'cancel',
        'field-update',
      ];

      for (const type of eventTypes) {
        const result = EventTypeSchema.safeParse(type);
        expect(result.success).toBe(true);
      }
    });
  });

  describe('ReservedFieldPath — Underscore Prefix Rejected', () => {
    it('should identify top-level underscore-prefixed path as reserved', () => {
      expect(isReservedField('_events')).toBe(true);
      expect(isReservedField('_history')).toBe(true);
      expect(isReservedField('_checkpoint')).toBe(true);
      expect(isReservedField('_eventSequence')).toBe(true);
    });

    it('should identify nested underscore-prefixed path as reserved', () => {
      expect(isReservedField('some.path._internal')).toBe(true);
      expect(isReservedField('deep.nested._field.value')).toBe(true);
    });

    it('should identify state-machine-managed fields as reserved', () => {
      expect(isReservedField('phase')).toBe(true);
      expect(isReservedField('workflowType')).toBe(true);
      expect(isReservedField('featureId')).toBe(true);
      expect(isReservedField('createdAt')).toBe(true);
      expect(isReservedField('version')).toBe(true);
    });

    it('should allow user-writable paths', () => {
      expect(isReservedField('artifacts.design')).toBe(false);
      expect(isReservedField('tasks')).toBe(false);
      expect(isReservedField('synthesis.prUrl')).toBe(false);
    });

    it('should handle edge cases', () => {
      expect(isReservedField('')).toBe(false);
      expect(isReservedField('_')).toBe(true);
      expect(isReservedField('a._b.c')).toBe(true);
    });
  });

  describe('Phase Schemas', () => {
    it('should validate all feature phases', () => {
      const phases = ['ideate', 'plan', 'delegate', 'integrate', 'review', 'synthesize', 'completed', 'cancelled', 'blocked'];
      for (const phase of phases) {
        expect(FeaturePhaseSchema.safeParse(phase).success).toBe(true);
      }
    });

    it('should validate all debug phases', () => {
      const phases = ['triage', 'investigate', 'rca', 'design', 'implement', 'validate', 'review', 'synthesize', 'completed', 'cancelled', 'blocked'];
      for (const phase of phases) {
        expect(DebugPhaseSchema.safeParse(phase).success).toBe(true);
      }
    });

    it('should validate debug compound sub-state phase names (Bug 5)', () => {
      const compoundPhases = [
        'debug-implement', 'debug-validate', 'debug-review',
        'hotfix-implement', 'hotfix-validate',
      ];
      for (const phase of compoundPhases) {
        expect(DebugPhaseSchema.safeParse(phase).success, `Expected '${phase}' to be valid`).toBe(true);
      }
    });

    it('should validate all refactor phases', () => {
      const phases = ['explore', 'brief', 'synthesize', 'completed', 'cancelled', 'blocked'];
      for (const phase of phases) {
        expect(RefactorPhaseSchema.safeParse(phase).success, `Expected '${phase}' to be valid`).toBe(true);
      }
    });

    it('should validate refactor compound sub-state phase names (Bug 5)', () => {
      const compoundPhases = [
        'polish-implement', 'polish-validate', 'polish-update-docs',
        'overhaul-plan', 'overhaul-delegate', 'overhaul-integrate',
        'overhaul-review', 'overhaul-update-docs',
      ];
      for (const phase of compoundPhases) {
        expect(RefactorPhaseSchema.safeParse(phase).success, `Expected '${phase}' to be valid`).toBe(true);
      }
    });
  });

  describe('CheckpointStateSchema', () => {
    it('should parse a valid checkpoint state', () => {
      const result = CheckpointStateSchema.safeParse(makeCheckpointState());
      expect(result.success).toBe(true);
    });

    it('should apply default staleAfterMinutes', () => {
      const { staleAfterMinutes, ...rest } = makeCheckpointState();
      const result = CheckpointStateSchema.safeParse(rest);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.staleAfterMinutes).toBe(120);
      }
    });

    it('should reject negative operationsSince', () => {
      const result = CheckpointStateSchema.safeParse({
        ...makeCheckpointState(),
        operationsSince: -1,
      });
      expect(result.success).toBe(false);
    });
  });

  describe('CheckpointMetaSchema', () => {
    it('should parse full checkpoint meta (action needed)', () => {
      const meta = {
        checkpointAdvised: true,
        operationsSinceCheckpoint: 15,
        lastCheckpointPhase: 'delegate',
        lastCheckpointTimestamp: '2025-01-15T10:00:00Z',
        stale: false,
        minutesSinceActivity: 5,
      };
      const result = CheckpointMetaSchema.safeParse(meta);
      expect(result.success).toBe(true);
    });

    it('should parse slim checkpoint meta (no action needed)', () => {
      const meta = { checkpointAdvised: false };
      const result = CheckpointMetaSchema.safeParse(meta);
      expect(result.success).toBe(true);
    });
  });

  describe('TaskSchema', () => {
    it('should parse a valid task', () => {
      const task = {
        id: 'task-001',
        title: 'Implement schemas',
        status: 'pending',
      };
      const result = TaskSchema.safeParse(task);
      expect(result.success).toBe(true);
    });

    it('should parse a task with optional fields', () => {
      const task = {
        id: 'task-001',
        title: 'Implement schemas',
        status: 'in_progress',
        branch: 'feature/schemas',
        startedAt: '2025-01-15T10:00:00Z',
      };
      const result = TaskSchema.safeParse(task);
      expect(result.success).toBe(true);
    });

    it('should reject invalid status', () => {
      const task = {
        id: 'task-001',
        title: 'Implement schemas',
        status: 'unknown',
      };
      const result = TaskSchema.safeParse(task);
      expect(result.success).toBe(false);
    });
  });

  describe('WorktreeSchema', () => {
    it('should parse a valid worktree', () => {
      const wt = {
        branch: 'feature/task-001',
        taskId: 'task-001',
        status: 'active',
      };
      const result = WorktreeSchema.safeParse(wt);
      expect(result.success).toBe(true);
    });

    it('should reject invalid worktree status', () => {
      const wt = {
        branch: 'feature/task-001',
        taskId: 'task-001',
        status: 'deleted',
      };
      const result = WorktreeSchema.safeParse(wt);
      expect(result.success).toBe(false);
    });
  });

  describe('SynthesisSchema', () => {
    it('should parse valid synthesis state', () => {
      const synth = {
        integrationBranch: 'integrate/my-feature',
        mergeOrder: ['task-001', 'task-002'],
        mergedBranches: ['feature/task-001'],
        prUrl: 'https://github.com/org/repo/pull/1',
        prFeedback: [],
      };
      const result = SynthesisSchema.safeParse(synth);
      expect(result.success).toBe(true);
    });

    it('should accept null fields', () => {
      const synth = {
        integrationBranch: null,
        mergeOrder: [],
        mergedBranches: [],
        prUrl: null,
        prFeedback: [],
      };
      const result = SynthesisSchema.safeParse(synth);
      expect(result.success).toBe(true);
    });
  });

  describe('IntegrationSchema — Guard Field Preserved Through Zod Parsing', () => {
    it('should preserve integration.passed = true through safeParse', () => {
      const state = {
        ...makeValidFeatureState(),
        integration: { passed: true },
      };
      const result = FeatureWorkflowStateSchema.safeParse(state);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.integration).toEqual({ passed: true });
      }
    });

    it('should preserve integration.passed = false through safeParse', () => {
      const state = {
        ...makeValidFeatureState(),
        integration: { passed: false },
      };
      const result = FeatureWorkflowStateSchema.safeParse(state);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.integration).toEqual({ passed: false });
      }
    });

    it('should default integration to null when not provided', () => {
      const state = makeValidFeatureState();
      const result = FeatureWorkflowStateSchema.safeParse(state);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.integration).toBeNull();
      }
    });

    it('should allow integration to be explicitly null', () => {
      const state = {
        ...makeValidFeatureState(),
        integration: null,
      };
      const result = FeatureWorkflowStateSchema.safeParse(state);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.integration).toBeNull();
      }
    });
  });

  describe('ErrorCode', () => {
    it('should have all expected error codes', () => {
      expect(ErrorCode.STATE_NOT_FOUND).toBe('STATE_NOT_FOUND');
      expect(ErrorCode.STATE_ALREADY_EXISTS).toBe('STATE_ALREADY_EXISTS');
      expect(ErrorCode.STATE_CORRUPT).toBe('STATE_CORRUPT');
      expect(ErrorCode.MIGRATION_FAILED).toBe('MIGRATION_FAILED');
      expect(ErrorCode.INVALID_TRANSITION).toBe('INVALID_TRANSITION');
      expect(ErrorCode.GUARD_FAILED).toBe('GUARD_FAILED');
      expect(ErrorCode.CIRCUIT_OPEN).toBe('CIRCUIT_OPEN');
      expect(ErrorCode.INVALID_INPUT).toBe('INVALID_INPUT');
      expect(ErrorCode.RESERVED_FIELD).toBe('RESERVED_FIELD');
      expect(ErrorCode.ALREADY_CANCELLED).toBe('ALREADY_CANCELLED');
      expect(ErrorCode.COMPENSATION_PARTIAL).toBe('COMPENSATION_PARTIAL');
      expect(ErrorCode.FILE_IO_ERROR).toBe('FILE_IO_ERROR');
    });
  });

  describe('WorkflowStateSchema_DynamicFields_PreservedAfterParse', () => {
    it('should preserve dynamic fields on feature state after parsing', () => {
      const featureState = {
        ...makeValidFeatureState(),
        planReview: { approved: true, gapsFound: false, gaps: [] },
      };
      const result = FeatureWorkflowStateSchema.safeParse(featureState);
      expect(result.success).toBe(true);
      if (result.success) {
        expect((result.data as Record<string, unknown>).planReview).toEqual({
          approved: true,
          gapsFound: false,
          gaps: [],
        });
      }
    });

    it('should preserve dynamic fields on refactor state after parsing', () => {
      const refactorState = {
        ...makeValidFeatureState(),
        workflowType: 'refactor' as const,
        phase: 'explore' as const,
        track: 'polish',
        explore: {
          startedAt: '2025-01-15T10:00:00Z',
          completedAt: null,
          scopeAssessment: { filesAffected: 5, recommendedTrack: 'polish' },
        },
      };
      const result = RefactorWorkflowStateSchema.safeParse(refactorState);
      expect(result.success).toBe(true);
      if (result.success) {
        const data = result.data as Record<string, unknown>;
        expect(data.track).toBe('polish');
        expect(data.explore).toBeDefined();
      }
    });

    it('should preserve dynamic fields through discriminated union parsing', () => {
      const featureState = {
        ...makeValidFeatureState(),
        planReview: { approved: true },
      };
      const result = WorkflowStateSchema.safeParse(featureState);
      expect(result.success).toBe(true);
      if (result.success) {
        expect((result.data as Record<string, unknown>).planReview).toEqual({ approved: true });
      }
    });
  });
});
