import { describe, it, expect } from 'vitest';
import { fc } from '@fast-check/vitest';
import { ToolCallGrader } from './tool-call.js';

describe('ToolCallGrader', () => {
  const grader = new ToolCallGrader();

  it('Name_ReturnsToolCall', () => {
    expect(grader.name).toBe('tool-call');
    expect(grader.type).toBe('tool-call');
  });

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

  /**
   * One required call matches and one forbidden call is present. The penalty is 1 of 2 checks, so the score
   * is 1.0 - 0.5 = 0.5. The default threshold is 1.0, so the case fails.
   */
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
    expect(result.score).toBe(0.5);
    expect(result.passed).toBe(false);
  });

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

  /** Ordered grading counts the longest common subsequence. Here it holds 2 of 3 calls, for example `[b.second, c.third]`. */
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
    expect(result.score).toBeCloseTo(2 / 3);
  });

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

  /** Two `a.do` calls in the output match the one required `a.do`. `b.do` is missing, so the score is 0.5. */
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
    expect(result.score).toBe(0.5);
  });

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

  it('Grade_NoToolCallsInOutput_ReturnsScoreZero', async () => {
    const result = await grader.grade(
      {},
      {},
      { tool_calls: [{ tool: 'a', action: 'do' }] }
    );
    expect(result.score).toBe(0.0);
  });

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

    /**
     * The score is not monotonic in every case, so this test asserts only that the extended score stays in
     * the range 0 to 1.
     */
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
            expect(extendedResult.score).toBeGreaterThanOrEqual(0);
            expect(extendedResult.score).toBeLessThanOrEqual(1);
          }
        )
      );
    });
  });
});
