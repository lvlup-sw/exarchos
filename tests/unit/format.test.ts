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

  /**
   * The objects have a null prototype, so `__proto__` is an own key.
   * `pickFields` must skip each prototype path and must not pollute `Object.prototype`.
   */
  it('pickFields_ProtoPollution_BlocksProtoKeys', () => {
    const obj = Object.create(null) as Record<string, unknown>;
    obj['__proto__'] = { polluted: true };
    obj['data'] = Object.create(null);
    (obj['data'] as Record<string, unknown>)['__proto__'] = { x: 1 };
    obj['normal'] = 'ok';
    const result = pickFields(obj, ['__proto__.polluted', 'data.__proto__.x', 'constructor.prototype', 'normal']);
    expect(result).toEqual({ normal: 'ok' });
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
  });

  it('pickFields_OwnPropertyOnly_IgnoresInherited', () => {
    const proto = { inherited: 'yes' };
    const obj = Object.create(proto) as Record<string, unknown>;
    obj['own'] = 'value';
    const result = pickFields(obj, ['inherited', 'own']);
    expect(result).toEqual({ own: 'value' });
  });
});

describe('Envelope<T>', () => {
  /** The check is at the type level: the literal must satisfy `Envelope<{ foo: string }>`. */
  it('Envelope_WrapsData_CarriesMetaAndPerf', () => {
    const env: Envelope<{ foo: string }> = {
      success: true,
      data: { foo: 'bar' },
      next_actions: [],
      _meta: {},
      _perf: { ms: 1, bytes: 10, tokens: 3 },
    };

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

  /** The check is at the type level: `wrap` must return `Envelope<{ id: number }>`, so `env.data.id` is a `number`. */
  it('Wrap_PreservesStrongDataTyping', () => {
    const env = wrap({ id: 99 });
    const id: number = env.data.id;
    expect(id).toBe(99);
  });

  /** The composite layer computes `next_actions` from the workflow state and passes them to `wrap`. */
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
    expect(env.success).toBe(true);
    expect(env.data).toEqual({ phase: 'plan-review' });
    expect(env._meta).toEqual({ checkpointAdvised: false });
    expect(env._perf.ms).toBe(5);
  });

  it('Envelope_NextActions_DefaultsToEmpty_WhenOmitted', () => {
    const env = wrap({ phase: 'ideate' }, undefined, undefined);
    expect(env.next_actions).toEqual([]);
  });
});

/**
 * `wrapWithPassthrough` copies `warnings`, `_corrections` and `_eventHints` from the handler `ToolResult` onto the envelope.
 * Without it, the wrap of each composite drops those fields.
 */
