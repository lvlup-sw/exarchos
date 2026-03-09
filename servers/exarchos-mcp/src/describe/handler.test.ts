import { describe, it, expect } from 'vitest';
import { handleDescribe, handleEventTypeDescribe, handleEventDescribe } from './handler.js';
import { TOOL_REGISTRY } from '../registry.js';

const workflowTool = TOOL_REGISTRY.find(t => t.name === 'exarchos_workflow')!;
const eventTool = TOOL_REGISTRY.find(t => t.name === 'exarchos_event')!;
const workflowActions = workflowTool.actions;

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

  it('HandleDescribe_ActionWithAutoEmits_ReturnsEmissionMetadata', async () => {
    const result = await handleDescribe({ actions: ['init'] }, workflowTool.actions);
    expect(result.success).toBe(true);
    const data = result.data as Record<string, Record<string, unknown>>;
    expect(data.init.autoEmits).toEqual([
      { event: 'workflow.started', condition: 'always' },
    ]);
  });

  it('HandleDescribe_ActionWithoutAutoEmits_OmitsField', async () => {
    const result = await handleDescribe({ actions: ['get'] }, workflowTool.actions);
    expect(result.success).toBe(true);
    const data = result.data as Record<string, Record<string, unknown>>;
    // autoEmits should be omitted entirely (not null, not empty array)
    expect(data.get.autoEmits).toBeUndefined();
    expect('autoEmits' in data.get).toBe(false);
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

describe('handleEventDescribe emissionGuide', () => {
  it('HandleEventDescribe_EmissionGuide_ReturnsFullCatalog', async () => {
    const result = await handleEventDescribe({ emissionGuide: true }, eventTool.actions);
    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data).toHaveProperty('emissionGuide');
    const guide = data.emissionGuide as Record<string, unknown>;
    expect(guide).toHaveProperty('types');
    expect(guide).toHaveProperty('bySource');
    expect(guide).toHaveProperty('totalCount');
  });

  it('HandleEventDescribe_EmissionGuideAndEventTypes_ReturnsBoth', async () => {
    const result = await handleEventDescribe(
      { emissionGuide: true, eventTypes: ['workflow.transition'] },
      eventTool.actions,
    );
    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data).toHaveProperty('emissionGuide');
    expect(data).toHaveProperty('eventTypes');
  });

  it('HandleEventDescribe_EmissionGuideAndActions_ReturnsBoth', async () => {
    const result = await handleEventDescribe(
      { emissionGuide: true, actions: ['append'] },
      eventTool.actions,
    );
    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data).toHaveProperty('emissionGuide');
    expect(data).toHaveProperty('actions');
  });

  it('HandleEventDescribe_ActionsOnly_BackwardCompatible', async () => {
    const result = await handleEventDescribe({ actions: ['append'] }, eventTool.actions);
    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data).toHaveProperty('actions');
    expect(data).not.toHaveProperty('emissionGuide');
  });
});

