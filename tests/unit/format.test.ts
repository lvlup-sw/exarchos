import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import {
  applyCacheHints,
  pickFields,
  toEnvelope,
  wrap,
  wrapError,
  wrapWithPassthrough,
  type Envelope,
  type ToolResult,
} from '../../src/format.js';
import { EnvelopeSchema, ErrorEnvelopeSchema } from '../../src/contract/schemas/envelope.js';
import type { NextAction } from '../../src/next-action.js';
import {
  ANTHROPIC_NATIVE_CACHING,
  createInMemoryResolver,
} from '../../src/workflow/capabilities/resolver.js';
import { STABLE_PREFIX_KEYS } from '../../src/projections/rehydration/serialize.js';
import { ConcurrencyError } from '../../src/events/concurrency-error.js';
import { StorageBusyError } from '../../src/events/storage-busy-error.js';

describe('pickFields', () => {
  it('pickFields_TopLevelField_ReturnsValue', () => {
    const obj = { type: 'task.completed', data: { taskId: 't1' }, sequence: 1 };
    const result = pickFields(obj, ['type', 'sequence']);
    expect(result).toEqual({ type: 'task.completed', sequence: 1 });
  });

  it('pickFields_WithDotPath_ReturnsNestedField', () => {
    const obj = { data: { taskId: 't1', title: 'Test' }, type: 'task.completed' };
    const result = pickFields(obj, ['data.taskId']);
    expect(result).toEqual({ data: { taskId: 't1' } });
  });

  it('pickFields_WithDotPath_MultipleNestedFields', () => {
    const obj = { data: { taskId: 't1', title: 'Test', assignee: 'agent-1' }, type: 'task.completed' };
    const result = pickFields(obj, ['data.taskId', 'data.assignee', 'type']);
    expect(result).toEqual({ data: { taskId: 't1', assignee: 'agent-1' }, type: 'task.completed' });
  });

  it('pickFields_WithDotPath_MissingIntermediateKey', () => {
    const obj = { type: 'task.completed' };
    const result = pickFields(obj, ['data.taskId']);
    expect(result).toEqual({});
  });

  it('pickFields_ProtoPollution_BlocksProtoKeys', () => {
    // Use null-prototype objects with actual own __proto__ keys
    const obj = Object.create(null) as Record<string, unknown>;
    obj['__proto__'] = { polluted: true };
    obj['data'] = Object.create(null);
    (obj['data'] as Record<string, unknown>)['__proto__'] = { x: 1 };
    obj['normal'] = 'ok';
    const result = pickFields(obj, ['__proto__.polluted', 'data.__proto__.x', 'constructor.prototype', 'normal']);
    // Proto paths are silently skipped; normal field is returned
    expect(result).toEqual({ normal: 'ok' });
    // Verify no prototype pollution occurred
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
  });

  it('pickFields_OwnPropertyOnly_IgnoresInherited', () => {
    const proto = { inherited: 'yes' };
    const obj = Object.create(proto) as Record<string, unknown>;
    obj['own'] = 'value';
    const result = pickFields(obj, ['inherited', 'own']);
    // Only own properties are picked
    expect(result).toEqual({ own: 'value' });
  });
});

describe('Envelope<T>', () => {
  it('Envelope_WrapsData_CarriesMetaAndPerf', () => {
    // Type-level assertion: this assignment compiles only if the Envelope<T>
    // shape matches exactly (success, data: T, next_actions, _meta, _perf).
    const env: Envelope<{ foo: string }> = {
      success: true,
      data: { foo: 'bar' },
      next_actions: [],
      _meta: {},
      _perf: { ms: 1, bytes: 10, tokens: 3 },
    };

    // Runtime assertion: data is strongly typed as { foo: string }.
    expect(env.data.foo).toBe('bar');
    expect(env.success).toBe(true);
    expect(env.next_actions).toEqual([]);
    expect(env._perf).toEqual({ ms: 1, bytes: 10, tokens: 3 });
    expect(env._meta).toEqual({});
  });
});