describe('wrapWithPassthrough — diagnostic side-channels (CodeRabbit MEDIUM #1178)', () => {
  function makeEnvelope(): Envelope<{ phase: string }> {
    return wrap({ phase: 'ideate' }, { fooMeta: 'bar' }, { ms: 5 });
  }

  it('WrapPassthrough_NoSideChannels_ReturnsEnvelopeUnchanged', () => {
    const source: ToolResult = { success: true, data: { phase: 'ideate' } };
    const env = makeEnvelope();
    const out = wrapWithPassthrough(source, env);
    expect((out as unknown as Envelope<unknown>).data).toEqual({ phase: 'ideate' });
    expect((out as unknown as Record<string, unknown>).warnings).toBeUndefined();
    expect((out as unknown as Record<string, unknown>)._corrections).toBeUndefined();
  });

  it('WrapPassthrough_WarningsPresent_ThreadOntoEnvelope', () => {
    const source: ToolResult = {
      success: true,
      data: { phase: 'ideate' },
      warnings: ['deprecated field used'],
    };
    const out = wrapWithPassthrough(source, makeEnvelope()) as unknown as Record<string, unknown>;
    expect(out.warnings).toEqual(['deprecated field used']);
  });

  /** An empty `warnings` array carries no information, so the envelope leaves it out. */
  it('WrapPassthrough_EmptyWarnings_OmitFromEnvelope', () => {
    const source: ToolResult = {
      success: true,
      data: { phase: 'ideate' },
      warnings: [],
    };
    const out = wrapWithPassthrough(source, makeEnvelope()) as unknown as Record<string, unknown>;
    expect(out.warnings).toBeUndefined();
  });

  /** An empty `applied` array still shows that a correction pass ran, so the envelope keeps it. */
  it('WrapPassthrough_CorrectionsPresent_ThreadOntoEnvelope', () => {
    const source: ToolResult = {
      success: true,
      data: { phase: 'ideate' },
      _corrections: { applied: [] },
    };
    const out = wrapWithPassthrough(source, makeEnvelope()) as unknown as Record<string, unknown>;
    expect(out._corrections).toEqual({ applied: [] });
  });

  it('WrapPassthrough_EventHintsPresent_ThreadOntoEnvelope', () => {
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

/**
 * The rehydration document has a stable prefix (`STABLE_PREFIX_KEYS`) and a volatile suffix.
 * On a runtime with native Anthropic caching, the envelope marks the boundary between them in a sibling `_cacheHints` field.
 * JSON has no inline boundary markup, and a consumer that does not know the hint can ignore the field.
 */
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
    expect(hinted.success).toBe(true);
    expect(hinted.data).toEqual({ v: 1, projectionSequence: 7 });
    expect(hinted.next_actions).toEqual([]);
  });

  it('EnvelopeSerializer_OtherRuntime_OmitsMarkers', () => {
    const resolver = createInMemoryResolver([]);
    const envelope = wrap({ v: 1, projectionSequence: 7 });

    const hinted = applyCacheHints(envelope, resolver);

    expect(hinted._cacheHints).toBeUndefined();
    expect('_cacheHints' in hinted).toBe(false);
    expect(hinted.success).toBe(true);
    expect(hinted.data).toEqual({ v: 1, projectionSequence: 7 });
  });
});

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
    expect(typeof e.suggestedFix).toBe('object');
    const fix = e.suggestedFix as Record<string, unknown>;
    const fixStr = JSON.stringify(fix).toLowerCase();
    expect(fixStr).toMatch(/re-?fetch|retry/);

    const meta = envelope._meta as Record<string, unknown>;
    expect(meta.retryable).toBe(true);

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
    const fix = e.suggestedFix as Record<string, unknown>;
    const fixStr = JSON.stringify(fix).toLowerCase();
    expect(fixStr).toMatch(/back off|cross-process write contention/);

    const meta = envelope._meta as Record<string, unknown>;
    expect(meta.retryable).toBe(true);

    expect(envelope._perf).toEqual({ ms: 0, bytes: 0, tokens: 0 });
  });

  /** The two errors must have different codes, so a retry layer can give each one a different budget. */
  it('Wrap_MapsConcurrencyAndStorageBusyToDistinctCodes', () => {
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

  /** Composite handlers set `validTargets` and `suggestedFix` on the error block, and `toEnvelope` must keep both. */
  it('toEnvelope_PreservesErrorAuxFields_ReturnsErrorEnvelope', () => {
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

  /**
   * `envelopeWrap` returns an envelope cast as `ToolResult`, with `next_actions` and the side channels already set.
   * `toEnvelope` must keep them. If it drops `next_actions`, the caller does not see a computed `merge_orchestrate` action.
   */
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

  /**
   * `ToolResult.error.validTargets` can hold `ValidTransitionTarget` objects, but `ErrorEnvelope` declares strings.
   * `toEnvelope` must replace each object with its `phase` string. A plain string entry stays as it is.
   */
  it('toEnvelope_FailureWithValidTransitionTargets_NarrowsToPhaseStrings', () => {
    const result: ToolResult = {
      success: false,
      error: {
        code: 'GUARD_FAILED',
        message: 'phase guard rejected the proposed transition',
        validTargets: [
          { phase: 'plan' },
          { phase: 'tdd', guard: { id: 'g.tdd', description: 'tdd guard' } },
          'design',
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

/**
 * `wrapError` takes four input shapes: a `ConcurrencyError`, a `StorageBusyError`, a plain `Error`, and a plain string.
 * Each one must give an envelope that passes `ErrorEnvelopeSchema`.
 */
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
