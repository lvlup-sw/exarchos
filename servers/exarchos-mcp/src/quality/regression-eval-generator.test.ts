import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { WorkflowEvent } from '../event-store/schemas.js';
import type { QualityRegression, GateMetrics } from '../views/code-quality-view.js';
import type { GeneratedRegressionCase } from './regression-eval-generator.js';
import type { EvalCase } from '../evals/types.js';
import { mkdtemp, rm, readFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// ─── Test Helpers (generateRegressionEval) ──────────────────────────────────

type SignalConfidence = 'high' | 'medium' | 'low';

function makeRegression(overrides: Partial<QualityRegression> = {}): QualityRegression {
  return {
    skill: 'delegation',
    gate: 'typecheck',
    consecutiveFailures: 4,
    firstFailureCommit: 'abc111',
    lastFailureCommit: 'def444',
    detectedAt: '2026-02-25T00:00:00.000Z',
    ...overrides,
  };
}

function makeTrace(overrides: Partial<WorkflowEvent> = {}): WorkflowEvent {
  return {
    streamId: 'test-stream',
    sequence: 1,
    timestamp: '2026-02-25T00:00:00.000Z',
    type: 'gate.executed',
    schemaVersion: '1.0',
    data: {
      gateName: 'typecheck',
      layer: 'regression',
      passed: false,
      duration: 1200,
      details: { reason: 'Type error in delegation module' },
    },
    ...overrides,
  };
}

function makeGateMetrics(overrides: Partial<GateMetrics> = {}): GateMetrics {
  return {
    gate: 'typecheck',
    executionCount: 10,
    passRate: 0.6,
    avgDuration: 1500,
    failureReasons: [
      { reason: 'Type error in delegation module', count: 4 },
    ],
    ...overrides,
  };
}

// ─── Test Helpers (writeAutoRegressionCase) ─────────────────────────────────

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
    source: 'auto-generated',
    trigger: makeRegression(),
    caseId: 'reg-auto-001',
    skill: 'delegation',
    evalCase: createTestEvalCase(),
    ...overrides,
  };
}

// ─── Tests: generateRegressionEval ──────────────────────────────────────────

describe('generateRegressionEval', () => {
  it('GenerateRegressionEval_WithTraces_ReturnsEvalCase', async () => {
    const { generateRegressionEval } = await import('./regression-eval-generator.js');

    const regression = makeRegression();
    const traces = [makeTrace()];
    const gateMetrics = makeGateMetrics();
    const confidence: SignalConfidence = 'high';

    const result = generateRegressionEval(regression, traces, gateMetrics, confidence);

    expect(result).not.toBeNull();
    expect(result!.source).toBe('auto-generated');
    expect(result!.trigger).toEqual(regression);
    expect(result!.evalCase).toBeDefined();
    expect(result!.evalCase.id).toBeDefined();
    expect(result!.evalCase.type).toBeDefined();
    expect(result!.evalCase.description).toBeDefined();
    expect(result!.evalCase.input).toBeDefined();
    expect(result!.evalCase.expected).toBeDefined();
  });

  it('GenerateRegressionEval_NoTraces_ReturnsNull', async () => {
    const { generateRegressionEval } = await import('./regression-eval-generator.js');

    const regression = makeRegression();
    const traces: WorkflowEvent[] = [];
    const gateMetrics = makeGateMetrics();
    const confidence: SignalConfidence = 'high';

    const result = generateRegressionEval(regression, traces, gateMetrics, confidence);

    expect(result).toBeNull();
  });

  it('GenerateRegressionEval_LowConfidence_ReturnsNull', async () => {
    const { generateRegressionEval } = await import('./regression-eval-generator.js');

    const regression = makeRegression();
    const traces = [makeTrace()];
    const gateMetrics = makeGateMetrics();
    const confidence: SignalConfidence = 'low';

    const result = generateRegressionEval(regression, traces, gateMetrics, confidence);

    expect(result).toBeNull();
  });

  it('GenerateRegressionEval_ValidRegression_IncludesFailurePattern', async () => {
    const { generateRegressionEval } = await import('./regression-eval-generator.js');

    const regression = makeRegression({
      gate: 'typecheck',
      skill: 'delegation',
      consecutiveFailures: 5,
    });
    const traces = [makeTrace()];
    const gateMetrics = makeGateMetrics({
      failureReasons: [{ reason: 'Type error in delegation module', count: 5 }],
    });
    const confidence: SignalConfidence = 'high';

    const result = generateRegressionEval(regression, traces, gateMetrics, confidence);

    expect(result).not.toBeNull();
    // The failure pattern from the regression should be reflected in the eval case
    expect(result!.evalCase.description).toContain('typecheck');
    expect(result!.evalCase.description).toContain('delegation');
    expect(result!.evalCase.expected).toHaveProperty('failurePattern');
  });

  it('GenerateRegressionEval_GeneratedCase_HasAutoGeneratedTag', async () => {
    const { generateRegressionEval } = await import('./regression-eval-generator.js');

    const regression = makeRegression();
    const traces = [makeTrace()];
    const gateMetrics = makeGateMetrics();
    const confidence: SignalConfidence = 'medium';

    const result = generateRegressionEval(regression, traces, gateMetrics, confidence);

    expect(result).not.toBeNull();
    expect(result!.evalCase.tags).toContain('auto-generated');
  });

  it('GenerateRegressionEval_GeneratedCase_HasCapabilityLayer', async () => {
    const { generateRegressionEval } = await import('./regression-eval-generator.js');

    const regression = makeRegression();
    const traces = [makeTrace()];
    const gateMetrics = makeGateMetrics();
    const confidence: SignalConfidence = 'medium';

    const result = generateRegressionEval(regression, traces, gateMetrics, confidence);

    expect(result).not.toBeNull();
    expect(result!.evalCase.layer).toBe('capability');
  });
});

// ─── Tests: writeAutoRegressionCase ─────────────────────────────────────────

describe('writeAutoRegressionCase', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'regression-eval-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('WriteAutoRegression_NewCase_AppendsToDataset', async () => {
    const { writeAutoRegressionCase } = await import('./regression-eval-generator.js');

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
    const { writeAutoRegressionCase } = await import('./regression-eval-generator.js');

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
    const { writeAutoRegressionCase } = await import('./regression-eval-generator.js');

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
    const { writeAutoRegressionCase } = await import('./regression-eval-generator.js');

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
