import { describe, it, expect } from 'vitest';
import { NextAction } from '../../src/next-action.js';

describe('NextAction schema', () => {
  it('NextAction_RequiredFields_Present', () => {
    const result = NextAction.safeParse({ verb: 'dispatch', reason: 'because' });
    expect(result.success).toBe(true);
  });

  it('NextAction_EmptyVerb_Rejects', () => {
    const result = NextAction.safeParse({ verb: '', reason: 'x' });
    expect(result.success).toBe(false);
  });

  // ─── Preview-4 / T10 — `retry_with_task` verb (design §4.4, #1440 Op 4) ────
  //
  // The next-actions vocabulary gains a new verb `retry_with_task` that the
  // dispatch boundary emits when a `taskSuitable: true` action is invoked
  // without `task: { ttl }` and exceeds the duration threshold. INV-5b
  // requires this verb to be a first-class entry in the discriminator schema
  // (not free-form prose), so the schema validates its required payload
  // shape: `ttl_suggestion_ms: number`.
  //
  // T10 lands the schema entry only; T11 will emit the verb from
  // `dispatch/core/dispatch.ts`, and T12 will add the integration coverage.

  it('NextActionsDiscriminator_RetryWithTaskVerb_Validates', () => {
    const result = NextAction.safeParse({
      verb: 'retry_with_task',
      reason: 'test reason',
      ttl_suggestion_ms: 60_000,
    });
    expect(result.success).toBe(true);
  });

  it('NextActionsDiscriminator_RetryWithTaskMissingTtl_Fails', () => {
    // `retry_with_task` is the only verb whose payload requires
    // `ttl_suggestion_ms`. The catch-all branch (any other verb string) does
    // not, so this assertion specifically pins the verb-keyed branch.
    const result = NextAction.safeParse({
      verb: 'retry_with_task',
      reason: 'x',
    });
    expect(result.success).toBe(false);
  });
});
