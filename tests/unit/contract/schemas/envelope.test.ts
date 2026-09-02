import { describe, it, expect, expectTypeOf } from 'vitest';
import { z } from 'zod';
import {
  NextActionSchema,
  ErrorEnvelopeSchema,
  EnvelopeSchema,
  SuccessEnvelopeSchema,
  PerfMetricsSchema,
  EventHintsSchema,
  CacheHintsSchema,
} from '../../../../src/contract/schemas/envelope.js';
import { wrap, wrapError } from '../../../../src/format.js';
import { ConcurrencyError } from '../../../../src/events/concurrency-error.js';
import { StorageBusyError } from '../../../../src/events/storage-busy-error.js';

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

  it('PerfMetricsSchema_RejectsNegativeValues_OnEachField', () => {
    // The JSDoc invariant says "non-negative" — enforce it at validation
    // time. Negatives on ms/bytes/tokens are nonsensical (time/size/usage
    // counters never run backwards) and would surface as confusing UI
    // values, so the schema must fail closed (CodeRabbit PR #1369 minor).
    expect(PerfMetricsSchema.safeParse({ ms: -1, bytes: 0, tokens: 0 }).success).toBe(false);
    expect(PerfMetricsSchema.safeParse({ ms: 0, bytes: -1, tokens: 0 }).success).toBe(false);
    expect(PerfMetricsSchema.safeParse({ ms: 0, bytes: 0, tokens: -1 }).success).toBe(false);
    // Zero is the documented default-0 fallback used by wrap()/wrapError(),
    // so it must still pass.
    expect(PerfMetricsSchema.safeParse({ ms: 0, bytes: 0, tokens: 0 }).success).toBe(true);
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

  it('EnvelopeSchema_SuccessLiteralNarrows_DiscriminatedUnion', () => {
    // Compile-time only: with `success: z.literal(true)` on the success branch
    // and `z.literal(false)` on the error branch, narrowing the inferred
    // union by `env.success === true` MUST yield the success variant's
    // `data` property — proving the DU narrows precisely at the TS level.
    //
    // This is the long-deferred narrowing tightening (D.2/D.3 era) — the
    // success literal was previously `z.boolean()`, which collapsed the
    // discriminant and made `env.data` always optional even on the success
    // branch.
    const schema = EnvelopeSchema(z.object({ foo: z.string() }));
    type Env = z.infer<typeof schema>;

    // Pure type-level assertion — body never executes at runtime; the
    // `false &&` short-circuits before dereferencing the cast `Env` value.
    // The compile-time `expectTypeOf` / `@ts-expect-error` checks still run
    // because TypeScript evaluates them statically.
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const _typeCheck = (env: Env): void => {
      if (env.success === true) {
        expectTypeOf(env.data).toEqualTypeOf<{ foo: string }>();
      } else {
        // @ts-expect-error — `data` is success-branch only; the error
        // variant has no `data` field. This line proves precise narrowing.
        void env.data;
        expectTypeOf(env.error.code).toEqualTypeOf<string>();
      }
    };

    // Runtime sanity: confirm both branches still validate (so the test
    // also catches regressions where the DU itself stops accepting envelopes).
    const success = wrap({ foo: 'x' }, {}, { ms: 0 });
    expect(schema.safeParse(success).success).toBe(true);
    const failure = wrapError(new Error('boom'));
    expect(schema.safeParse(failure).success).toBe(true);
  });
});
