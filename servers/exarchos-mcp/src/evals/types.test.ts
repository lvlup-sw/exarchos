import { describe, it, expect } from 'vitest';
import { fc } from '@fast-check/vitest';
import {
  GradeResultSchema,
  AssertionConfigSchema,
  AssertionResultSchema,
  EvalCaseSchema,
  EvalResultSchema,
  EvalSuiteConfigSchema,
  RunSummarySchema,
} from './types.js';

// ─── GradeResultSchema ──────────────────────────────────────────────────

describe('GradeResultSchema', () => {
  it('Parse_ValidInput_Succeeds', () => {
    const result = GradeResultSchema.parse({
      passed: true,
      score: 0.85,
      reason: 'All checks passed',
    });
    expect(result.passed).toBe(true);
    expect(result.score).toBe(0.85);
    expect(result.reason).toBe('All checks passed');
  });

  it('Parse_WithOptionalDetails_Succeeds', () => {
    const result = GradeResultSchema.parse({
      passed: false,
      score: 0.0,
      reason: 'Failed',
      details: { field: 'value' },
    });
    expect(result.details).toEqual({ field: 'value' });
  });

  it('Parse_ScoreBelowZero_Rejects', () => {
    expect(() =>
      GradeResultSchema.parse({ passed: true, score: -0.1, reason: 'test' })
    ).toThrow();
  });

  it('Parse_ScoreAboveOne_Rejects', () => {
    expect(() =>
      GradeResultSchema.parse({ passed: true, score: 1.1, reason: 'test' })
    ).toThrow();
  });

  it('Parse_MissingRequired_Rejects', () => {
    expect(() => GradeResultSchema.parse({ passed: true })).toThrow();
    expect(() => GradeResultSchema.parse({ score: 0.5 })).toThrow();
    expect(() => GradeResultSchema.parse({ reason: 'test' })).toThrow();
  });
});

// ─── AssertionConfigSchema ──────────────────────────────────────────────

describe('AssertionConfigSchema', () => {
  it('Parse_ValidInput_Succeeds', () => {
    const result = AssertionConfigSchema.parse({
      type: 'exact-match',
      name: 'check-output',
    });
    expect(result.type).toBe('exact-match');
    expect(result.name).toBe('check-output');
    expect(result.threshold).toBe(1.0); // default
  });

  it('Parse_AllTypes_Succeeds', () => {
    for (const type of ['exact-match', 'schema', 'tool-call', 'trace-pattern', 'llm-rubric', 'llm-similarity']) {
      expect(() =>
        AssertionConfigSchema.parse({ type, name: 'test' })
      ).not.toThrow();
    }
  });

  it('AssertionConfigSchema_LlmRubricType_ParsesValid', () => {
    const result = AssertionConfigSchema.parse({
      type: 'llm-rubric',
      name: 'rubric-check',
      threshold: 0.7,
      config: { rubric: 'Is the output complete?' },
    });
    expect(result.type).toBe('llm-rubric');
    expect(result.threshold).toBe(0.7);
  });

  it('AssertionConfigSchema_LlmSimilarityType_ParsesValid', () => {
    const result = AssertionConfigSchema.parse({
      type: 'llm-similarity',
      name: 'similarity-check',
      threshold: 0.8,
      config: { expected: 'reference text' },
    });
    expect(result.type).toBe('llm-similarity');
    expect(result.threshold).toBe(0.8);
  });

  it('Parse_UnknownType_Rejects', () => {
    expect(() =>
      AssertionConfigSchema.parse({ type: 'unknown', name: 'test' })
    ).toThrow();
  });

  it('Parse_CustomThreshold_Succeeds', () => {
    const result = AssertionConfigSchema.parse({
      type: 'schema',
      name: 'test',
      threshold: 0.8,
    });
    expect(result.threshold).toBe(0.8);
  });

  it('Parse_ThresholdOutOfRange_Rejects', () => {
    expect(() =>
      AssertionConfigSchema.parse({ type: 'schema', name: 'test', threshold: -0.1 })
    ).toThrow();
    expect(() =>
      AssertionConfigSchema.parse({ type: 'schema', name: 'test', threshold: 1.1 })
    ).toThrow();
  });

  it('Parse_WithOptionalConfig_Succeeds', () => {
    const result = AssertionConfigSchema.parse({
      type: 'exact-match',
      name: 'test',
      config: { fields: ['a', 'b'] },
    });
    expect(result.config).toEqual({ fields: ['a', 'b'] });
  });
});

// ─── AssertionResultSchema ──────────────────────────────────────────────

