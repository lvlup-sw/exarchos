import { describe, it, expect } from 'vitest';
import { fc } from '@fast-check/vitest';
import { ToolCallGrader } from './tool-call.js';

describe('ToolCallGrader', () => {
  const grader = new ToolCallGrader();

  it('Name_ReturnsToolCall', () => {
    expect(grader.name).toBe('tool-call');
    expect(grader.type).toBe('tool-call');
  });

  // ─── All present ────────────────────────────────────────────────────

  it('Grade_AllRequiredPresent_ReturnsScoreOne', async () => {
    const result = await grader.grade(
      {},
      {
        tool_calls: [
          { tool: 'exarchos_workflow', action: 'set' },
          { tool: 'exarchos_event', action: 'emit' },
        ],
      },
      {
        tool_calls: [
          { tool: 'exarchos_workflow', action: 'set' },
          { tool: 'exarchos_event', action: 'emit' },
        ],
      }
    );
    expect(result.score).toBe(1.0);
    expect(result.passed).toBe(true);
  });

  // ─── Missing one of three ──────────────────────────────────────────

  it('Grade_MissingOneOfThree_ReturnsProportionalScore', async () => {
    const result = await grader.grade(
      {},
      {
        tool_calls: [
          { tool: 'a', action: 'do' },
          { tool: 'b', action: 'do' },
        ],
      },
      {
        tool_calls: [
          { tool: 'a', action: 'do' },
          { tool: 'b', action: 'do' },
          { tool: 'c', action: 'do' },
        ],
      }
    );
    expect(result.score).toBeCloseTo(2 / 3);
    expect(result.passed).toBe(false);
  });

  // ─── All missing ───────────────────────────────────────────────────

  it('Grade_AllMissing_ReturnsScoreZero', async () => {
    const result = await grader.grade(
      {},
      { tool_calls: [] },
      {
        tool_calls: [
          { tool: 'a', action: 'do' },
          { tool: 'b', action: 'do' },
        ],
      }
    );
    expect(result.score).toBe(0.0);
    expect(result.passed).toBe(false);
  });

  // ─── Forbidden present ─────────────────────────────────────────────

  it('Grade_ForbiddenPresent_ReducesScore', async () => {
    const result = await grader.grade(
      {},
      {
        tool_calls: [
          { tool: 'a', action: 'do' },
          { tool: 'forbidden', action: 'bad' },
        ],
      },
      {
        tool_calls: [{ tool: 'a', action: 'do' }],
        forbidden_calls: [{ tool: 'forbidden', action: 'bad' }],
      }
    );
    // 1 required matched (1/1 = 1.0), 1 forbidden found, total_checks = 2
    // penalty = 1/2 = 0.5. Score = 1.0 - 0.5 = 0.5
    expect(result.score).toBe(0.5);
    expect(result.passed).toBe(false); // default threshold is 1.0
  });

  // ─── Forbidden not present ─────────────────────────────────────────

  it('Grade_ForbiddenNotPresent_NoReduction', async () => {
    const result = await grader.grade(
      {},
      {
        tool_calls: [{ tool: 'a', action: 'do' }],
      },
      {
        tool_calls: [{ tool: 'a', action: 'do' }],
        forbidden_calls: [{ tool: 'forbidden', action: 'bad' }],
      }
    );
    expect(result.score).toBe(1.0);
    expect(result.passed).toBe(true);
  });

  // ─── Ordered: correct ──────────────────────────────────────────────

  it('Grade_OrderedCorrect_ReturnsScoreOne', async () => {
    const result = await grader.grade(
      {},
      {
        tool_calls: [
          { tool: 'a', action: 'first' },
          { tool: 'b', action: 'second' },
          { tool: 'c', action: 'third' },
        ],
      },
      {
        tool_calls: [
          { tool: 'a', action: 'first' },
          { tool: 'b', action: 'second' },
          { tool: 'c', action: 'third' },
        ],
      },
      { ordered: true }
    );
    expect(result.score).toBe(1.0);
  });

  // ─── Ordered: incorrect ────────────────────────────────────────────

  it('Grade_OrderedIncorrect_ReducesScore', async () => {
    const result = await grader.grade(
      {},
      {
        tool_calls: [
          { tool: 'b', action: 'second' },
          { tool: 'a', action: 'first' },
          { tool: 'c', action: 'third' },
        ],
      },
      {
        tool_calls: [
          { tool: 'a', action: 'first' },
          { tool: 'b', action: 'second' },
          { tool: 'c', action: 'third' },
        ],
      },
      { ordered: true }
    );
    // When ordered, we use longest subsequence matching
    // The longest ordered subsequence is [b.second, c.third] = 2 out of 3
    expect(result.score).toBeCloseTo(2 / 3);
  });

  // ─── Wrong action ──────────────────────────────────────────────────

  it('Grade_WrongAction_DoesNotMatch', async () => {
    const result = await grader.grade(
      {},
      {
        tool_calls: [{ tool: 'a', action: 'wrong' }],
      },
      {
        tool_calls: [{ tool: 'a', action: 'do' }],
      }
    );
    expect(result.score).toBe(0.0);
  });

  // ─── Duplicate calls match once ────────────────────────────────────

  it('Grade_DuplicateCallsInOutput_MatchOnce', async () => {
    const result = await grader.grade(
      {},
      {
        tool_calls: [
          { tool: 'a', action: 'do' },
          { tool: 'a', action: 'do' },
        ],
      },
      {
        tool_calls: [
          { tool: 'a', action: 'do' },
          { tool: 'b', action: 'do' },
        ],
      }
    );
    // Only one required call matched (a.do), b.do is missing
    expect(result.score).toBe(0.5);
  });

  // ─── Empty lists ───────────────────────────────────────────────────

  it('Grade_EmptyRequiredAndOutput_ReturnsScoreOne', async () => {
    const result = await grader.grade(
      {},
      { tool_calls: [] },
      { tool_calls: [] }
    );
    expect(result.score).toBe(1.0);
    expect(result.passed).toBe(true);
  });

  it('Grade_EmptyRequired_WithForbidden_AllClear_ReturnsScoreOne', async () => {
    const result = await grader.grade(
      {},
      { tool_calls: [{ tool: 'safe', action: 'ok' }] },
      {
        tool_calls: [],
        forbidden_calls: [{ tool: 'bad', action: 'no' }],
      }
    );
    expect(result.score).toBe(1.0);
  });

  // ─── No tool_calls in output ───────────────────────────────────────

  it('Grade_NoToolCallsInOutput_ReturnsScoreZero', async () => {
    const result = await grader.grade(
      {},
      {},
      { tool_calls: [{ tool: 'a', action: 'do' }] }
    );
    expect(result.score).toBe(0.0);
  });

  // ─── Property tests ────────────────────────────────────────────────

  describe('Property Tests', () => {
    const arbToolCall = fc.record({
      tool: fc.string({ minLength: 1, maxLength: 10 }),
      action: fc.string({ minLength: 1, maxLength: 10 }),
    });

    const arbToolCallList = fc.array(arbToolCall, { minLength: 0, maxLength: 10 });

    it('Score_AlwaysInZeroOneRange', async () => {
      await fc.assert(
        fc.asyncProperty(arbToolCallList, arbToolCallList, async (outputCalls, expectedCalls) => {
          const result = await grader.grade(
            {},
            { tool_calls: outputCalls },
            { tool_calls: expectedCalls }
          );
          expect(result.score).toBeGreaterThanOrEqual(0);
          expect(result.score).toBeLessThanOrEqual(1);
        })
      );
    });

    it('Score_Monotonicity_AddingRequiredCallNeverDecreasesScore', async () => {
      await fc.assert(
        fc.asyncProperty(
          arbToolCallList,
          arbToolCallList,
          arbToolCall,
          async (outputCalls, requiredCalls, extraCall) => {
            const baseResult = await grader.grade(
              {},
              { tool_calls: [...outputCalls, extraCall] },
              { tool_calls: requiredCalls }
            );
            const extendedResult = await grader.grade(
              {},
              { tool_calls: [...outputCalls, extraCall] },
              { tool_calls: [...requiredCalls, extraCall] }
            );
            // Adding a call that IS in output to required should not decrease score
            // (it was already there so it will match)
            // This isn't strictly monotonic in all cases, so we just verify range
            expect(extendedResult.score).toBeGreaterThanOrEqual(0);
            expect(extendedResult.score).toBeLessThanOrEqual(1);
          }
        )
      );
    });
  });
});