describe('handleDescribe playbook', () => {
  it('HandleDescribe_PlaybookFeature_ReturnsSerializedPlaybooks', async () => {
    const result = await handleDescribe({ playbook: 'feature' }, workflowActions);
    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data).toHaveProperty('playbook');
    const playbook = data.playbook as Record<string, unknown>;
    expect(playbook).toHaveProperty('workflowType');
    expect(playbook.workflowType).toBe('feature');
    expect(playbook).toHaveProperty('phases');
    const phases = playbook.phases as Record<string, unknown>;
    expect(phases).toHaveProperty('ideate');
    expect(phases).toHaveProperty('plan');
    expect(phases).toHaveProperty('delegate');
  });

  it('HandleDescribe_PlaybookAll_ReturnsWorkflowTypeList', async () => {
    const result = await handleDescribe({ playbook: 'all' }, workflowActions);
    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data).toHaveProperty('playbook');
    const types = data.playbook as string[];
    expect(types).toContain('feature');
    expect(types).toContain('debug');
    expect(types).toContain('refactor');
  });

  it('HandleDescribe_PlaybookUnknown_ReturnsErrorWithValidTargets', async () => {
    const result = await handleDescribe({ playbook: 'nonexistent' }, workflowActions);
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('UNKNOWN_WORKFLOW_TYPE');
    expect(result.error?.validTargets).toBeDefined();
    expect(result.error?.validTargets?.length).toBeGreaterThan(0);
  });

  it('HandleDescribe_NoParams_ErrorIncludesPlaybookInExpectedShape', async () => {
    const result = await handleDescribe({} as { actions?: string[]; topology?: string; playbook?: string }, workflowActions);
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('INVALID_INPUT');
    expect(result.error?.expectedShape).toBeDefined();
    expect(result.error?.expectedShape).toHaveProperty('playbook');
  });

  it('HandleDescribe_PlaybookAndActions_ReturnsBoth', async () => {
    const result = await handleDescribe(
      { actions: ['init'], playbook: 'feature' },
      workflowActions,
    );
    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data).toHaveProperty('init');
    expect(data).toHaveProperty('playbook');
  });

  it('HandleDescribe_PlaybookMalformed_ReturnsInvalidInput', async () => {
    const result = await handleDescribe(
      { playbook: 123 as unknown as string },
      workflowActions,
    );
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('INVALID_INPUT');
    expect(result.error?.message).toContain('non-empty string');
  });

  it('HandleDescribe_PlaybookEmptyString_ReturnsInvalidInput', async () => {
    const result = await handleDescribe({ playbook: '' }, workflowActions);
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('INVALID_INPUT');
    expect(result.error?.message).toContain('non-empty string');
  });

  it('HandleDescribe_PlaybookOnly_ActionsNotInResult', async () => {
    const result = await handleDescribe({ playbook: 'feature' }, workflowActions);
    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data).toHaveProperty('playbook');
    expect(data).not.toHaveProperty('init');
    expect(data).not.toHaveProperty('get');
  });
});

describe('handleDescribe topology', () => {
  it('HandleDescribe_TopologyParam_ReturnsHSMForWorkflowType', async () => {
    const result = await handleDescribe({ topology: 'feature' }, workflowActions);
    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data).toHaveProperty('topology');
    const topology = data.topology as Record<string, unknown>;
    expect(topology).toHaveProperty('workflowType');
    expect(topology.workflowType).toBe('feature');
    expect(topology).toHaveProperty('states');
    expect(topology).toHaveProperty('transitions');
    expect(topology).toHaveProperty('tracks');
  });

  it('HandleDescribe_TopologyAll_ReturnsAllWorkflowTypes', async () => {
    const result = await handleDescribe({ topology: 'all' }, workflowActions);
    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data).toHaveProperty('topology');
    const topology = data.topology as Record<string, unknown>;
    expect(topology).toHaveProperty('workflowTypes');
    const types = topology.workflowTypes as Array<{ name: string }>;
    const names = types.map(t => t.name);
    expect(names).toContain('feature');
    expect(names).toContain('debug');
    expect(names).toContain('refactor');
  });

  it('HandleDescribe_TopologyInvalidType_ReturnsError', async () => {
    const result = await handleDescribe({ topology: 'nonexistent' }, workflowActions);
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('UNKNOWN_WORKFLOW_TYPE');
  });

  it('HandleDescribe_TopologyAndActions_ReturnsBoth', async () => {
    const result = await handleDescribe(
      { actions: ['init'], topology: 'feature' },
      workflowActions,
    );
    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data).toHaveProperty('init');
    expect(data).toHaveProperty('topology');
    const initDesc = data.init as Record<string, unknown>;
    expect(initDesc).toHaveProperty('description');
    expect(initDesc).toHaveProperty('schema');
    const topology = data.topology as Record<string, unknown>;
    expect(topology).toHaveProperty('workflowType');
  });

  it('HandleDescribe_ActionsOnly_BackwardCompatible', async () => {
    const result = await handleDescribe({ actions: ['init'] }, workflowActions);
    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data).toHaveProperty('init');
    expect(data).not.toHaveProperty('topology');
  });
});
