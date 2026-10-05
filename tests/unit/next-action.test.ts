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

  /**
   * Dispatch emits `retry_with_task` when a `taskSuitable: true` action runs too long without
   * `task: { ttl }`. The verb has its own schema branch, which requires `ttl_suggestion_ms`.
   */
  it('NextActionsDiscriminator_RetryWithTaskVerb_Validates', () => {
    const result = NextAction.safeParse({
      verb: 'retry_with_task',
      reason: 'test reason',
      ttl_suggestion_ms: 60_000,
    });
    expect(result.success).toBe(true);
  });

  /**
   * Only the `retry_with_task` branch requires `ttl_suggestion_ms`. The catch-all branch must
   * reject this verb, or the payload parses there.
   */
  it('NextActionsDiscriminator_RetryWithTaskMissingTtl_Fails', () => {
    const result = NextAction.safeParse({
      verb: 'retry_with_task',
      reason: 'x',
    });
    expect(result.success).toBe(false);
  });
});
