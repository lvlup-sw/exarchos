import { describe, it, expect } from 'vitest';
import {
  applyCacheHints,
  pickFields,
  wrap,
  wrapWithPassthrough,
  type Envelope,
  type ToolResult,
} from './format.js';
import type { NextAction } from './next-action.js';
import {
  ANTHROPIC_NATIVE_CACHING,
  createInMemoryResolver,
} from './capabilities/resolver.js';
import { STABLE_PREFIX_KEYS } from './projections/rehydration/serialize.js';

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
