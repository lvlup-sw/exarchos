import { describe, it, expect } from 'vitest';
import {
  RemediationAttemptedDataSchema,
  RemediationSucceededDataSchema,
  EventTypes,
  EventDataMap,
} from '../schemas.js';

// ─── RemediationAttemptedDataSchema ─────────────────────────────────────────

describe('RemediationAttemptedDataSchema', () => {
  it('RemediationAttemptedSchema_ValidData_ParsesSuccessfully', () => {
    const result = RemediationAttemptedDataSchema.safeParse({
      taskId: 'task-001',
      skill: 'delegation',
      gateName: 'typecheck',
      attemptNumber: 1,
      strategy: 'Refactored type annotations to fix inference',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.taskId).toBe('task-001');
      expect(result.data.skill).toBe('delegation');
      expect(result.data.gateName).toBe('typecheck');
      expect(result.data.attemptNumber).toBe(1);
      expect(result.data.strategy).toBe('Refactored type annotations to fix inference');
    }
  });

  it('RemediationAttemptedSchema_MissingTaskId_ThrowsValidationError', () => {
    const result = RemediationAttemptedDataSchema.safeParse({
      skill: 'delegation',
      gateName: 'typecheck',
      attemptNumber: 1,
      strategy: 'Refactored type annotations',
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const paths = result.error.issues.map((i) => i.path.join('.'));
      expect(paths).toContain('taskId');
    }
  });

  it('RemediationAttemptedSchema_ZeroAttemptNumber_ThrowsValidationError', () => {
    const result = RemediationAttemptedDataSchema.safeParse({
      taskId: 'task-001',
      skill: 'delegation',
      gateName: 'typecheck',
      attemptNumber: 0,
      strategy: 'Tried something',
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const paths = result.error.issues.map((i) => i.path.join('.'));
      expect(paths).toContain('attemptNumber');
    }
  });

  it('RemediationAttemptedSchema_EmptySkill_ThrowsValidationError', () => {
    const result = RemediationAttemptedDataSchema.safeParse({
      taskId: 'task-001',
      skill: '',
      gateName: 'typecheck',
      attemptNumber: 1,
      strategy: 'Tried something',
    });
    expect(result.success).toBe(false);
  });

  it('RemediationAttemptedSchema_EmptyGateName_ThrowsValidationError', () => {
    const result = RemediationAttemptedDataSchema.safeParse({
      taskId: 'task-001',
      skill: 'delegation',
      gateName: '',
      attemptNumber: 1,
      strategy: 'Tried something',
    });
    expect(result.success).toBe(false);
  });

  it('RemediationAttemptedSchema_NegativeAttemptNumber_ThrowsValidationError', () => {
    const result = RemediationAttemptedDataSchema.safeParse({
      taskId: 'task-001',
      skill: 'delegation',
      gateName: 'typecheck',
      attemptNumber: -1,
      strategy: 'Tried something',
    });
    expect(result.success).toBe(false);
  });

  it('RemediationAttemptedSchema_NonIntegerAttemptNumber_ThrowsValidationError', () => {
    const result = RemediationAttemptedDataSchema.safeParse({
      taskId: 'task-001',
      skill: 'delegation',
      gateName: 'typecheck',
      attemptNumber: 1.5,
      strategy: 'Tried something',
    });
    expect(result.success).toBe(false);
  });

  it('RemediationAttemptedSchema_EmptyStrategy_ParsesSuccessfully', () => {
    // strategy is z.string() without min(1), so empty is valid
    const result = RemediationAttemptedDataSchema.safeParse({
      taskId: 'task-001',
      skill: 'delegation',
      gateName: 'typecheck',
      attemptNumber: 2,
      strategy: '',
    });
    expect(result.success).toBe(true);
  });
});

// ─── RemediationSucceededDataSchema ─────────────────────────────────────────

describe('RemediationSucceededDataSchema', () => {
  it('RemediationSucceededSchema_ValidData_ParsesSuccessfully', () => {
    const result = RemediationSucceededDataSchema.safeParse({
      taskId: 'task-001',
      skill: 'delegation',
      gateName: 'typecheck',
      totalAttempts: 3,
      finalStrategy: 'Added explicit return types',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.taskId).toBe('task-001');
      expect(result.data.skill).toBe('delegation');
      expect(result.data.gateName).toBe('typecheck');
      expect(result.data.totalAttempts).toBe(3);
      expect(result.data.finalStrategy).toBe('Added explicit return types');
    }
  });

  it('RemediationSucceededSchema_MissingTotalAttempts_ThrowsValidationError', () => {
    const result = RemediationSucceededDataSchema.safeParse({
      taskId: 'task-001',
      skill: 'delegation',
      gateName: 'typecheck',
      finalStrategy: 'Added explicit return types',
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const paths = result.error.issues.map((i) => i.path.join('.'));
      expect(paths).toContain('totalAttempts');
    }
  });

  it('RemediationSucceededSchema_ZeroTotalAttempts_ThrowsValidationError', () => {
    const result = RemediationSucceededDataSchema.safeParse({
      taskId: 'task-001',
      skill: 'delegation',
      gateName: 'typecheck',
      totalAttempts: 0,
      finalStrategy: 'Something',
    });
    expect(result.success).toBe(false);
  });

  it('RemediationSucceededSchema_EmptyTaskId_ThrowsValidationError', () => {
    const result = RemediationSucceededDataSchema.safeParse({
      taskId: '',
      skill: 'delegation',
      gateName: 'typecheck',
      totalAttempts: 1,
      finalStrategy: 'Something',
    });
    expect(result.success).toBe(false);
  });

  it('RemediationSucceededSchema_EmptyFinalStrategy_ParsesSuccessfully', () => {
    // finalStrategy is z.string() without min(1), so empty is valid
    const result = RemediationSucceededDataSchema.safeParse({
      taskId: 'task-001',
      skill: 'delegation',
      gateName: 'typecheck',
      totalAttempts: 1,
      finalStrategy: '',
    });
    expect(result.success).toBe(true);
  });
});

// ─── EventType Union and EventDataMap ──────────────────────────────────────

describe('EventDataMap_IncludesRemediationTypes_InUnion', () => {
  it('EventTypes_IncludesRemediationAttempted', () => {
    expect(EventTypes).toContain('remediation.attempted');
  });

  it('EventTypes_IncludesRemediationSucceeded', () => {
    expect(EventTypes).toContain('remediation.succeeded');
  });

  it('EventDataMap_RemediationAttempted_MapsToCorrectSchema', () => {
    // Verify the type-level mapping exists by checking the runtime map
    const map: EventDataMap = {} as EventDataMap;
    // TypeScript compilation validates that these keys exist on the type
    type AttemptedType = EventDataMap['remediation.attempted'];
    type SucceededType = EventDataMap['remediation.succeeded'];

    // Runtime check: ensure the keys are assignable
    const _attempted: AttemptedType = {
      taskId: 'task-001',
      skill: 'delegation',
      gateName: 'typecheck',
      attemptNumber: 1,
      strategy: 'test',
    };
    const _succeeded: SucceededType = {
      taskId: 'task-001',
      skill: 'delegation',
      gateName: 'typecheck',
      totalAttempts: 1,
      finalStrategy: 'test',
    };

    expect(_attempted.taskId).toBe('task-001');
    expect(_succeeded.taskId).toBe('task-001');
  });
});
