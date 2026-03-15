import { describe, it, expect } from 'vitest';
import { toEvalResult, toJsonl } from './eval-adapter.js';
import type { ArmResult, BenchmarkRun } from './runner/types.js';

const passingArm: ArmResult = {
  arm: 'exarchos',
  verdict: 'pass',
  sampleResults: [
    { sampleId: 1, verdict: 'pass', expectedOutput: '42\n', actualOutput: '42\n' },
    { sampleId: 2, verdict: 'pass', expectedOutput: '7\n', actualOutput: '7\n' },
  ],
  metrics: {
    totalTokens: 1000,
    inputTokens: 800,
    outputTokens: 200,
    wallClockSeconds: 25.5,
    iterationCount: 3,
    linesOfCode: 42,
  },
  solution: 'print(42)',
};

const failingArm: ArmResult = {
  arm: 'vanilla-plan',
  verdict: 'fail',
  sampleResults: [
    { sampleId: 1, verdict: 'pass', expectedOutput: '42\n', actualOutput: '42\n' },
    { sampleId: 2, verdict: 'fail', expectedOutput: '7\n', actualOutput: '0\n' },
  ],
  metrics: {
    totalTokens: 2000,
    inputTokens: 1600,
    outputTokens: 400,
    wallClockSeconds: 45,
    iterationCount: 5,
    linesOfCode: 80,
  },
};

const fixture: BenchmarkRun = {
  runId: 'test-run-001',
  timestamp: '2025-03-14T12:00:00Z',
  model: 'claude-opus-4-20250514',
  commit: 'abc123',
  language: 'python',
  arms: [
    { id: 'exarchos', name: 'Exarchos', description: 'With governance', promptTemplate: '{{statement}}', mcpEnabled: true },
    { id: 'vanilla-plan', name: 'Vanilla Plan', description: 'Plan mode', promptTemplate: '{{statement}}', mcpEnabled: false },
  ],
  problems: [
    { problemId: 'A', title: 'Two Sum', arms: [passingArm, failingArm] },
  ],
};

describe('toEvalResult', () => {
  it('PassingArm_MapsToPassedEvalResult', () => {
    const result = toEvalResult(passingArm, 'A');
    expect(result.id).toBe('icpc-2025-A-exarchos');
    expect(result.passed).toBe(true);
    expect(result.score).toBe(1.0);
    expect(result.duration).toBe(25500);
  });

  it('FailingArm_MapsToFailedEvalResult', () => {
    const result = toEvalResult(failingArm, 'B');
    expect(result.id).toBe('icpc-2025-B-vanilla-plan');
    expect(result.passed).toBe(false);
    expect(result.score).toBe(0.5); // 1 of 2 samples passed
    expect(result.duration).toBe(45000);
  });

  it('PreservesMetrics_InMetadataField', () => {
    const result = toEvalResult(passingArm, 'A');
    expect(result.metadata).toEqual({
      arm: 'exarchos',
      verdict: 'pass',
      tokens: 1000,
      linesOfCode: 42,
    });
  });
});

describe('toJsonl', () => {
  it('FullRun_ProducesValidJsonl', () => {
    const jsonl = toJsonl(fixture);
    const lines = jsonl.trim().split('\n');
    // Should have one line per arm-problem combination
    expect(lines).toHaveLength(2);

    for (const line of lines) {
      const parsed = JSON.parse(line);
      expect(parsed).toHaveProperty('id');
      expect(parsed).toHaveProperty('passed');
      expect(parsed).toHaveProperty('score');
      expect(parsed).toHaveProperty('duration');
      expect(parsed).toHaveProperty('metadata');
    }

    // First line should be the passing arm
    const first = JSON.parse(lines[0]);
    expect(first.id).toBe('icpc-2025-A-exarchos');
    expect(first.passed).toBe(true);

    // Second line should be the failing arm
    const second = JSON.parse(lines[1]);
    expect(second.id).toBe('icpc-2025-A-vanilla-plan');
    expect(second.passed).toBe(false);
  });
});
