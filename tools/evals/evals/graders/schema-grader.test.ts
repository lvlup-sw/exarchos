import { describe, it, expect } from 'vitest';
import { SchemaGrader } from './schema-grader.js';

describe('SchemaGrader', () => {
  const grader = new SchemaGrader();

  it('Name_ReturnsSchema', () => {
    expect(grader.name).toBe('schema');
    expect(grader.type).toBe('schema');
  });

  // ─── Valid output ───────────────────────────────────────────────────

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

  // ─── Missing field ──────────────────────────────────────────────────

  it('Grade_MissingRequiredField_ReturnsScoreZero', async () => {
    const result = await grader.grade(
      {},
      { taskId: 'T1', title: 'Do the thing' }, // missing status
      {},
      { schema: 'task-decomposition' }
    );
    expect(result.score).toBe(0.0);
    expect(result.passed).toBe(false);
  });

  // ─── Wrong type ─────────────────────────────────────────────────────

  it('Grade_WrongFieldType_ReturnsScoreZero', async () => {
    const result = await grader.grade(
      {},
      { taskId: 123, title: 'Do the thing', status: 'pending' }, // taskId should be string
      {},
      { schema: 'task-decomposition' }
    );
    expect(result.score).toBe(0.0);
    expect(result.passed).toBe(false);
  });

  // ─── Extra fields (non-strict) ─────────────────────────────────────

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

  // ─── Extra fields (strict) ─────────────────────────────────────────

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

  // ─── Nested validation ─────────────────────────────────────────────

  it('Grade_NestedObjectValidation_Works', async () => {
    // task-decomposition expects flat strings, passing nested object as title should fail
    const result = await grader.grade(
      {},
      { taskId: 'T1', title: { nested: true }, status: 'done' },
      {},
      { schema: 'task-decomposition' }
    );
    expect(result.score).toBe(0.0);
    expect(result.passed).toBe(false);
  });

  // ─── Array validation ──────────────────────────────────────────────

  it('Grade_ArrayInsteadOfObject_ReturnsScoreZero', async () => {
    const result = await grader.grade(
      {},
      { output: [1, 2, 3] } as Record<string, unknown>,
      {},
      { schema: 'task-decomposition' }
    );
    expect(result.score).toBe(0.0);
  });

  // ─── Unknown schema name ───────────────────────────────────────────

  it('Grade_UnknownSchemaName_Throws', async () => {
    await expect(
      grader.grade({}, {}, {}, { schema: 'nonexistent' })
    ).rejects.toThrow();
  });

  // ─── Reason includes field name ─────────────────────────────────────

  it('Grade_ValidationError_ReasonIncludesFieldName', async () => {
    const result = await grader.grade(
      {},
      { taskId: 'T1', title: 'Do it' }, // missing status
      {},
      { schema: 'task-decomposition' }
    );
    expect(result.reason).toContain('status');
  });

  // ─── Missing config.schema ─────────────────────────────────────────

  it('Grade_MissingSchemaConfig_Throws', async () => {
    await expect(grader.grade({}, {}, {}, {})).rejects.toThrow();
    await expect(grader.grade({}, {}, {})).rejects.toThrow();
  });
});