describe('AssertionResultSchema', () => {
  it('Parse_ValidInput_Succeeds', () => {
    const result = AssertionResultSchema.parse({
      name: 'check-1',
      type: 'exact-match',
      passed: true,
      score: 1.0,
      reason: 'Matched',
      threshold: 0.9,
    });
    expect(result.name).toBe('check-1');
    expect(result.passed).toBe(true);
  });

  it('Parse_ScoreOutOfRange_Rejects', () => {
    expect(() =>
      AssertionResultSchema.parse({
        name: 'x',
        type: 'schema',
        passed: true,
        score: 1.5,
        reason: 'test',
        threshold: 1.0,
      })
    ).toThrow();
  });

  it('Parse_MissingFields_Rejects', () => {
    expect(() =>
      AssertionResultSchema.parse({ name: 'x', type: 'schema' })
    ).toThrow();
  });

  it('Parse_SkippedDefault_IsFalse', () => {
    const result = AssertionResultSchema.parse({
      name: 'check-1',
      type: 'exact-match',
      passed: true,
      score: 1.0,
      reason: 'Matched',
      threshold: 0.9,
    });
    expect(result.skipped).toBe(false);
  });

  it('Parse_SkippedTrue_Succeeds', () => {
    const result = AssertionResultSchema.parse({
      name: 'check-1',
      type: 'llm-rubric',
      passed: true,
      score: 0,
      reason: 'Skipped',
      threshold: 0.7,
      skipped: true,
    });
    expect(result.skipped).toBe(true);
  });
});

// ─── EvalCaseSchema ─────────────────────────────────────────────────────

describe('EvalCaseSchema', () => {
  it('Parse_ValidInput_Succeeds', () => {
    const result = EvalCaseSchema.parse({
      id: 'case-1',
      type: 'single',
      description: 'Test case',
      input: { prompt: 'hello' },
      expected: { output: 'world' },
    });
    expect(result.id).toBe('case-1');
    expect(result.tags).toEqual([]); // default
  });

  it('Parse_EmptyId_Rejects', () => {
    expect(() =>
      EvalCaseSchema.parse({
        id: '',
        type: 'single',
        description: 'test',
        input: {},
        expected: {},
      })
    ).toThrow();
  });

  it('Parse_InvalidType_Rejects', () => {
    expect(() =>
      EvalCaseSchema.parse({
        id: 'c1',
        type: 'multi',
        description: 'test',
        input: {},
        expected: {},
      })
    ).toThrow();
  });

  it('Parse_WithTags_Succeeds', () => {
    const result = EvalCaseSchema.parse({
      id: 'c1',
      type: 'trace',
      description: 'test',
      input: {},
      expected: {},
      tags: ['smoke', 'regression'],
    });
    expect(result.tags).toEqual(['smoke', 'regression']);
  });
});

// ─── EvalResultSchema ───────────────────────────────────────────────────

describe('EvalResultSchema', () => {
  it('Parse_ValidInput_Succeeds', () => {
    const result = EvalResultSchema.parse({
      caseId: 'case-1',
      suiteId: 'suite-1',
      passed: true,
      score: 0.95,
      assertions: [],
      duration: 100,
    });
    expect(result.caseId).toBe('case-1');
    expect(result.duration).toBe(100);
  });

  it('Parse_NegativeDuration_Rejects', () => {
    expect(() =>
      EvalResultSchema.parse({
        caseId: 'c1',
        suiteId: 's1',
        passed: true,
        score: 1.0,
        assertions: [],
        duration: -1,
      })
    ).toThrow();
  });

  it('Parse_FractionalDuration_Rejects', () => {
    expect(() =>
      EvalResultSchema.parse({
        caseId: 'c1',
        suiteId: 's1',
        passed: true,
        score: 1.0,
        assertions: [],
        duration: 1.5,
      })
    ).toThrow();
  });

  it('Parse_WithAssertions_Succeeds', () => {
    const result = EvalResultSchema.parse({
      caseId: 'c1',
      suiteId: 's1',
      passed: false,
      score: 0.5,
      assertions: [
        {
          name: 'a1',
          type: 'exact-match',
          passed: true,
          score: 1.0,
          reason: 'ok',
          threshold: 1.0,
        },
        {
          name: 'a2',
          type: 'schema',
          passed: false,
          score: 0.0,
          reason: 'fail',
          threshold: 0.8,
        },
      ],
      duration: 200,
    });
    expect(result.assertions).toHaveLength(2);
  });
});

// ─── EvalSuiteConfigSchema ──────────────────────────────────────────────

describe('EvalSuiteConfigSchema', () => {
  it('Parse_ValidInput_Succeeds', () => {
    const result = EvalSuiteConfigSchema.parse({
      description: 'Test suite',
      metadata: { skill: 'planning', phaseAffinity: 'plan', version: '1.0.0' },
      assertions: [{ type: 'exact-match', name: 'check-1' }],
      datasets: {
        main: { path: './data.json', description: 'Main dataset' },
      },
    });
    expect(result.description).toBe('Test suite');
    expect(result.metadata.skill).toBe('planning');
  });

  it('Parse_MissingMetadataField_Rejects', () => {
    expect(() =>
      EvalSuiteConfigSchema.parse({
        description: 'Test',
        metadata: { skill: 'x' },
        assertions: [],
        datasets: {},
      })
    ).toThrow();
  });
});

