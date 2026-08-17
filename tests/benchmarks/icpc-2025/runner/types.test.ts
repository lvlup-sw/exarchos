import { describe, it, expect } from 'vitest';
import {
  BenchmarkRunSchema,
  ArmResultSchema,
  SampleResultSchema,
  ProblemResultSchema,
  ArmConfigSchema,
} from './types.js';

const validMetrics = {
  totalTokens: 1000,
  inputTokens: 800,
  outputTokens: 200,
  wallClockSeconds: 30,
  iterationCount: 3,
  linesOfCode: 50,
};

const validSampleResult = {
  sampleId: 1,
  verdict: 'pass' as const,
  expectedOutput: '42\n',
};

const validArmResult = {
  arm: 'exarchos' as const,
  verdict: 'pass' as const,
  sampleResults: [validSampleResult],
  metrics: validMetrics,
  solution: 'console.log(42)',
};

const validArmConfig = {
  id: 'exarchos' as const,
  name: 'Exarchos',
  description: 'Agent with Exarchos governance',
  promptTemplate: 'Solve the following problem: {{statement}}',
  mcpEnabled: true,
};

const validProblemResult = {
  problemId: 'A',
  title: 'Two Sum',
  arms: [validArmResult],
};

const validBenchmarkRun = {
  runId: 'run-001',
  timestamp: '2025-03-14T12:00:00Z',
  model: 'claude-opus-4-20250514',
  commit: 'abc123',
  language: 'python',
  arms: [validArmConfig],
  problems: [validProblemResult],
};

describe('BenchmarkRunSchema', () => {
  it('ValidRun_ParsesSuccessfully', () => {
    const result = BenchmarkRunSchema.safeParse(validBenchmarkRun);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.runId).toBe('run-001');
      expect(result.data.problems).toHaveLength(1);
      expect(result.data.arms).toHaveLength(1);
    }
  });
});

describe('ArmResultSchema', () => {
  it('AllVerdicts_AcceptsValidVerdicts', () => {
    const verdicts = ['pass', 'fail', 'partial', 'tle', 'rte', 'ce', 'no_solution'] as const;
    for (const verdict of verdicts) {
      const result = ArmResultSchema.safeParse({
        ...validArmResult,
        verdict,
      });
      expect(result.success, `Expected verdict "${verdict}" to be accepted`).toBe(true);
    }
  });
});

describe('SampleResultSchema', () => {
  it('MissingExpected_Rejects', () => {
    const result = SampleResultSchema.safeParse({
      sampleId: 1,
      verdict: 'pass',
      // expectedOutput missing
    });
    expect(result.success).toBe(false);
  });
});

describe('ProblemResultSchema', () => {
  it('EmptyArms_Rejects', () => {
    const result = ProblemResultSchema.safeParse({
      problemId: 'A',
      title: 'Two Sum',
      arms: [],
    });
    expect(result.success).toBe(false);
  });
});

describe('ArmConfigSchema', () => {
  it('InvalidArmId_Rejects', () => {
    const result = ArmConfigSchema.safeParse({
      ...validArmConfig,
      id: 'invalid-arm',
    });
    expect(result.success).toBe(false);
  });
});
