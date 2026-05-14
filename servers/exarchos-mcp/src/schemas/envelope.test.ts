import { describe, it, expect } from 'vitest';
import { NextActionSchema, ErrorEnvelopeSchema } from './envelope.js';
import { wrapError } from '../format.js';
import { ConcurrencyError } from '../event-store/concurrency-error.js';
import { StorageBusyError } from '../event-store/storage-busy-error.js';

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

describe('ErrorEnvelopeSchema', () => {
  it('ErrorEnvelopeSchema_AcceptsConcurrencyWrapError_Succeeds', () => {
    const err = new ConcurrencyError({
      streamId: 'workflow-42',
      reducerId: 'reducer-1',
      expectedVersion: 5,
      actualVersion: 6,
      operationId: 'op-123',
    });
    const envelope = wrapError(err);
    const parsed = ErrorEnvelopeSchema.safeParse(envelope);
    expect(parsed.success).toBe(true);
  });

  it('ErrorEnvelopeSchema_AcceptsStorageBusyWrapError_Succeeds', () => {
    const err = new StorageBusyError({
      streamId: 'workflow-42',
      attempts: 5,
      cause: new Error('SQLITE_BUSY'),
    });
    const envelope = wrapError(err);
    const parsed = ErrorEnvelopeSchema.safeParse(envelope);
    expect(parsed.success).toBe(true);
  });

  it('ErrorEnvelopeSchema_AcceptsGenericWrapError_Succeeds', () => {
    const envelope = wrapError(new Error('boom'));
    const parsed = ErrorEnvelopeSchema.safeParse(envelope);
    expect(parsed.success).toBe(true);
  });

  it('ErrorEnvelopeSchema_RejectsSuccessTrue_Fails', () => {
    // success literal(false) must be enforced.
    const notAnError = {
      success: true,
      error: { code: 'X', message: 'y' },
      _meta: {},
      _perf: { ms: 0, bytes: 0, tokens: 0 },
    };
    const parsed = ErrorEnvelopeSchema.safeParse(notAnError);
    expect(parsed.success).toBe(false);
  });
});