describe('wrap<T>', () => {
  it('Wrap_WithAllArgs_ReturnsFullEnvelope', () => {
    const env = wrap(
      { foo: 'bar' },
      { checkpointAdvised: false },
      { ms: 5, bytes: 100, tokens: 7 },
    );
    expect(env).toEqual({
      success: true,
      data: { foo: 'bar' },
      next_actions: [],
      _meta: { checkpointAdvised: false },
      _perf: { ms: 5, bytes: 100, tokens: 7 },
    });
  });

  it('Wrap_WithoutMetaOrPerf_DefaultsToEmptyObjects', () => {
    const env = wrap({ phase: 'ideate' });
    expect(env.success).toBe(true);
    expect(env.data).toEqual({ phase: 'ideate' });
    expect(env.next_actions).toEqual([]);
    expect(env._meta).toEqual({});
    expect(env._perf).toEqual({ ms: 0, bytes: 0, tokens: 0 });
  });

  it('Wrap_WithPartialPerf_FillsMissingFieldsWithZero', () => {
    const env = wrap('scalar-data', {}, { ms: 42 });
    expect(env._perf).toEqual({ ms: 42, bytes: 0, tokens: 0 });
    expect(env.data).toBe('scalar-data');
  });

  it('Wrap_PreservesStrongDataTyping', () => {
    // Type-level assertion: the return type is `Envelope<{ id: number }>`.
    const env = wrap({ id: 99 });
    // This compiles only if `env.data` is typed as `{ id: number }`.
    const id: number = env.data.id;
    expect(id).toBe(99);
  });

  // ─── T041: wrap() accepts computed next_actions ────────────────────────────
  //
  // DR-8: envelopes must carry affordance hints (`next_actions`) computed
  // from the current workflow state + HSM topology. The composite layer
  // (which already knows the state) computes them and passes the resulting
  // `NextAction[]` into `wrap()`. When omitted, the default remains `[]`
  // (backward-compatible with T014/T036 call sites that do not yet have
  // workflow state at the wrap boundary).

  it('Envelope_NextActions_NonEmptyForActiveWorkflow', () => {
    const action: NextAction = {
      verb: 'delegate',
      reason: 'Transition to delegate',
      validTargets: ['delegate'],
    };

    const env = wrap(
      { phase: 'plan-review' },
      { checkpointAdvised: false },
      { ms: 5 },
      [action],
    );

    expect(env.next_actions).toEqual([action]);
    // The rest of the envelope shape is untouched.
    expect(env.success).toBe(true);
    expect(env.data).toEqual({ phase: 'plan-review' });
    expect(env._meta).toEqual({ checkpointAdvised: false });
    expect(env._perf.ms).toBe(5);
  });

  it('Envelope_NextActions_DefaultsToEmpty_WhenOmitted', () => {
    // Backward-compat: existing call sites that do not pass `nextActions`
    // still get an empty array, preserving the T036–T039 contract.
    const env = wrap({ phase: 'ideate' }, undefined, undefined);
    expect(env.next_actions).toEqual([]);
  });
});

describe('wrapWithPassthrough — diagnostic side-channels (CodeRabbit MEDIUM #1178)', () => {
  // The composite-boundary helper threads `warnings` and `_corrections` from
  // the source `ToolResult` onto an envelope. Without it, every composite
  // (workflow / view / orchestrate / event) silently drops both fields when
  // converting from the handler's `ToolResult` shape into `Envelope<T>`.

  function makeEnvelope(): Envelope<{ phase: string }> {
    return wrap({ phase: 'ideate' }, { fooMeta: 'bar' }, { ms: 5 });
  }

  it('WrapPassthrough_NoSideChannels_ReturnsEnvelopeUnchanged', () => {
    // Normal-path output must stay minimal: no `warnings`, no `_corrections`.
    const source: ToolResult = { success: true, data: { phase: 'ideate' } };
    const env = makeEnvelope();
    const out = wrapWithPassthrough(source, env);
    expect((out as unknown as Envelope<unknown>).data).toEqual({ phase: 'ideate' });
    expect((out as unknown as Record<string, unknown>).warnings).toBeUndefined();
    expect((out as unknown as Record<string, unknown>)._corrections).toBeUndefined();
  });

  it('WrapPassthrough_WarningsPresent_ThreadOntoEnvelope', () => {
    // Handlers attach human-visible advisory strings via `warnings`. Losing
    // them at the composite boundary would silently swallow the signal.
    const source: ToolResult = {
      success: true,
      data: { phase: 'ideate' },
      warnings: ['deprecated field used'],
    };
    const out = wrapWithPassthrough(source, makeEnvelope()) as unknown as Record<string, unknown>;
    expect(out.warnings).toEqual(['deprecated field used']);
  });

  it('WrapPassthrough_EmptyWarnings_OmitFromEnvelope', () => {
    // `[]` carries no information — keep the wire shape minimal.
    const source: ToolResult = {
      success: true,
      data: { phase: 'ideate' },
      warnings: [],
    };
    const out = wrapWithPassthrough(source, makeEnvelope()) as unknown as Record<string, unknown>;
    expect(out.warnings).toBeUndefined();
  });

  it('WrapPassthrough_CorrectionsPresent_ThreadOntoEnvelope', () => {
    // Auto-correction telemetry: even an empty `applied` array is signal
    // ("a correction pass ran, found nothing"), so preserve as-is.
    const source: ToolResult = {
      success: true,
      data: { phase: 'ideate' },
      _corrections: { applied: [] },
    };
    const out = wrapWithPassthrough(source, makeEnvelope()) as unknown as Record<string, unknown>;
    expect(out._corrections).toEqual({ applied: [] });
  });

  it('WrapPassthrough_EventHintsPresent_ThreadOntoEnvelope', () => {
    // Per-action event acks set on the source ToolResult by handlers that
    // emit events (the field shape is shared with Envelope). Composite
    // wrapping must forward this field; without the passthrough, callers
    // would never see which events the handler emitted.
    const source: ToolResult = {
      success: true,
      data: { phase: 'ideate' },
      _eventHints: {
        missing: [
          {
            eventType: 'workflow.rehydrated',
            description: 'rehydration ack emitted',
            requiredFields: ['streamId', 'sequence'],
          },
        ],
        phase: 'rehydrate',
        checked: 1,
      },
    };
    const out = wrapWithPassthrough(source, makeEnvelope()) as unknown as Record<string, unknown>;
    expect(out._eventHints).toEqual(source._eventHints);
  });
});

