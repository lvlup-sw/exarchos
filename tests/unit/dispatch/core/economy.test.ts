/**
 * Tests for the output-cap kit. `estimateOutputTokens` must equal the token formula of the
 * telemetry middleware. `narrowAffordance` must return a valid `NextAction` for any action name.
 */
import { describe, it, expect } from 'vitest';
import { fc } from '@fast-check/vitest';
import { estimateOutputTokens, narrowAffordance } from '../../../../src/dispatch/core/economy.js';
import { NextAction } from '../../../../src/next-action.js';

/**
 * The token formula of `projections/telemetry/middleware.ts`, copied here as the oracle. It
 * serializes the payload and uses `'{}'` when `JSON.stringify` throws. Then it divides the UTF-8
 * byte count by 4 and rounds up.
 */
function telemetryMiddlewareFormula(payload: unknown): number {
  let responseText: string;
  try {
    responseText = JSON.stringify(payload);
  } catch {
    responseText = '{}';
  }
  const responseBytes = Buffer.byteLength(responseText, 'utf-8');
  return Math.ceil(responseBytes / 4);
}

describe('estimateOutputTokens (DR-1 relocation)', () => {
  it('estimateOutputTokens_AnyPayload_MatchesTelemetryMiddlewareFormula', () => {
    fc.assert(
      fc.property(fc.jsonValue(), (payload) => {
        expect(estimateOutputTokens(payload)).toBe(telemetryMiddlewareFormula(payload));
      }),
      { numRuns: 500 },
    );
  });

  /**
   * `fc.jsonValue()` cannot make a value that `JSON.stringify` rejects. A circular object and a
   * BigInt take the `'{}'` fallback, which gives `Math.ceil(2 / 4)`, that is 1.
   */
  it('estimateOutputTokens_UnserializablePayload_FallsBackLikeMiddleware', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(estimateOutputTokens(circular)).toBe(telemetryMiddlewareFormula(circular));
    expect(estimateOutputTokens(circular)).toBe(1);
    expect(estimateOutputTokens(10n)).toBe(telemetryMiddlewareFormula(10n));
  });
});

/**
 * The generated verbs exclude `retry_with_task`. The `NextAction` schema gives that verb its own
 * branch with a required payload, so the base shape rejects it.
 */
describe('narrowAffordance (DR-1 widened verb type)', () => {
  const RESERVED_VERBS = ['retry_with_task'];

  it('narrowAffordance_AnyVerb_ValidatesAgainstNextActionSchema', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1 }).filter((v) => !RESERVED_VERBS.includes(v)),
        fc.nat(),
        fc.nat(),
        fc.string(),
        (verb, shown, total, cliHint) => {
          const action = narrowAffordance(verb, shown, total, cliHint);
          const parsed = NextAction.safeParse(action);
          expect(parsed.success).toBe(true);
          expect(action.verb).toBe(verb);
        },
      ),
      { numRuns: 300 },
    );
  });

  /**
   * The verbs include action names other than the view names `pipeline` and `worktrees`. The views
   * declare `limit` and `offset`, and with no window argument the reason names both.
   */
  it('narrowAffordance_RealActionNames_ValidateAndCarryNarrowSteering', () => {
    for (const verb of ['pipeline', 'worktrees', 'event query', 'describe', 'assess_stack']) {
      const action = narrowAffordance(verb, 10, 55, 'exarchos pipeline --limit 20');
      const parsed = NextAction.safeParse(action);
      expect(parsed.success).toBe(true);
      expect(action.verb).toBe(verb);
      expect(action.reason).toBe('Showing 10 of 55 — narrow with limit/offset (or a filter) to page through the rest.');
      expect(action.hint).toBe('exarchos pipeline --limit 20');
    }
    expect(narrowAffordance('list', 10, 55, undefined, 'offset').reason).toBe(
      'Showing 10 of 55 — narrow with offset (or a filter) to page through the rest.',
    );
  });
});
