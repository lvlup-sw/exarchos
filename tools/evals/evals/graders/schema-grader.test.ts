import { describe, it, expect } from 'vitest';
import { SchemaGrader } from './schema-grader.js';

describe('SchemaGrader', () => {
  const grader = new SchemaGrader();

  it('Name_ReturnsSchema', () => {
    expect(grader.name).toBe('schema');
    expect(grader.type).toBe('schema');
  });

  it('Grade_ValidTaskDecomposition_ReturnsScoreOne', async () => {
    const result = await grader.grade(
      {},
      { taskId: 'T1', title: 'Do the thing', status: 'pending' },
      {},
      { schema: 'task-decomposition' }
    );
    expect(result.score).toBe(1.0);
    expect(result.passed).toBe(true);
  });

  it('Grade_ValidReviewFinding_ReturnsScoreOne', async () => {
    const result = await grader.grade(
      {},
      { severity: 'high', category: 'security', message: 'SQL injection' },
      {},
      { schema: 'review-finding' }
    );
    expect(result.score).toBe(1.0);
    expect(result.passed).toBe(true);
  });

  it('Grade_MissingRequiredField_ReturnsScoreZero', async () => {
    const result = await grader.grade(
      {},
      { taskId: 'T1', title: 'Do the thing' },
      {},
      { schema: 'task-decomposition' }
    );
    expect(result.score).toBe(0.0);
    expect(result.passed).toBe(false);
  });

  it('Grade_WrongFieldType_ReturnsScoreZero', async () => {
    const result = await grader.grade(
      {},
      { taskId: 123, title: 'Do the thing', status: 'pending' },
      {},
      { schema: 'task-decomposition' }
    );
    expect(result.score).toBe(0.0);
    expect(result.passed).toBe(false);
  });

  it('Grade_ExtraFieldsNonStrict_ReturnsScoreOne', async () => {
    const result = await grader.grade(
      {},
      { taskId: 'T1', title: 'Do it', status: 'done', extra: 'field' },
      {},
      { schema: 'task-decomposition' }
    );
    expect(result.score).toBe(1.0);
    expect(result.passed).toBe(true);
  });

  it('Grade_ExtraFieldsStrict_ReturnsScoreZero', async () => {
    const result = await grader.grade(
      {},
      { taskId: 'T1', title: 'Do it', status: 'done', extra: 'field' },
      {},
      { schema: 'task-decomposition', strict: true }
    );
    expect(result.score).toBe(0.0);
    expect(result.passed).toBe(false);
  });

  /** The `title` of `task-decomposition` is a string, so a nested object fails. */
  it('Grade_NestedObjectValidation_Works', async () => {
    const result = await grader.grade(
      {},
      { taskId: 'T1', title: { nested: true }, status: 'done' },
      {},
      { schema: 'task-decomposition' }
    );
    expect(result.score).toBe(0.0);
    expect(result.passed).toBe(false);
  });

  it('Grade_ArrayInsteadOfObject_ReturnsScoreZero', async () => {
    const result = await grader.grade(
      {},
      { output: [1, 2, 3] } as Record<string, unknown>,
      {},
      { schema: 'task-decomposition' }
    );
    expect(result.score).toBe(0.0);
  });

  it('Grade_UnknownSchemaName_Throws', async () => {
    await expect(
      grader.grade({}, {}, {}, { schema: 'nonexistent' })
    ).rejects.toThrow();
  });

  it('Grade_ValidationError_ReasonIncludesFieldName', async () => {
    const result = await grader.grade(
      {},
      { taskId: 'T1', title: 'Do it' },
      {},
      { schema: 'task-decomposition' }
    );
    expect(result.reason).toContain('status');
  });

  it('Grade_MissingSchemaConfig_Throws', async () => {
    await expect(grader.grade({}, {}, {}, {})).rejects.toThrow();
    await expect(grader.grade({}, {}, {})).rejects.toThrow();
  });
});