// ─── T051 (DR-14): Conditional cache_control hints ─────────────────────────
//
// The rehydration document (T050) has a stable prefix (`STABLE_PREFIX_KEYS`) and a
// volatile suffix (`VOLATILE_KEYS`). On Anthropic-native runtimes we signal
// a cache boundary between the two so that the consumer can wrap their API
// call with `cache_control: { type: "ephemeral", ttl: "1h" }`. JSON has no
// inline markup boundary, so we emit a sibling `_cacheHints` field on the
// envelope (Option A in the task spec) — this preserves the single-document
// envelope contract and is backward-compatible with consumers that don't
// know about the hint.
describe('applyCacheHints (T051, DR-14)', () => {
  it('EnvelopeSerializer_AnthropicNative_IncludesCacheControl', () => {
    const resolver = createInMemoryResolver([ANTHROPIC_NATIVE_CACHING]);
    const envelope = wrap({ v: 1, projectionSequence: 7 });

    const hinted = applyCacheHints(envelope, resolver);

    expect(hinted._cacheHints).toBeDefined();
    expect(hinted._cacheHints).toEqual({
      kind: 'ephemeral',
      ttl: '1h',
      type: 'cache_boundary',
      position: `after:${STABLE_PREFIX_KEYS.join(',')}`,
    });
    // Rest of envelope untouched.
    expect(hinted.success).toBe(true);
    expect(hinted.data).toEqual({ v: 1, projectionSequence: 7 });
    expect(hinted.next_actions).toEqual([]);
  });

  it('EnvelopeSerializer_OtherRuntime_OmitsMarkers', () => {
    const resolver = createInMemoryResolver([]); // no anthropic_native_caching
    const envelope = wrap({ v: 1, projectionSequence: 7 });

    const hinted = applyCacheHints(envelope, resolver);

    expect(hinted._cacheHints).toBeUndefined();
    expect('_cacheHints' in hinted).toBe(false);
    // Shape is otherwise unchanged.
    expect(hinted.success).toBe(true);
    expect(hinted.data).toEqual({ v: 1, projectionSequence: 7 });
  });
});

// ─── Wave 3 Task 3.13 / 3.13a — wrapError() typed-error envelope mapping ────