// ─── RunSummarySchema ───────────────────────────────────────────────────

describe('RunSummarySchema', () => {
  it('Parse_ValidInput_Succeeds', () => {
    const result = RunSummarySchema.parse({
      runId: 'run-123',
      suiteId: 'suite-1',
      total: 10,
      passed: 8,
      failed: 2,
      avgScore: 0.85,
      duration: 5000,
      results: [],
    });
    expect(result.total).toBe(10);
    expect(result.avgScore).toBe(0.85);
    expect(result.skipped).toBe(0);
  });

  it('Parse_WithSkipped_Succeeds', () => {
    const result = RunSummarySchema.parse({
      runId: 'run-123',
      suiteId: 'suite-1',
      total: 10,
      passed: 8,
      failed: 0,
      skipped: 2,
      avgScore: 0.85,
      duration: 5000,
      results: [],
    });
    expect(result.skipped).toBe(2);
  });

  it('Parse_NegativeCounts_Rejects', () => {
    expect(() =>
      RunSummarySchema.parse({
        runId: 'r1',
        suiteId: 's1',
        total: -1,
        passed: 0,
        failed: 0,
        avgScore: 0.0,
        duration: 0,
        results: [],
      })
    ).toThrow();
  });

  it('Parse_FractionalCounts_Rejects', () => {
    expect(() =>
      RunSummarySchema.parse({
        runId: 'r1',
        suiteId: 's1',
        total: 1.5,
        passed: 0,
        failed: 0,
        avgScore: 0.0,
        duration: 0,
        results: [],
      })
    ).toThrow();
  });

  it('Parse_AvgScoreOutOfRange_Rejects', () => {
    expect(() =>
      RunSummarySchema.parse({
        runId: 'r1',
        suiteId: 's1',
        total: 0,
        passed: 0,
        failed: 0,
        avgScore: 1.5,
        duration: 0,
        results: [],
      })
    ).toThrow();
  });
});

// ─── Property Tests ─────────────────────────────────────────────────────

describe('Schema Property Tests', () => {
  // Arbitrary generators for valid schema inputs
  const arbScore = fc.double({ min: 0, max: 1, noNaN: true });

  const arbGradeResult = fc.record({
    passed: fc.boolean(),
    score: arbScore,
    reason: fc.string({ minLength: 1 }),
  });

  const arbAssertionType = fc.constantFrom(
    'exact-match' as const,
    'schema' as const,
    'tool-call' as const,
    'trace-pattern' as const,
    'llm-rubric' as const,
    'llm-similarity' as const
  );

  const arbAssertionConfig = fc.record({
    type: arbAssertionType,
    name: fc.string({ minLength: 1 }),
    threshold: arbScore,
  });

  const arbEvalCaseType = fc.constantFrom('single' as const, 'trace' as const);

  const arbEvalCase = fc.record({
    id: fc.string({ minLength: 1 }),
    type: arbEvalCaseType,
    description: fc.string(),
    input: fc.dictionary(fc.string({ minLength: 1 }), fc.jsonValue()),
    expected: fc.dictionary(fc.string({ minLength: 1 }), fc.jsonValue()),
    tags: fc.array(fc.string()),
  });

  describe('GradeResult_Roundtrip_ParsedOutputReparses', () => {
    it('any valid GradeResult re-parses without error', () => {
      fc.assert(
        fc.property(arbGradeResult, (input) => {
          const parsed = GradeResultSchema.parse(input);
          expect(() => GradeResultSchema.parse(parsed)).not.toThrow();
        })
      );
    });
  });

  describe('AssertionConfig_Roundtrip_ParsedOutputReparses', () => {
    it('any valid AssertionConfig re-parses without error', () => {
      fc.assert(
        fc.property(arbAssertionConfig, (input) => {
          const parsed = AssertionConfigSchema.parse(input);
          expect(() => AssertionConfigSchema.parse(parsed)).not.toThrow();
        })
      );
    });
  });

  describe('EvalCase_Roundtrip_ParsedOutputReparses', () => {
    it('any valid EvalCase re-parses without error', () => {
      fc.assert(
        fc.property(arbEvalCase, (input) => {
          const parsed = EvalCaseSchema.parse(input);
          expect(() => EvalCaseSchema.parse(parsed)).not.toThrow();
        })
      );
    });
  });

  describe('GradeResult_ScoreRange_AlwaysInBounds', () => {
    it('parsed score is always between 0 and 1', () => {
      fc.assert(
        fc.property(arbGradeResult, (input) => {
          const parsed = GradeResultSchema.parse(input);
          expect(parsed.score).toBeGreaterThanOrEqual(0);
          expect(parsed.score).toBeLessThanOrEqual(1);
        })
      );
    });
  });
});
