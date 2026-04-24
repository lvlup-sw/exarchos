import { describe, it, expect } from 'vitest';
import { pickFields, type Envelope } from './format.js';

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
