import { describe, it, expect } from 'vitest';
import { resolveSchemaRef, listSchemas, resolveTopologyRef, resolveEmissionCatalog, resolvePlaybookRef } from '../../../../src/adapters/cli/schema-introspection.js';

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
    // T5a.1/DR-4 (#1259, v2.11): `set` removed; `transition` is now the
    // canonical phase-mutation action exposed in the schema introspection
    // surface.
    expect(actionNames).toContain('init');
    expect(actionNames).toContain('get');
    expect(actionNames).toContain('transition');
    expect(actionNames).toContain('cancel');
    expect(actionNames).toContain('cleanup');
    expect(actionNames).toContain('reconcile');
    expect(actionNames).not.toContain('set');

    // Each action has description
    for (const tool of schemas) {
      for (const action of tool.actions) {
        expect(action.name).toBeTruthy();
        expect(action.description).toBeTruthy();
      }
    }
  });

  // Bug #1218: the CLI introspection surface lists the FULL registry
  // (including tools that MCP `tools/list` filters out). To keep that
  // asymmetry visible — without breaking anything — every entry now carries
  // a `hidden` flag so renderers can mark hidden tools as operator-only.
  it('ListSchemas_TagsHiddenTools_PreservingTierModel', () => {
    const schemas = listSchemas();

    const sync = schemas.find((s) => s.tool === 'exarchos_sync');
    expect(sync, 'exarchos_sync must remain in the CLI introspection surface').toBeDefined();
    expect(sync!.hidden).toBe(true);

    // All currently visible composite tools must report hidden === false.
    for (const visibleName of [
      'exarchos_workflow',
      'exarchos_event',
      'exarchos_orchestrate',
      'exarchos_view',
    ]) {
      const tool = schemas.find((s) => s.tool === visibleName);
      expect(tool, `${visibleName} must be present in CLI listSchemas()`).toBeDefined();
      expect(tool!.hidden).toBe(false);
    }
  });
});

describe('resolveTopologyRef', () => {
  it('ResolveTopologyRef_ValidType_ReturnsTopology', () => {
    const result = resolveTopologyRef('feature');
    expect(result).toHaveProperty('workflowType', 'feature');
    expect(result).toHaveProperty('states');
    expect(result).toHaveProperty('transitions');
    expect(result).toHaveProperty('tracks');
    expect(result.initialPhase).toBe('plan');
  });

  it('ResolveTopologyRef_NoType_ReturnsAllTypes', () => {
    const result = resolveTopologyRef();
    expect(result).toHaveProperty('workflowTypes');
    expect(result.workflowTypes.length).toBeGreaterThanOrEqual(3);
    const names = result.workflowTypes.map((t: { name: string }) => t.name);
    expect(names).toContain('feature');
    expect(names).toContain('debug');
    expect(names).toContain('refactor');
  });

  it('ResolveTopologyRef_InvalidType_ThrowsError', () => {
    expect(() => resolveTopologyRef('nonexistent')).toThrow(/Unknown workflow type/);
  });
});

describe('resolvePlaybookRef', () => {
  it('ResolvePlaybookRef_Feature_ReturnsSerializedPlaybooks', () => {
    const result = resolvePlaybookRef('feature');
    expect(result).toHaveProperty('workflowType', 'feature');
    expect(result).toHaveProperty('phases');
    expect(result).toHaveProperty('phaseCount');
    expect((result as { phaseCount: number }).phaseCount).toBeGreaterThan(0);
  });

  it('ResolvePlaybookRef_NoArg_ReturnsWorkflowTypeList', () => {
    const result = resolvePlaybookRef();
    expect(Array.isArray(result)).toBe(true);
    const types = result as string[];
    expect(types).toContain('feature');
    expect(types).toContain('debug');
    expect(types).toContain('refactor');
  });
});

describe('resolveEmissionCatalog', () => {
  it('ResolveEmissionCatalog_ReturnsCatalog', () => {
    const result = resolveEmissionCatalog();
    expect(result).toHaveProperty('types');
    expect(result).toHaveProperty('bySource');
    expect(result).toHaveProperty('totalCount');
    expect(result.totalCount).toBeGreaterThan(0);
    expect(result.bySource.auto.length).toBeGreaterThan(0);
    expect(result.bySource.model.length).toBeGreaterThan(0);
  });
});
