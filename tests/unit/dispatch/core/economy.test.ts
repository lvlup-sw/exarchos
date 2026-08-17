import { describe, it, expect } from 'vitest';
import { fc } from '@fast-check/vitest';
import { estimateOutputTokens, narrowAffordance } from '../../../../src/dispatch/core/economy.js';
import { NextAction } from '../../../../src/next-action.js';

// ─── DR-1: relocated + generalized output-cap kit ────────────────────────────
//
// These tests pin the two contracts the relocation must preserve/widen:
//   1. `estimateOutputTokens` stays byte-for-byte identical to the token
//      formula the telemetry middleware applies to every response.
//   2. `narrowAffordance`, widened from `'pipeline' | 'worktrees'` to any
//      action name, still emits a `next_actions[]` entry that validates
//      against the registered `NextAction` schema.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The REAL token formula, reproduced verbatim from `projections/telemetry/middleware.ts`
 * (lines 121–128): the middleware serializes the result, falls back to `'{}'`
 * on a `JSON.stringify` throw, measures UTF-8 bytes, and divides by 4 rounding
 * up. `estimateOutputTokens` is the extracted, shared form of exactly this —
 * so the presentation guard and the D3 telemetry gate agree on "over
 * threshold". This oracle is the source of truth the property test pins to.
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

  it('estimateOutputTokens_UnserializablePayload_FallsBackLikeMiddleware', () => {
    // The one path `fc.jsonValue()` cannot reach: a value whose stringify
    // throws (circular ref / BigInt). Both the middleware and the relocated
    // helper degrade to `'{}'` → Math.ceil(2 / 4) = 1. Pinning it keeps the
    // fail-safe branch characterized.
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(estimateOutputTokens(circular)).toBe(telemetryMiddlewareFormula(circular));
    expect(estimateOutputTokens(circular)).toBe(1);
    expect(estimateOutputTokens(10n)).toBe(telemetryMiddlewareFormula(10n));
  });
});

describe('narrowAffordance (DR-1 widened verb type)', () => {
  // The catch-all `NextAction` branch reserves this verb for a dedicated
  // required-payload branch (`retry_with_task`), so it is not a valid action
  // name for a base-shape affordance. Real action names never collide with it.
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

  it('narrowAffordance_RealActionNames_ValidateAndCarryNarrowSteering', () => {
    // Concrete anchors: the two original consumers plus action names outside
    // the former `'pipeline' | 'worktrees'` union, exercising the widening.
    for (const verb of ['pipeline', 'worktrees', 'event query', 'describe', 'assess_stack']) {
      const action = narrowAffordance(verb, 10, 55, 'exarchos pipeline --limit 20');
      const parsed = NextAction.safeParse(action);
      expect(parsed.success).toBe(true);
      expect(action.verb).toBe(verb);
      expect(action.reason).toContain('Showing 10 of 55');
      expect(action.hint).toBe('exarchos pipeline --limit 20');
    }
  });
});
