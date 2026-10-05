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
  /** The value holds each base field of `NextAction` in `src/next-action.ts`. */
  it('NextActionSchema_AcceptsCanonicalNextAction_Succeeds', () => {
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
  /** `wrap()` gives the success branch, and `wrapError()` on a typed error gives the failure branch. */
  it('EnvelopeSchema_DiscriminatesOnSuccessField_AcceptsBothBranches', () => {
    const schema = EnvelopeSchema(z.object({ foo: z.string() }));

    const success = wrap({ foo: 'x' }, {}, { ms: 1 });
    expect(schema.safeParse(success).success).toBe(true);

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
      data: { foo: 42 },
      next_actions: [],
      _meta: {},
      _perf: { ms: 0, bytes: 0, tokens: 0 },
    };
    expect(schema.safeParse(bad).success).toBe(false);
  });

  it('SuccessEnvelopeSchema_AcceptsOptionalDecorators_Succeeds', () => {
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
    const pm = { ms: 5, bytes: 100, tokens: 25 };
    expect(PerfMetricsSchema.safeParse(pm).success).toBe(true);
  });

  /**
   * A time, size or usage counter is never negative. Zero must pass, because
   * `wrap()` and `wrapError()` emit it as the default.
   */
  it('PerfMetricsSchema_RejectsNegativeValues_OnEachField', () => {
    expect(PerfMetricsSchema.safeParse({ ms: -1, bytes: 0, tokens: 0 }).success).toBe(false);
    expect(PerfMetricsSchema.safeParse({ ms: 0, bytes: -1, tokens: 0 }).success).toBe(false);
    expect(PerfMetricsSchema.safeParse({ ms: 0, bytes: 0, tokens: -1 }).success).toBe(false);
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

  /**
   * The `success` literals make the inferred union narrow on `env.success`. Only
   * the success variant holds `data`. `_typeCheck` holds the type assertions and
   * never runs, so only a type checker can fail them. The runtime assertions
   * make sure that the union still accepts both branches.
   */
  it('EnvelopeSchema_SuccessLiteralNarrows_DiscriminatedUnion', () => {
    const schema = EnvelopeSchema(z.object({ foo: z.string() }));
    type Env = z.infer<typeof schema>;

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const _typeCheck = (env: Env): void => {
      if (env.success === true) {
        expectTypeOf(env.data).toEqualTypeOf<{ foo: string }>();
      } else {
        // @ts-expect-error — `data` is success-branch only.
        void env.data;
        expectTypeOf(env.error.code).toEqualTypeOf<string>();
      }
    };

    const success = wrap({ foo: 'x' }, {}, { ms: 0 });
    expect(schema.safeParse(success).success).toBe(true);
    const failure = wrapError(new Error('boom'));
    expect(schema.safeParse(failure).success).toBe(true);
  });
});
