import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import {
  NextActionSchema,
  ErrorEnvelopeSchema,
  EnvelopeSchema,
  SuccessEnvelopeSchema,
  PerfMetricsSchema,
  EventHintsSchema,
  CacheHintsSchema,
} from './envelope.js';
import { wrap, wrapError } from '../format.js';
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

describe('EnvelopeSchema factory', () => {
  it('EnvelopeSchema_DiscriminatesOnSuccessField_AcceptsBothBranches', () => {
    const schema = EnvelopeSchema(z.object({ foo: z.string() }));

    // Success branch — wrap() produces the canonical SuccessEnvelope shape.
    const success = wrap({ foo: 'x' }, {}, { ms: 1 });
    expect(schema.safeParse(success).success).toBe(true);

    // Failure branch — wrapError on a typed primitive error.
    const err = new ConcurrencyError({
      streamId: 's1',
      reducerId: 'r1',
      expectedVersion: 1,
      actualVersion: 2,
    });
    const failure = wrapError(err);
    expect(schema.safeParse(failure).success).toBe(true);
  });

  it('EnvelopeSchema_RejectsDataMismatch_Fails', () => {
    const schema = EnvelopeSchema(z.object({ foo: z.string() }));
    const bad = {
      success: true,
      data: { foo: 42 }, // expected string
      next_actions: [],
      _meta: {},
      _perf: { ms: 0, bytes: 0, tokens: 0 },
    };
    expect(schema.safeParse(bad).success).toBe(false);
  });

  it('SuccessEnvelopeSchema_AcceptsOptionalDecorators_Succeeds', () => {
    // Verifies the optional decorator fields (_eventHints, _cacheHints,
    // warnings, _corrections) parse cleanly when present on a success env.
    const schema = SuccessEnvelopeSchema(z.object({ ok: z.boolean() }));
    const full = {
      success: true as const,
      data: { ok: true },
      next_actions: [{ verb: 'noop', reason: 'idle' }],
      _meta: { phase: 'design' },
      _perf: { ms: 1, bytes: 2, tokens: 3 },
      _eventHints: { missing: [], phase: 'design', checked: 0 },
      _cacheHints: { type: 'cache_boundary', position: 'after:v', kind: 'ephemeral', ttl: '1h' },
      warnings: ['be careful'],
      _corrections: { applied: [] },
    };
    expect(schema.safeParse(full).success).toBe(true);
  });

  it('PerfMetricsSchema_RoundTripsThroughZodType_Succeeds', () => {
    // Round-trip the format.ts PerfMetrics shape through the schema.
    const pm = { ms: 5, bytes: 100, tokens: 25 };
    expect(PerfMetricsSchema.safeParse(pm).success).toBe(true);
  });

  it('EventHintsSchema_RoundTripsThroughZodType_Succeeds', () => {
    const eh = {
      missing: [{ eventType: 'task.completed', description: 'missing ack', requiredFields: ['taskId'] }],
      phase: 'implement',
      checked: 3,
    };
    expect(EventHintsSchema.safeParse(eh).success).toBe(true);
  });

  it('CacheHintsSchema_RoundTripsThroughZodType_Succeeds', () => {
    const ch = { type: 'cache_boundary', position: 'after:v,projectionSequence', kind: 'ephemeral', ttl: '1h' };
    expect(CacheHintsSchema.safeParse(ch).success).toBe(true);
  });
});
