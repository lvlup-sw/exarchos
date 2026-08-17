import { describe, it, expect } from 'vitest';
import { generateReport } from './reporter.js';
import type { BenchmarkRun } from './types.js';

function makeArm(arm: 'exarchos' | 'vanilla-plan' | 'hn-manual', verdict: 'pass' | 'fail', tokens: number) {
  return {
    arm,
    verdict,
    sampleResults: [
      { sampleId: 1, verdict: verdict === 'pass' ? 'pass' as const : 'fail' as const, expectedOutput: '42\n', actualOutput: verdict === 'pass' ? '42\n' : '0\n' },
    ],
    metrics: {
      totalTokens: tokens,
      inputTokens: Math.floor(tokens * 0.8),
      outputTokens: Math.floor(tokens * 0.2),
      wallClockSeconds: 30,
      iterationCount: 3,
      linesOfCode: 50,
    },
    solution: 'print(42)',
    notes: 'Solved with brute force',
  };
}

const fixture: BenchmarkRun = {
  runId: 'test-run-001',
  timestamp: '2025-03-14T12:00:00Z',
  model: 'claude-opus-4-20250514',
  commit: 'abc123',
  language: 'python',
  arms: [
    { id: 'exarchos', name: 'Exarchos', description: 'With governance', promptTemplate: '{{statement}}', mcpEnabled: true },
    { id: 'vanilla-plan', name: 'Vanilla Plan', description: 'Plan mode', promptTemplate: '{{statement}}', mcpEnabled: false },
    { id: 'hn-manual', name: 'HN Manual', description: 'Human-guided', promptTemplate: '{{statement}}', mcpEnabled: false },
  ],
  problems: [
    { problemId: 'A', title: 'Two Sum', arms: [makeArm('exarchos', 'pass', 1000), makeArm('vanilla-plan', 'fail', 2000), makeArm('hn-manual', 'pass', 500)] },
    { problemId: 'B', title: 'Binary Search', arms: [makeArm('exarchos', 'pass', 1500), makeArm('vanilla-plan', 'pass', 1800), makeArm('hn-manual', 'fail', 600)] },
    { problemId: 'C', title: 'Graph Coloring', arms: [makeArm('exarchos', 'fail', 3000), makeArm('vanilla-plan', 'fail', 2500), makeArm('hn-manual', 'pass', 400)] },
  ],
};

describe('generateReport', () => {
  it('FixtureResults_ProducesSummaryTable', () => {
    const report = generateReport(fixture);
    // Should contain markdown table with | delimiters
    expect(report).toContain('|');
    // Should have header row with problem and arms
    expect(report).toContain('Problem');
    expect(report).toContain('exarchos');
    expect(report).toContain('vanilla-plan');
    expect(report).toContain('hn-manual');
    // Table separator row
    expect(report).toMatch(/\|[-:| ]+\|/);
  });

  it('IncludesMethodologySection', () => {
    const report = generateReport(fixture);
    expect(report).toContain('## Methodology');
  });

  it('PerProblemSections_ContainAllArms', () => {
    const report = generateReport(fixture);
    // Each problem should have its own section
    expect(report).toContain('Two Sum');
    expect(report).toContain('Binary Search');
    expect(report).toContain('Graph Coloring');
    // Each problem section should mention all arms
    for (const problem of fixture.problems) {
      expect(report).toContain(`### ${problem.problemId}: ${problem.title}`);
    }
  });

  it('AggregateMetrics_CalculatesCorrectly', () => {
    const report = generateReport(fixture);
    // Exarchos: 2 pass out of 3
    expect(report).toContain('2/3');
    // Vanilla Plan: 1 pass out of 3
    expect(report).toContain('1/3');
    // HN Manual: 2 pass out of 3
    // Mean tokens for exarchos: (1000 + 1500 + 3000) / 3 = 1833
    expect(report).toMatch(/1833/);
  });
});