describe('wrapError() — ConcurrencyError → CONCURRENCY_CONFLICT envelope (Task 3.13)', () => {
  it('Wrap_MapsConcurrencyErrorToConcurrencyConflictEnvelope', () => {
    const err = new ConcurrencyError({
      streamId: 'feature/foo',
      reducerId: 'merge-orchestrator@v1',
      expectedVersion: 42,
      actualVersion: 47,
      operationId: 'op-abc',
    });

    const envelope = wrapError(err) as ToolResult;

    expect(envelope.success).toBe(false);
    expect(envelope.error).toBeDefined();
    const e = envelope.error as Record<string, unknown>;
    expect(e.code).toBe('CONCURRENCY_CONFLICT');
    expect(e.streamId).toBe('feature/foo');
    expect(e.reducerId).toBe('merge-orchestrator@v1');
    expect(e.expectedVersion).toBe(42);
    expect(e.actualVersion).toBe(47);
    expect(e.operationId).toBe('op-abc');
    expect(e.validTargets).toEqual(['retry']);
    // suggestedFix mentions re-fetch + retry per design.
    expect(typeof e.suggestedFix).toBe('object');
    const fix = e.suggestedFix as Record<string, unknown>;
    const fixStr = JSON.stringify(fix).toLowerCase();
    expect(fixStr).toMatch(/re-?fetch|retry/);

    // _meta.retryable: true (INV-5b).
    const meta = envelope._meta as Record<string, unknown>;
    expect(meta.retryable).toBe(true);

    // _perf shape present with the canonical zero defaults.
    expect(envelope._perf).toEqual({ ms: 0, bytes: 0, tokens: 0 });
  });

  it('Wrap_MapsConcurrencyErrorWithoutOperationId', () => {
    const err = new ConcurrencyError({
      streamId: 's',
      reducerId: 'r@v1',
      expectedVersion: 1,
      actualVersion: 2,
    });
    const envelope = wrapError(err) as ToolResult;
    const e = envelope.error as Record<string, unknown>;
    expect(e.code).toBe('CONCURRENCY_CONFLICT');
    expect(e.operationId).toBeUndefined();
  });
});

describe('wrapError() — StorageBusyError → STORAGE_BUSY envelope (Task 3.13a)', () => {
  it('Wrap_MapsStorageBusyErrorToStorageBusyEnvelope', () => {
    const cause = new Error('SQLITE_BUSY');
    const err = new StorageBusyError({
      streamId: 's',
      attempts: 5,
      cause,
    });

    const envelope = wrapError(err) as ToolResult;

    expect(envelope.success).toBe(false);
    expect(envelope.error).toBeDefined();
    const e = envelope.error as Record<string, unknown>;
    expect(e.code).toBe('STORAGE_BUSY');
    expect(e.streamId).toBe('s');
    expect(e.attempts).toBe(5);
    expect(e.validTargets).toEqual(['retry']);
    // suggestedFix mentions back-off / substrate contention.
    const fix = e.suggestedFix as Record<string, unknown>;
    const fixStr = JSON.stringify(fix).toLowerCase();
    expect(fixStr).toMatch(/back off|cross-process write contention/);

    // _meta.retryable: true.
    const meta = envelope._meta as Record<string, unknown>;
    expect(meta.retryable).toBe(true);

    // _perf shape present with zero defaults.
    expect(envelope._perf).toEqual({ ms: 0, bytes: 0, tokens: 0 });
  });

  it('Wrap_MapsConcurrencyAndStorageBusyToDistinctCodes', () => {
    // Sibling errors must surface with DIFFERENT codes so middleware can
    // route them to different retry budgets (audit §F2.1).
    const cErr = new ConcurrencyError({
      streamId: 's',
      reducerId: 'r@v1',
      expectedVersion: 1,
      actualVersion: 2,
    });
    const sErr = new StorageBusyError({
      streamId: 's',
      attempts: 5,
      cause: new Error('SQLITE_BUSY'),
    });
    const c = wrapError(cErr) as ToolResult;
    const s = wrapError(sErr) as ToolResult;
    expect((c.error as Record<string, unknown>).code).toBe('CONCURRENCY_CONFLICT');
    expect((s.error as Record<string, unknown>).code).toBe('STORAGE_BUSY');
  });
});

