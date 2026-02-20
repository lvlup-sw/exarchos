import { describe, it, expect } from 'vitest';
import { fc } from '@fast-check/vitest';
import { TracePatternGrader } from './trace-pattern.js';

describe('TracePatternGrader', () => {
  const grader = new TracePatternGrader();

  it('Name_ReturnsTracePattern', () => {
    expect(grader.name).toBe('trace-pattern');
    expect(grader.type).toBe('trace-pattern');
  });

  // ─── Exact sequence ─────────────────────────────────────────────────

  it('Grade_ExactSequence_ReturnsScoreOne', async () => {
    const result = await grader.grade(
      {},
      {
        trace: [
          { type: 'task.started' },
          { type: 'task.completed' },
          { type: 'workflow.done' },
        ],
      },
      {
        patterns: [
          { type: 'task.started' },
          { type: 'task.completed' },
          { type: 'workflow.done' },
        ],
      }
    );
    expect(result.score).toBe(1.0);
    expect(result.passed).toBe(true);
  });

  // ─── Wildcards ──────────────────────────────────────────────────────

  it('Grade_WildcardStar_MatchesAnything', async () => {
    const result = await grader.grade(
      {},
      {
        trace: [
          { type: 'anything.here' },
        ],
      },
      {
        patterns: [{ type: '*' }],
      }
    );
    expect(result.score).toBe(1.0);
  });

  it('Grade_WildcardPrefix_MatchesPrefix', async () => {
    const result = await grader.grade(
      {},
      {
        trace: [
          { type: 'task.completed' },
          { type: 'task.started' },
        ],
      },
      {
        patterns: [{ type: 'task.*' }],
      }
    );
    expect(result.score).toBe(1.0);
  });

  it('Grade_WildcardPrefix_DoesNotMatchWrongPrefix', async () => {
    const result = await grader.grade(
      {},
      {
        trace: [{ type: 'workflow.started' }],
      },
      {
        patterns: [{ type: 'task.*' }],
      }
    );
    expect(result.score).toBe(0.0);
  });

  // ─── Count constraints ─────────────────────────────────────────────

  it('Grade_CountConstraint_MeetsMinimum_Passes', async () => {
    const result = await grader.grade(
      {},
      {
        trace: [
          { type: 'task.completed' },
          { type: 'task.completed' },
          { type: 'task.completed' },
        ],
      },
      {
        patterns: [{ type: 'task.completed', min: 3 }],
      }
    );
    expect(result.score).toBe(1.0);
  });

  it('Grade_CountConstraint_BelowMinimum_Fails', async () => {
    const result = await grader.grade(
      {},
      {
        trace: [
          { type: 'task.completed' },
          { type: 'task.completed' },
        ],
      },
      {
        patterns: [{ type: 'task.completed', min: 3 }],
      }
    );
    expect(result.score).toBe(0.0);
  });

  // ─── Missing pattern ───────────────────────────────────────────────

  it('Grade_MissingPattern_ProportionalScore', async () => {
    const result = await grader.grade(
      {},
      {
        trace: [
          { type: 'task.started' },
          { type: 'task.completed' },
        ],
      },
      {
        patterns: [
          { type: 'task.started' },
          { type: 'task.completed' },
          { type: 'workflow.done' },
        ],
      }
    );
    expect(result.score).toBeCloseTo(2 / 3);
  });

  // ─── Empty trace ───────────────────────────────────────────────────

  it('Grade_EmptyTrace_ReturnsScoreZero', async () => {
    const result = await grader.grade(
      {},
      { trace: [] },
      { patterns: [{ type: 'task.started' }] }
    );
    expect(result.score).toBe(0.0);
  });

  // ─── Empty patterns ────────────────────────────────────────────────

  it('Grade_EmptyPatterns_ReturnsScoreOne', async () => {
    const result = await grader.grade(
      {},
      { trace: [{ type: 'task.started' }] },
      { patterns: [] }
    );
    expect(result.score).toBe(1.0);
    expect(result.passed).toBe(true);
  });

  // ─── Ordered sequence correct ──────────────────────────────────────

  it('Grade_OrderedSequenceCorrect_ReturnsScoreOne', async () => {
    const result = await grader.grade(
      {},
      {
        trace: [
          { type: 'a' },
          { type: 'extra' },
          { type: 'b' },
          { type: 'c' },
        ],
      },
      {
        patterns: [{ type: 'a' }, { type: 'b' }, { type: 'c' }],
      },
      { ordered: true }
    );
    expect(result.score).toBe(1.0);
  });

  // ─── Ordered sequence incorrect ────────────────────────────────────

  it('Grade_OrderedSequenceIncorrect_ReducesScore', async () => {
    const result = await grader.grade(
      {},
      {
        trace: [
          { type: 'c' },
          { type: 'a' },
          { type: 'b' },
        ],
      },
      {
        patterns: [{ type: 'a' }, { type: 'b' }, { type: 'c' }],
      },
      { ordered: true }
    );
    // Longest ordered subsequence is [a, b] = 2/3
    expect(result.score).toBeCloseTo(2 / 3);
  });

  // ─── Partial match proportional ────────────────────────────────────

  it('Grade_PartialMatch_ProportionalScore', async () => {
    const result = await grader.grade(
      {},
      {
        trace: [
          { type: 'task.started' },
        ],
      },
      {
        patterns: [
          { type: 'task.started' },
          { type: 'task.completed' },
        ],
      }
    );
    expect(result.score).toBe(0.5);
  });

  // ─── No trace in output ────────────────────────────────────────────

  it('Grade_NoTraceInOutput_ReturnsScoreZero', async () => {
    const result = await grader.grade(
      {},
      {},
      { patterns: [{ type: 'task.started' }] }
    );
    expect(result.score).toBe(0.0);
  });

  // ─── Property tests ────────────────────────────────────────────────

  describe('Property Tests', () => {
    const arbEventType = fc.stringMatching(/^[a-z]+(\.[a-z]+)?$/);
    const arbTraceEvent = arbEventType.map((type) => ({ type }));
    const arbTrace = fc.array(arbTraceEvent, { minLength: 0, maxLength: 15 });
    const arbPattern = arbEventType.map((type) => ({ type }));
    const arbPatterns = fc.array(arbPattern, { minLength: 0, maxLength: 10 });

    it('Score_AlwaysInZeroOneRange', () => {
      fc.assert(
        fc.asyncProperty(arbTrace, arbPatterns, async (trace, patterns) => {
          const result = await grader.grade(
            {},
            { trace },
            { patterns }
          );
          expect(result.score).toBeGreaterThanOrEqual(0);
          expect(result.score).toBeLessThanOrEqual(1);
        })
      );
    });

    it('WildcardSubsumption_StarMatchesAll', () => {
      fc.assert(
        fc.asyncProperty(arbTrace, async (trace) => {
          if (trace.length === 0) return; // skip empty trace
          const result = await grader.grade(
            {},
            { trace },
            { patterns: [{ type: '*' }] }
          );
          expect(result.score).toBe(1.0);
        })
      );
    });
  });
});
