import { describe, it, expect } from 'vitest';
import { handleDescribe, handleEventTypeDescribe, handleEventDescribe } from './handler.js';
import { TOOL_REGISTRY } from '../registry.js';

const workflowTool = TOOL_REGISTRY.find(t => t.name === 'exarchos_workflow')!;
const eventTool = TOOL_REGISTRY.find(t => t.name === 'exarchos_event')!;

describe('handleDescribe', () => {
  it('HandleDescribe_ValidAction_ReturnsSchemaAndMetadata', async () => {
    const result = await handleDescribe({ actions: ['init'] }, workflowTool.actions);
    expect(result.success).toBe(true);
    expect(result.data).toHaveProperty('init');
    const desc = (result.data as Record<string, unknown>)['init'] as Record<string, unknown>;
    expect(desc).toHaveProperty('description');
    expect(desc).toHaveProperty('schema');
    expect(desc).toHaveProperty('phases');
    expect(desc).toHaveProperty('roles');
  });

  it('HandleDescribe_MultipleActions_ReturnsAll', async () => {
    const result = await handleDescribe({ actions: ['init', 'get'] }, workflowTool.actions);
    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(Object.keys(data)).toHaveLength(2);
    expect(data).toHaveProperty('init');
    expect(data).toHaveProperty('get');
  });

  it('HandleDescribe_UnknownAction_ReturnsErrorWithValidTargets', async () => {
    const result = await handleDescribe({ actions: ['nonexistent'] }, workflowTool.actions);
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('UNKNOWN_ACTION');
    expect(result.error?.validTargets).toBeDefined();
    expect(result.error?.validTargets?.length).toBeGreaterThan(0);
  });

  it('HandleDescribe_GateMetadata_IncludedWhenPresent', async () => {
    // Use orchestrate tool which has gate metadata on check_* actions
    // Note: gate metadata may not exist yet (T1 adds it). If action.gate is undefined, expect null.
    const orchTool = TOOL_REGISTRY.find(t => t.name === 'exarchos_orchestrate')!;
    const result = await handleDescribe({ actions: ['check_tdd_compliance'] }, orchTool.actions);
    expect(result.success).toBe(true);
    const desc = (result.data as Record<string, unknown>)['check_tdd_compliance'] as Record<string, unknown>;
    // gate field should be present (null if no gate metadata, object if present)
    expect('gate' in desc).toBe(true);
  });
});

describe('handleEventTypeDescribe', () => {
  it('EventTypeDescribe_ValidType_ReturnsSchemaSourceAndBuiltIn', async () => {
    const result = await handleEventTypeDescribe(['shepherd.iteration']);
    expect(result.success).toBe(true);
    const data = result.data as Record<string, Record<string, unknown>>;
    expect(data).toHaveProperty('shepherd.iteration');
    const desc = data['shepherd.iteration'];
    expect(desc.schema).not.toBeNull();
    expect(desc.source).toBe('model');
    expect(desc.isBuiltIn).toBe(true);
  });

  it('EventTypeDescribe_MultipleTypes_ReturnsAll', async () => {
    const result = await handleEventTypeDescribe(['team.spawned', 'workflow.started']);
    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(Object.keys(data)).toHaveLength(2);
    expect(data).toHaveProperty('team.spawned');
    expect(data).toHaveProperty('workflow.started');
  });

  it('EventTypeDescribe_UnknownType_ReturnsErrorWithValidTargets', async () => {
    const result = await handleEventTypeDescribe(['nonexistent.event']);
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('UNKNOWN_EVENT_TYPE');
    expect(result.error?.validTargets).toBeDefined();
    expect(result.error?.validTargets?.length).toBeGreaterThan(0);
  });

  it('EventTypeDescribe_AutoSource_ReturnsCorrectSource', async () => {
    const result = await handleEventTypeDescribe(['workflow.started']);
    expect(result.success).toBe(true);
    const data = result.data as Record<string, Record<string, unknown>>;
    expect(data['workflow.started'].source).toBe('auto');
  });

  it('EventTypeDescribe_SchemaContainsProperties_HasJsonSchema', async () => {
    const result = await handleEventTypeDescribe(['task.completed']);
    expect(result.success).toBe(true);
    const data = result.data as Record<string, Record<string, unknown>>;
    const schema = data['task.completed'].schema as Record<string, unknown>;
    // JSON Schema should have type and properties
    expect(schema.type).toBe('object');
    expect(schema).toHaveProperty('properties');
  });
});

describe('handleEventDescribe', () => {
  it('EventDescribe_ActionsOnly_ReturnsActionSchemas', async () => {
    const result = await handleEventDescribe({ actions: ['append'] }, eventTool.actions);
    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data).toHaveProperty('actions');
    expect(data).not.toHaveProperty('eventTypes');
  });

  it('EventDescribe_EventTypesOnly_ReturnsEventSchemas', async () => {
    const result = await handleEventDescribe({ eventTypes: ['shepherd.iteration'] }, eventTool.actions);
    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data).toHaveProperty('eventTypes');
    expect(data).not.toHaveProperty('actions');
  });

  it('EventDescribe_BothActionsAndEventTypes_ReturnsBoth', async () => {
    const result = await handleEventDescribe(
      { actions: ['append'], eventTypes: ['team.spawned'] },
      eventTool.actions,
    );
    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data).toHaveProperty('actions');
    expect(data).toHaveProperty('eventTypes');
  });

  it('EventDescribe_InvalidAction_ReturnsError', async () => {
    const result = await handleEventDescribe({ actions: ['nonexistent'] }, eventTool.actions);
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('UNKNOWN_ACTION');
  });

  it('EventDescribe_InvalidEventType_ReturnsError', async () => {
    const result = await handleEventDescribe({ eventTypes: ['nonexistent.type'] }, eventTool.actions);
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('UNKNOWN_EVENT_TYPE');
  });
});