describe('toEnvelope', () => {
  it('toEnvelope_MapsSuccessToolResult_ReturnsSuccessEnvelope', () => {
    const result: ToolResult = {
      success: true,
      data: { x: 1 },
      _meta: { phase: 'design' },
      _perf: { ms: 5, bytes: 100, tokens: 25 },
    };
    const env = toEnvelope(result);
    expect(env.success).toBe(true);
    if (env.success) {
      expect(env.data).toEqual({ x: 1 });
      expect(env.next_actions).toEqual([]);
      expect(env._meta).toEqual({ phase: 'design' });
      expect(env._perf).toEqual({ ms: 5, bytes: 100, tokens: 25 });
    }
  });

  it('toEnvelope_MapsFailureToolResult_ReturnsErrorEnvelope', () => {
    const result: ToolResult = {
      success: false,
      error: { code: 'X', message: 'y' },
    };
    const env = toEnvelope(result);
    expect(env.success).toBe(false);
    if (!env.success) {
      expect(env.error.code).toBe('X');
      expect(env.error.message).toBe('y');
    }
  });

  it('toEnvelope_PreservesErrorAuxFields_ReturnsErrorEnvelope', () => {
    // Composite handlers attach validTargets / suggestedFix on the
    // ToolResult.error block; toEnvelope must thread these through
    // unchanged so the carrier sees a full diagnostic envelope.
    const result: ToolResult = {
      success: false,
      error: {
        code: 'INVALID_PHASE',
        message: 'phase cannot regress',
        validTargets: ['design', 'plan'],
        suggestedFix: { tool: 'workflow_status', params: { featureId: 'abc' } },
      },
    };
    const env = toEnvelope(result);
    expect(env.success).toBe(false);
    if (!env.success) {
      expect(env.error.validTargets).toEqual(['design', 'plan']);
      expect(env.error.suggestedFix).toEqual({
        tool: 'workflow_status',
        params: { featureId: 'abc' },
      });
    }
  });

  it('toEnvelope_RoundTripsThroughEnvelopeSchema', () => {
    const result: ToolResult = {
      success: true,
      data: { ok: true },
      _meta: {},
      _perf: { ms: 1, bytes: 0, tokens: 0 },
    };
    const env = toEnvelope(result);
    const parsed = EnvelopeSchema(z.unknown()).safeParse(env);
    expect(parsed.success).toBe(true);
  });

  it('toEnvelope_FailureRoundTripsThroughEnvelopeSchema', () => {
    const result: ToolResult = {
      success: false,
      error: { code: 'BOOM', message: 'kaboom' },
    };
    const env = toEnvelope(result);
    const parsed = EnvelopeSchema(z.unknown()).safeParse(env);
    expect(parsed.success).toBe(true);
  });

  // ─── #1208 saga-merge-detour regression / CodeRabbit PR #1369 HIGH/MED ────
  //
  // `envelopeWrap` (workflow/composite.ts) returns an Envelope cast as
  // ToolResult with `next_actions`, `warnings`, `_corrections`, `_eventHints`,
  // and `_cacheHints` already populated. The boundary adapter `toEnvelope`
  // must thread those through — silently dropping them was what made the
  // rehydrate envelope on a worktree-bearing task.completed return
  // `next_actions: []` even though the composite computed
  // `merge_orchestrate`.
  it('toEnvelope_SuccessWithNextActions_PreservesAffordances', () => {
    const verb: NextAction = {
      verb: 'merge_orchestrate',
      reason: 'worktree-bearing task.completed auto-detour',
      idempotencyKey: 'p2-detour:merge_orchestrate:001',
    };
    const result = {
      success: true,
      data: { phase: 'delegate' },
      next_actions: [verb],
      _meta: {},
      _perf: { ms: 1, bytes: 0, tokens: 0 },
    } as unknown as ToolResult;
    const env = toEnvelope(result);
    expect(env.success).toBe(true);
    if (env.success) {
      expect(env.next_actions).toEqual([verb]);
    }
  });

  it('toEnvelope_SuccessWithSideChannels_PreservesWarningsCorrectionsEventHintsCacheHints', () => {
    const result = {
      success: true,
      data: { ok: true },
      _meta: {},
      _perf: { ms: 1, bytes: 0, tokens: 0 },
      warnings: ['stale projection'],
      _corrections: { applied: [] },
      _eventHints: { missing: [], phase: 'delegate', checked: 0 },
      _cacheHints: {
        type: 'cache_boundary' as const,
        position: 'after:v,projectionSequence',
        kind: 'ephemeral' as const,
        ttl: '1h' as const,
      },
    } as unknown as ToolResult;
    const env = toEnvelope(result) as Envelope<unknown> & {
      warnings?: readonly string[];
      _corrections?: unknown;
      _eventHints?: unknown;
      _cacheHints?: unknown;
    };
    expect(env.warnings).toEqual(['stale projection']);
    expect(env._corrections).toEqual({ applied: [] });
    expect(env._eventHints).toEqual({ missing: [], phase: 'delegate', checked: 0 });
    expect(env._cacheHints).toEqual({
      type: 'cache_boundary',
      position: 'after:v,projectionSequence',
      kind: 'ephemeral',
      ttl: '1h',
    });
  });

  // ─── CodeRabbit PR #1369 CRITICAL: validTargets type narrowing ────────────
  //
  // `ToolResult.error.validTargets` accepts ValidTransitionTarget objects on
  // guard-failure paths. The carrier-side ErrorEnvelope advertises strings
  // only. Narrowing must extract the canonical `phase` string so the
  // envelope contract holds and downstream consumers don't crash on an
  // unexpected object.
  it('toEnvelope_FailureWithValidTransitionTargets_NarrowsToPhaseStrings', () => {
    const result: ToolResult = {
      success: false,
      error: {
        code: 'GUARD_FAILED',
        message: 'phase guard rejected the proposed transition',
        validTargets: [
          { phase: 'plan' },
          { phase: 'tdd', guard: { id: 'g.tdd', description: 'tdd guard' } },
          'design', // mixed string entry — composite handlers can pass either
        ],
      },
    };
    const env = toEnvelope(result);
    expect(env.success).toBe(false);
    if (!env.success) {
      expect(env.error.validTargets).toEqual(['plan', 'tdd', 'design']);
      const parsed = ErrorEnvelopeSchema.safeParse(env);
      expect(parsed.success).toBe(true);
    }
  });
});

