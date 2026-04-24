import { describe, it, expect } from 'vitest';
import { NextAction } from './next-action.js';

describe('NextAction schema', () => {
  it('NextAction_RequiredFields_Present', () => {
    const result = NextAction.safeParse({ verb: 'dispatch', reason: 'because' });
    expect(result.success).toBe(true);
  });

  it('NextAction_EmptyVerb_Rejects', () => {
    const result = NextAction.safeParse({ verb: '', reason: 'x' });
    expect(result.success).toBe(false);
  });
});
