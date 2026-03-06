import { describe, it, expect } from 'vitest';
import { resolveSchemaRef, listSchemas } from './schema-introspection.js';

describe('resolveSchemaRef', () => {
  it('ResolveSchemaRef_ValidRef_ReturnsJsonSchema', () => {
    const jsonSchema = resolveSchemaRef('workflow.init');

    expect(jsonSchema).toBeDefined();
    expect(jsonSchema.type).toBe('object');
    expect(jsonSchema.properties).toBeDefined();

    const props = jsonSchema.properties as Record<string, unknown>;
    expect(props.featureId).toBeDefined();
    expect(props.workflowType).toBeDefined();
  });

  it('ResolveSchemaRef_InvalidRef_ThrowsError', () => {
    expect(() => resolveSchemaRef('workflow.nonexistent')).toThrow(
      /Action "nonexistent" not found/,
    );
  });

  it('ResolveSchemaRef_InvalidTool_ThrowsError', () => {
    expect(() => resolveSchemaRef('bogus.init')).toThrow(
      /Tool "exarchos_bogus" not found/,
    );
  });

  it('ResolveSchemaRef_InvalidFormat_ThrowsError', () => {
    expect(() => resolveSchemaRef('invalid')).toThrow(
      /Invalid schema ref format/,
    );
  });

  it('ResolveSchemaRef_EventAppend_ReturnsJsonSchema', () => {
    const jsonSchema = resolveSchemaRef('event.append');

    expect(jsonSchema).toBeDefined();
    expect(jsonSchema.type).toBe('object');

    const props = jsonSchema.properties as Record<string, unknown>;
    expect(props.stream).toBeDefined();
    expect(props.event).toBeDefined();
  });
});

describe('listSchemas', () => {
  it('ListSchemas_ReturnsAllToolsAndActions', () => {
    const schemas = listSchemas();

    // All 5 tools present
    expect(schemas).toHaveLength(5);

    const toolNames = schemas.map((s) => s.tool);
    expect(toolNames).toContain('exarchos_workflow');
    expect(toolNames).toContain('exarchos_event');
    expect(toolNames).toContain('exarchos_orchestrate');
    expect(toolNames).toContain('exarchos_view');
    expect(toolNames).toContain('exarchos_sync');

    // Check workflow has expected actions
    const workflow = schemas.find((s) => s.tool === 'exarchos_workflow')!;
    const actionNames = workflow.actions.map((a) => a.name);
    expect(actionNames).toContain('init');
    expect(actionNames).toContain('get');
    expect(actionNames).toContain('set');
    expect(actionNames).toContain('cancel');
    expect(actionNames).toContain('cleanup');
    expect(actionNames).toContain('reconcile');

    // Each action has description
    for (const tool of schemas) {
      for (const action of tool.actions) {
        expect(action.name).toBeTruthy();
        expect(action.description).toBeTruthy();
      }
    }
  });
});
