import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeAutoRegressionCase } from './regression-eval-generator.js';
import type { GeneratedRegressionCase } from './regression-eval-generator.js';
import type { EvalCase } from '../evals/types.js';
import { mkdtemp, rm, readFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// ─── Test Helpers ───────────────────────────────────────────────────────────

function createTestEvalCase(overrides?: Partial<EvalCase>): EvalCase {
  return {
    id: 'test-case-001',
    type: 'single',
    description: 'Auto-generated regression case',
    input: { tool: 'exarchos_workflow', action: 'set' },
    expected: { phase: 'delegate' },
    tags: ['auto-regression'],
    layer: 'regression',
    ...overrides,
  };
}

function createTestGeneratedCase(overrides?: Partial<GeneratedRegressionCase>): GeneratedRegressionCase {
  return {
    caseId: 'reg-auto-001',
    skill: 'delegation',
    evalCase: createTestEvalCase(),
    ...overrides,
  };
}

// ─── writeAutoRegressionCase Tests ──────────────────────────────────────────

describe('writeAutoRegressionCase', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'regression-eval-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('WriteAutoRegression_NewCase_AppendsToDataset', async () => {
    // Arrange — pre-create the dataset with one existing case
    const datasetDir = join(tempDir, 'delegation', 'datasets');
    await mkdir(datasetDir, { recursive: true });
    const existingCase = createTestEvalCase({ id: 'existing-001' });
    await writeFile(
      join(datasetDir, 'auto-regression.jsonl'),
      JSON.stringify(existingCase) + '\n',
    );

    const newCase = createTestGeneratedCase({
      caseId: 'reg-auto-002',
      evalCase: createTestEvalCase({ id: 'reg-auto-002' }),
    });

    // Act
    const result = await writeAutoRegressionCase(newCase, tempDir);

    // Assert
    expect(result.written).toBe(true);
    expect(result.path).toBe(join(datasetDir, 'auto-regression.jsonl'));

    const content = await readFile(result.path, 'utf-8');
    const lines = content.trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[1]).id).toBe('reg-auto-002');
  });

  it('WriteAutoRegression_DatasetDoesNotExist_CreatesFile', async () => {
    // Arrange — no pre-existing directory or file
    const generatedCase = createTestGeneratedCase();

    // Act
    const result = await writeAutoRegressionCase(generatedCase, tempDir);

    // Assert
    expect(result.written).toBe(true);
    const expectedPath = join(tempDir, 'delegation', 'datasets', 'auto-regression.jsonl');
    expect(result.path).toBe(expectedPath);

    const content = await readFile(expectedPath, 'utf-8');
    const lines = content.trim().split('\n');
    expect(lines).toHaveLength(1);

    const parsed = JSON.parse(lines[0]);
    expect(parsed.id).toBe('test-case-001');
    expect(parsed.type).toBe('single');
    expect(parsed.tags).toContain('auto-regression');
  });

  it('WriteAutoRegression_DuplicateCase_SkipsWrite', async () => {
    // Arrange — pre-create the dataset with a case that has the same id
    const datasetDir = join(tempDir, 'delegation', 'datasets');
    await mkdir(datasetDir, { recursive: true });
    const existingCase = createTestEvalCase({ id: 'reg-auto-001' });
    await writeFile(
      join(datasetDir, 'auto-regression.jsonl'),
      JSON.stringify(existingCase) + '\n',
    );

    const duplicateCase = createTestGeneratedCase({
      caseId: 'reg-auto-001',
      evalCase: createTestEvalCase({ id: 'reg-auto-001' }),
    });

    // Act
    const result = await writeAutoRegressionCase(duplicateCase, tempDir);

    // Assert
    expect(result.written).toBe(false);
    expect(result.reason).toBeDefined();
    expect(result.reason).toContain('duplicate');

    // File should remain unchanged (still one line)
    const content = await readFile(result.path, 'utf-8');
    const lines = content.trim().split('\n');
    expect(lines).toHaveLength(1);
  });

  it('WriteAutoRegression_ValidCase_ValidJSONLFormat', async () => {
    // Arrange
    const case1 = createTestGeneratedCase({
      caseId: 'reg-jsonl-001',
      evalCase: createTestEvalCase({ id: 'reg-jsonl-001', description: 'First case' }),
    });
    const case2 = createTestGeneratedCase({
      caseId: 'reg-jsonl-002',
      evalCase: createTestEvalCase({ id: 'reg-jsonl-002', description: 'Second case' }),
    });

    // Act — write two cases sequentially
    await writeAutoRegressionCase(case1, tempDir);
    await writeAutoRegressionCase(case2, tempDir);

    // Assert — each line must be valid JSON
    const filePath = join(tempDir, 'delegation', 'datasets', 'auto-regression.jsonl');
    const content = await readFile(filePath, 'utf-8');
    const lines = content.trim().split('\n');

    expect(lines).toHaveLength(2);

    for (const line of lines) {
      const parsed = JSON.parse(line);
      // Must have required EvalCase fields
      expect(parsed.id).toBeDefined();
      expect(parsed.type).toBeDefined();
      expect(parsed.description).toBeDefined();
      expect(parsed.input).toBeDefined();
      expect(parsed.expected).toBeDefined();
      expect(parsed.tags).toBeDefined();
    }

    // Verify distinct cases
    expect(JSON.parse(lines[0]).id).toBe('reg-jsonl-001');
    expect(JSON.parse(lines[1]).id).toBe('reg-jsonl-002');
  });
});
