import { describe, it, expect } from 'vitest';
import { NextActionSchema } from './envelope.js';

describe('NextActionSchema', () => {
  it('NextActionSchema_AcceptsCanonicalNextAction_Succeeds', () => {
    // Canonical NextAction shape — mirrors the NextAction Zod object in
    // ../next-action.ts (verb required, reason required, validTargets optional,
    // hint optional, idempotencyKey optional and non-empty when present).
    const canonical = {
      verb: 'merge_orchestrate',
      reason: 'Phase guard cleared — proceed to merge.',
      validTargets: ['integration', 'main'],
      hint: 'Run after task.completed lands.',
      idempotencyKey: 'wf-42:merge:1',
    };
    const parsed = NextActionSchema.safeParse(canonical);
    expect(parsed.success).toBe(true);
  });

  it('NextActionSchema_AcceptsMinimalNextAction_Succeeds', () => {
    // verb + reason are the only required fields per next-action.ts.
    const minimal = { verb: 'describe', reason: 'No workflow context.' };
    const parsed = NextActionSchema.safeParse(minimal);
    expect(parsed.success).toBe(true);
  });

  it('NextActionSchema_RejectsMissingVerb_Fails', () => {
    const missingVerb = { reason: 'No verb supplied.' };
    const parsed = NextActionSchema.safeParse(missingVerb);
    expect(parsed.success).toBe(false);
  });

  it('NextActionSchema_RejectsEmptyVerb_Fails', () => {
    // next-action.ts declares verb as z.string().min(1).
    const emptyVerb = { verb: '', reason: 'Empty verb.' };
    const parsed = NextActionSchema.safeParse(emptyVerb);
    expect(parsed.success).toBe(false);
  });
});
