import { describe, it, expect } from 'vitest';
import { computeAttribution, isValidDimension } from './attribution.js';
import type { AttributionQuery } from './attribution.js';
import type { CodeQualityViewState } from '../views/code-quality-view.js';
import type { EvalResultsViewState } from '../views/eval-results-view.js';

// ─── Test Fixtures ──────────────────────────────────────────────────────────

function makeCodeQuality(overrides?: Partial<CodeQualityViewState>): CodeQualityViewState {
  return {
    skills: {
      delegation: {
        skill: 'delegation',
        totalExecutions: 20,
        gatePassRate: 0.9,
        selfCorrectionRate: 0.2,
        avgRemediationAttempts: 1.5,
        topFailureCategories: [],
      },
      synthesis: {
        skill: 'synthesis',
        totalExecutions: 10,
        gatePassRate: 0.8,
        selfCorrectionRate: 0.1,
        avgRemediationAttempts: 1.0,
        topFailureCategories: [],
      },
    },
    models: {
      'claude-opus-4': {
        model: 'claude-opus-4',
        totalExecutions: 15,
        gatePassRate: 0.93,
      },
      'claude-sonnet-4': {
        model: 'claude-sonnet-4',
        totalExecutions: 15,
        gatePassRate: 0.87,
      },
    },
    gates: {
      typecheck: {
        gate: 'typecheck',
        executionCount: 18,
        passRate: 0.89,
        avgDuration: 1200,
        failureReasons: [],
      },
      lint: {
        gate: 'lint',
        executionCount: 12,
        passRate: 0.92,
        avgDuration: 800,
        failureReasons: [],
      },
    },
    regressions: [],
    benchmarks: [],
    ...overrides,
  };
}

function makeEvalResults(overrides?: Partial<EvalResultsViewState>): EvalResultsViewState {
  return {
    skills: {
      delegation: {
        skill: 'delegation',
        latestScore: 0.85,
        trend: 'stable',
        lastRunId: 'run-1',
        lastRunTimestamp: '2026-01-01T00:00:00Z',
        totalRuns: 5,
        regressionCount: 0,
        capabilityPassRate: 0.9,
      },
    },
    runs: [],
    regressions: [],
    ...overrides,
  };
}

// ─── Unit Tests: computeAttribution ─────────────────────────────────────────

describe('computeAttribution', () => {
  it('ComputeAttribution_SkillDimension_ReturnsSkillEntries', () => {
    // Arrange
    const query: AttributionQuery = { dimension: 'skill' };
    const cq = makeCodeQuality();
    const er = makeEvalResults();

    // Act
    const result = computeAttribution(query, cq, er);

    // Assert
    expect(result.dimension).toBe('skill');
    expect(result.entries).toHaveLength(2);
    expect(result.totalExecutions).toBe(30); // 20 + 10
    // Sorted by contribution descending: delegation (20/30) > synthesis (10/30)
    expect(result.entries[0].name).toBe('delegation');
    expect(result.entries[0].contribution).toBeCloseTo(20 / 30);
    expect(result.entries[0].passRate).toBe(0.9);
    expect(result.entries[1].name).toBe('synthesis');
    expect(result.entries[1].contribution).toBeCloseTo(10 / 30);
  });

  it('ComputeAttribution_GateDimension_ReturnsGateEntries', () => {
    // Arrange
    const query: AttributionQuery = { dimension: 'gate' };
    const cq = makeCodeQuality();
    const er = makeEvalResults();

    // Act
    const result = computeAttribution(query, cq, er);

    // Assert
    expect(result.dimension).toBe('gate');
    expect(result.entries).toHaveLength(2);
    expect(result.totalExecutions).toBe(30); // 18 + 12
    expect(result.entries[0].name).toBe('typecheck');
    expect(result.entries[0].contribution).toBeCloseTo(18 / 30);
    expect(result.entries[1].name).toBe('lint');
  });

  it('ComputeAttribution_ModelDimension_ReturnsModelEntries', () => {
    // Arrange
    const query: AttributionQuery = { dimension: 'model' };
    const cq = makeCodeQuality();
    const er = makeEvalResults();

    // Act
    const result = computeAttribution(query, cq, er);

    // Assert
    expect(result.dimension).toBe('model');
    expect(result.entries).toHaveLength(2);
    expect(result.totalExecutions).toBe(30); // 15 + 15
    // Equal contribution since both have 15 executions
    expect(result.entries[0].contribution).toBeCloseTo(0.5);
    expect(result.entries[1].contribution).toBeCloseTo(0.5);
  });

  it('ComputeAttribution_InvalidDimension_ThrowsError', () => {
    // Arrange
    const query = { dimension: 'invalid' as 'skill' };
    const cq = makeCodeQuality();
    const er = makeEvalResults();

    // Act & Assert
    expect(() => computeAttribution(query, cq, er)).toThrow('Invalid attribution dimension');
  });

  it('ComputeAttribution_WithSkillFilter_FiltersResults', () => {
    // Arrange
    const query: AttributionQuery = { dimension: 'skill', skill: 'delegation' };
    const cq = makeCodeQuality();
    const er = makeEvalResults();

    // Act
    const result = computeAttribution(query, cq, er);

    // Assert
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].name).toBe('delegation');
    // Filtered: only delegation (20 executions), so contribution = 1.0
    expect(result.entries[0].contribution).toBe(1);
    expect(result.totalExecutions).toBe(20);
  });

  it('ComputeAttribution_EmptyViews_ReturnsEmptyEntries', () => {
    // Arrange
    const query: AttributionQuery = { dimension: 'skill' };
    const cq = makeCodeQuality({ skills: {} });
    const er = makeEvalResults({ skills: {} });

    // Act
    const result = computeAttribution(query, cq, er);

    // Assert
    expect(result.entries).toEqual([]);
    expect(result.totalExecutions).toBe(0);
  });
});

describe('isValidDimension', () => {
  it('isValidDimension_ValidValues_ReturnsTrue', () => {
    expect(isValidDimension('skill')).toBe(true);
    expect(isValidDimension('gate')).toBe(true);
    expect(isValidDimension('model')).toBe(true);
  });

  it('isValidDimension_InvalidValue_ReturnsFalse', () => {
    expect(isValidDimension('invalid')).toBe(false);
    expect(isValidDimension('')).toBe(false);
  });
});
