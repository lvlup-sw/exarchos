import { describe, it, expect } from 'vitest';
import { pickFields } from './format.js';

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
    const obj = { __proto__: { polluted: true }, data: { __proto__: { x: 1 } }, normal: 'ok' };
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