// ─── F.5: wrapError round-trip — every branch validates as ErrorEnvelope ───
//
// `wrapError` has four real-world entry shapes (design §2.5 / format.ts):
//   1. ConcurrencyError      — typed event-store conflict.
//   2. StorageBusyError      — typed substrate contention.
//   3. Plain `Error` instance — caught-and-rethrown handler crash.
//   4. Plain string          — legacy fallthrough (some adapters still throw
//                              raw strings on misuse paths).
//
// Each must produce an envelope that validates as `ErrorEnvelopeSchema`.
// Without this gate, a future refactor could quietly emit a malformed
// failure envelope (e.g. missing `_perf` or mis-shaped `error`) and the
// only signal would be downstream consumer breakage.
describe('WrapError_AllBranches_ValidatesAgainstErrorEnvelopeSchema (F.5)', () => {
  it('WrapError_ConcurrencyError_RoundTripsThroughErrorEnvelopeSchema', () => {
    const err = new ConcurrencyError({
      streamId: 'stream-rt',
      reducerId: 'rt@v1',
      expectedVersion: 1,
      actualVersion: 2,
    });
    const env = wrapError(err);
    const parsed = ErrorEnvelopeSchema.safeParse(env);
    expect(
      parsed.success,
      parsed.success
        ? undefined
        : `ConcurrencyError envelope failed schema: ${JSON.stringify(parsed.error?.issues)}`,
    ).toBe(true);
  });

  it('WrapError_StorageBusyError_RoundTripsThroughErrorEnvelopeSchema', () => {
    const err = new StorageBusyError({
      streamId: 'stream-rt',
      attempts: 3,
      cause: new Error('SQLITE_BUSY'),
    });
    const env = wrapError(err);
    const parsed = ErrorEnvelopeSchema.safeParse(env);
    expect(
      parsed.success,
      parsed.success
        ? undefined
        : `StorageBusyError envelope failed schema: ${JSON.stringify(parsed.error?.issues)}`,
    ).toBe(true);
  });

  it('WrapError_GenericError_RoundTripsThroughErrorEnvelopeSchema', () => {
    const env = wrapError(new Error('unexpected handler crash'));
    const parsed = ErrorEnvelopeSchema.safeParse(env);
    expect(
      parsed.success,
      parsed.success
        ? undefined
        : `Generic Error envelope failed schema: ${JSON.stringify(parsed.error?.issues)}`,
    ).toBe(true);
  });

  it('WrapError_StringInput_RoundTripsThroughErrorEnvelopeSchema', () => {
    // Some legacy throw sites still pass plain strings — the wrapper must
    // normalise them onto a valid ErrorEnvelope even when the input lacks
    // an `Error.message` field.
    const env = wrapError('raw string failure');
    const parsed = ErrorEnvelopeSchema.safeParse(env);
    expect(
      parsed.success,
      parsed.success
        ? undefined
        : `String-input envelope failed schema: ${JSON.stringify(parsed.error?.issues)}`,
    ).toBe(true);
  });
});
