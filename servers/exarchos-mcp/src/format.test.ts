import { describe, it, expect } from 'vitest';
import { pickFields, wrap, type Envelope } from './format.js';
import type { NextAction } from './next-action.js';

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
