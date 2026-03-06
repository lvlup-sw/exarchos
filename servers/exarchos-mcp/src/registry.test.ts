import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import {
  buildCompositeSchema,
  buildRegistrationSchema,
  coercedRecord,
  coercedPositiveInt,
  coercedNonnegativeInt,
  TOOL_REGISTRY,
} from './registry.js';
import type { ToolAction, CompositeTool } from './registry.js';

describe('buildCompositeSchema', () => {
  it('should create a discriminated union from two actions', () => {
    const actions: readonly ToolAction[] = [
      {
        name: 'init',
        description: 'Initialize a workflow',
        schema: z.object({ featureId: z.string() }),
        phases: new Set(['ideate']),
        roles: new Set(['lead']),
      },
      {
        name: 'get',
        description: 'Get workflow state',
        schema: z.object({ query: z.string().optional() }),
        phases: new Set(['ideate', 'plan']),
        roles: new Set(['any']),
      },
    ];

    const schema = buildCompositeSchema(actions);

    // Should parse a valid 'init' action
    const initResult = schema.safeParse({ action: 'init', featureId: 'test' });
    expect(initResult.success).toBe(true);

    // Should parse a valid 'get' action
    const getResult = schema.safeParse({ action: 'get', query: 'phase' });
    expect(getResult.success).toBe(true);

    // Should parse 'get' with optional field omitted
    const getNoQueryResult = schema.safeParse({ action: 'get' });
    expect(getNoQueryResult.success).toBe(true);

    // Should reject an invalid action
    const invalidResult = schema.safeParse({ action: 'invalid' });
    expect(invalidResult.success).toBe(false);
  });
});

describe('buildRegistrationSchema', () => {
  const testActions: readonly ToolAction[] = [
    {
      name: 'append',
      description: 'Append an event',
      schema: z.object({
        stream: z.string().min(1),
        event: z.record(z.string(), z.unknown()),
      }),
      phases: new Set(['ideate']),
      roles: new Set(['any']),
    },
    {
      name: 'query',
      description: 'Query events',
      schema: z.object({
        stream: z.string().min(1),
        limit: z.number().optional(),
      }),
      phases: new Set(['ideate']),
      roles: new Set(['any']),
    },
  ];

  it('should reject unrecognized parameters with a clear error', () => {
    const schema = buildRegistrationSchema(testActions);

    // "streamId" is a typo for "stream" — should be rejected, not silently dropped
    const result = schema.safeParse({
      action: 'append',
      streamId: 'workflow-123',
      event: { type: 'test' },
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      const errorMessage = result.error.message;
      expect(errorMessage).toContain('streamId');
    }
  });

  it('should accept valid parameters', () => {
    const schema = buildRegistrationSchema(testActions);

    const result = schema.safeParse({
      action: 'append',
      stream: 'workflow-123',
      event: { type: 'test' },
    });

    expect(result.success).toBe(true);
  });

  it('should return a ZodObject, not a raw shape', () => {
    const schema = buildRegistrationSchema(testActions);
    expect(schema).toBeInstanceOf(z.ZodObject);
  });
});

// ─── Type Coercion Tests ─────────────────────────────────────────────────────

describe('coercedRecord', () => {
  const schema = coercedRecord();

  it('should accept a native object', () => {
    const result = schema.safeParse({ type: 'workflow.transition' });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data).toEqual({ type: 'workflow.transition' });
  });

  it('should coerce a JSON string to an object', () => {
    const result = schema.safeParse('{"type":"workflow.transition"}');
    expect(result.success).toBe(true);
    if (result.success) expect(result.data).toEqual({ type: 'workflow.transition' });
  });

  it('should reject an invalid JSON string', () => {
    const result = schema.safeParse('not-json');
    expect(result.success).toBe(false);
  });

  it('should reject a JSON string that parses to a non-object', () => {
    const result = schema.safeParse('"just a string"');
    expect(result.success).toBe(false);
  });

  it('should reject a number', () => {
    const result = schema.safeParse(42);
    expect(result.success).toBe(false);
  });
});

describe('coercedPositiveInt', () => {
  const schema = coercedPositiveInt();

  it('should accept a native number', () => {
    const result = schema.safeParse(5);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data).toBe(5);
  });

  it('should coerce a string number', () => {
    const result = schema.safeParse('10');
    expect(result.success).toBe(true);
    if (result.success) expect(result.data).toBe(10);
  });

  it('should reject zero', () => {
    const result = schema.safeParse(0);
    expect(result.success).toBe(false);
  });

  it('should reject negative', () => {
    const result = schema.safeParse(-1);
    expect(result.success).toBe(false);
  });

  it('should reject non-numeric string', () => {
    const result = schema.safeParse('abc');
    expect(result.success).toBe(false);
  });
});

describe('coercedNonnegativeInt', () => {
  const schema = coercedNonnegativeInt();

  it('should accept zero', () => {
    const result = schema.safeParse(0);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data).toBe(0);
  });

  it('should coerce a string zero', () => {
    const result = schema.safeParse('0');
    expect(result.success).toBe(true);
    if (result.success) expect(result.data).toBe(0);
  });

  it('should reject negative', () => {
    const result = schema.safeParse(-1);
    expect(result.success).toBe(false);
  });
});

// ─── Registration Schema JSON Output ────────────────────────────────────────

describe('buildRegistrationSchema JSON Schema', () => {
  it('should emit type:object for coercedRecord fields', () => {
    const { zodToJsonSchema } = require('zod-to-json-schema') as typeof import('zod-to-json-schema');
    const workflow = TOOL_REGISTRY.find((t) => t.name === 'exarchos_workflow')!;
    const schema = buildRegistrationSchema(workflow.actions);
    const json = zodToJsonSchema(schema) as Record<string, unknown>;
    const props = json.properties as Record<string, Record<string, unknown>>;
    expect(props.updates).toEqual({ type: 'object', additionalProperties: {} });
  });

  it('should emit type:integer for coercedPositiveInt fields', () => {
    const { zodToJsonSchema } = require('zod-to-json-schema') as typeof import('zod-to-json-schema');
    const event = TOOL_REGISTRY.find((t) => t.name === 'exarchos_event')!;
    const schema = buildRegistrationSchema(event.actions);
    const json = zodToJsonSchema(schema) as Record<string, unknown>;
    const props = json.properties as Record<string, Record<string, unknown>>;
    expect(props.limit).toEqual({ type: 'integer', exclusiveMinimum: 0 });
  });

  it('should emit type:integer for coercedNonnegativeInt fields', () => {
    const { zodToJsonSchema } = require('zod-to-json-schema') as typeof import('zod-to-json-schema');
    const event = TOOL_REGISTRY.find((t) => t.name === 'exarchos_event')!;
    const schema = buildRegistrationSchema(event.actions);
    const json = zodToJsonSchema(schema) as Record<string, unknown>;
    const props = json.properties as Record<string, Record<string, unknown>>;
    expect(props.offset).toEqual({ type: 'integer', minimum: 0 });
  });
});

// ─── A2: TOOL_REGISTRY Tests ─────────────────────────────────────────────────

const ALL_FEATURE_PHASES = new Set([
  'ideate',
  'plan',
  'plan-review',
  'delegate',
  'review',
  'synthesize',
]);

function findComposite(name: string) {
  return TOOL_REGISTRY.find((c) => c.name === name);
}

function findAction(compositeName: string, actionName: string) {
  const composite = findComposite(compositeName);
  return composite?.actions.find((a) => a.name === actionName);
}

describe('TOOL_REGISTRY', () => {
  it('should have exactly 5 composites', () => {
    expect(TOOL_REGISTRY).toHaveLength(5);
  });

  it('should have the expected composite names', () => {
    const names = TOOL_REGISTRY.map((c) => c.name);
    expect(names).toEqual(
      expect.arrayContaining([
        'exarchos_workflow',
        'exarchos_event',
        'exarchos_orchestrate',
        'exarchos_view',
        'exarchos_sync',
      ]),
    );
  });

  describe('exarchos_workflow', () => {
    it('should have 6 actions: init, get, set, cancel, cleanup, reconcile', () => {
      const composite = findComposite('exarchos_workflow');
      expect(composite).toBeDefined();
      const actionNames = composite!.actions.map((a) => a.name);
      expect(actionNames).toEqual(['init', 'get', 'set', 'cancel', 'cleanup', 'reconcile']);
    });
  });

  describe('exarchos_orchestrate', () => {
    it('should have 22 actions for task management, review triage, gate checks, script execution, and composite actions', () => {
      const composite = findComposite('exarchos_orchestrate');
      expect(composite).toBeDefined();
      expect(composite!.actions).toHaveLength(22);

      const actionNames = composite!.actions.map((a) => a.name);
      expect(actionNames).toEqual(
        expect.arrayContaining([
          'task_claim',
          'task_complete',
          'task_fail',
          'review_triage',
          'prepare_delegation',
          'prepare_synthesis',
          'assess_stack',
          'check_design_completeness',
          'check_plan_coverage',
          'check_tdd_compliance',
          'check_post_merge',
          'check_task_decomposition',
          'check_static_analysis',
          'check_security_scan',
          'check_context_economy',
          'check_operational_resilience',
          'check_workflow_determinism',
          'check_review_verdict',
          'check_convergence',
          'check_provenance_chain',
          'check_event_emissions',
          'run_script',
        ]),
      );
    });
  });

  it('OrchestrateActions_MatchCompositeHandlers_InSync', async () => {
    const composite = findComposite('exarchos_orchestrate');
    expect(composite).toBeDefined();
    const registryNames = new Set(composite!.actions.map((a) => a.name));

    const { ACTION_HANDLER_KEYS } = await import('./orchestrate/composite.js');

    for (const handlerKey of ACTION_HANDLER_KEYS) {
      expect(
        registryNames.has(handlerKey),
        `Handler '${handlerKey}' in composite.ts is missing from registry.ts orchestrateActions`,
      ).toBe(true);
    }
    for (const registryName of registryNames) {
      expect(
        ACTION_HANDLER_KEYS.includes(registryName),
        `Registry action '${registryName}' has no handler in composite.ts`,
      ).toBe(true);
    }
  });

  it('should have non-empty phases for every action except init', () => {
    // init has empty phases by design — it relies on the guard's null-check
    // (no active workflow) rather than phase matching
    const EMPTY_PHASE_ACTIONS = new Set(['exarchos_workflow.init']);

    for (const composite of TOOL_REGISTRY) {
      for (const action of composite.actions) {
        const key = `${composite.name}.${action.name}`;
        if (EMPTY_PHASE_ACTIONS.has(key)) {
          expect(
            action.phases.size,
            `${key} should have empty phases (guard null-check only)`,
          ).toBe(0);
        } else {
          expect(
            action.phases.size,
            `${key} should have at least one phase`,
          ).toBeGreaterThan(0);
        }
      }
    }
  });

  it('should have non-empty roles for every action', () => {
    for (const composite of TOOL_REGISTRY) {
      for (const action of composite.actions) {
        expect(
          action.roles.size,
          `${composite.name}.${action.name} should have at least one role`,
        ).toBeGreaterThan(0);
      }
    }
  });

  it('should have a valid Zod schema for every action', () => {
    for (const composite of TOOL_REGISTRY) {
      for (const action of composite.actions) {
        expect(
          action.schema instanceof z.ZodObject,
          `${composite.name}.${action.name} should have a ZodObject schema`,
        ).toBe(true);
      }
    }
  });

  it('should cover all workflow phases across actions', () => {
    const coveredPhases = new Set<string>();
    for (const composite of TOOL_REGISTRY) {
      for (const action of composite.actions) {
        for (const phase of action.phases) {
          coveredPhases.add(phase);
        }
      }
    }

    for (const phase of ALL_FEATURE_PHASES) {
      expect(
        coveredPhases.has(phase),
        `Phase '${phase}' should be covered by at least one action`,
      ).toBe(true);
    }
  });

  describe('view actions include new team views', () => {
    it('TOOL_REGISTRY_ViewActions_IncludesTeamPerformance', () => {
      const viewComposite = findComposite('exarchos_view');
      expect(viewComposite).toBeDefined();
      const actionNames = viewComposite!.actions.map((a) => a.name);
      expect(actionNames).toContain('team_performance');
    });

    it('TOOL_REGISTRY_ViewActions_IncludesDelegationTimeline', () => {
      const viewComposite = findComposite('exarchos_view');
      expect(viewComposite).toBeDefined();
      const actionNames = viewComposite!.actions.map((a) => a.name);
      expect(actionNames).toContain('delegation_timeline');
    });

    it('ViewActions_IncludesCodeQuality', () => {
      const viewComposite = findComposite('exarchos_view');
      expect(viewComposite).toBeDefined();
      const actionNames = viewComposite!.actions.map((a) => a.name);
      expect(actionNames).toContain('code_quality');

      // Verify schema shape
      const action = findAction('exarchos_view', 'code_quality');
      expect(action).toBeDefined();
      const result = action!.schema.safeParse({
        workflowId: 'test-wf',
        skill: 'delegation',
        gate: 'typecheck',
        limit: 10,
      });
      expect(result.success).toBe(true);
    });
  });

  describe('schema validation', () => {
    it('should accept valid workflow init input', () => {
      const action = findAction('exarchos_workflow', 'init');
      expect(action).toBeDefined();

      const schema = action!.schema.extend({ action: z.literal('init') });
      const result = schema.safeParse({
        action: 'init',
        featureId: 'my-feature',
        workflowType: 'feature',
      });
      expect(result.success).toBe(true);
    });

    it('should reject invalid featureId format for workflow init', () => {
      const action = findAction('exarchos_workflow', 'init');
      expect(action).toBeDefined();

      const result = action!.schema.safeParse({
        featureId: 'INVALID_ID',
        workflowType: 'feature',
      });
      expect(result.success).toBe(false);
    });

    it('should accept valid event append input', () => {
      const action = findAction('exarchos_event', 'append');
      expect(action).toBeDefined();

      const result = action!.schema.safeParse({
        stream: 'workflow-123',
        event: { type: 'task.assigned', data: {} },
      });
      expect(result.success).toBe(true);
    });

    it('should accept valid task_claim input', () => {
      const action = findAction('exarchos_orchestrate', 'task_claim');
      expect(action).toBeDefined();

      const result = action!.schema.safeParse({
        taskId: 'task-1',
        agentId: 'agent-1',
        streamId: 'workflow-123',
      });
      expect(result.success).toBe(true);
    });

    it('should accept valid view pipeline input', () => {
      const action = findAction('exarchos_view', 'pipeline');
      expect(action).toBeDefined();

      const result = action!.schema.safeParse({ limit: 10, offset: 0 });
      expect(result.success).toBe(true);
    });

    it('should coerce string filter and limit in event query schema', () => {
      const action = findAction('exarchos_event', 'query');
      expect(action).toBeDefined();

      const result = action!.schema.safeParse({
        stream: 'wf-123',
        filter: '{"type":"workflow.transition"}',
        limit: '5',
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.filter).toEqual({ type: 'workflow.transition' });
        expect(result.data.limit).toBe(5);
      }
    });

    it('should coerce string updates in workflow set schema', () => {
      const action = findAction('exarchos_workflow', 'set');
      expect(action).toBeDefined();

      const result = action!.schema.safeParse({
        featureId: 'test-feature',
        updates: '{"phase":"completed"}',
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.updates).toEqual({ phase: 'completed' });
      }
    });

    it('should accept empty input for sync now', () => {
      const action = findAction('exarchos_sync', 'now');
      expect(action).toBeDefined();

      const result = action!.schema.safeParse({});
      expect(result.success).toBe(true);
    });
  });
});

// ─── CLI Hints Tests ──────────────────────────────────────────────────────────

describe('CLI hints', () => {
  it('ToolAction_AcceptsCliHints_TypeChecks', () => {
    // Arrange: create a ToolAction with cli hints
    const action: ToolAction = {
      name: 'test',
      description: 'test action',
      schema: z.object({ id: z.string() }),
      phases: new Set(['ideate']),
      roles: new Set(['any']),
      cli: {
        alias: 'ls',
        group: 'Inspection',
        examples: ['exarchos test ls'],
        flags: { id: { alias: 'i', description: 'The ID' } },
        format: 'table',
      },
    };
    // Assert: cli fields are accessible
    expect(action.cli?.alias).toBe('ls');
    expect(action.cli?.flags?.id?.alias).toBe('i');
    expect(action.cli?.format).toBe('table');
  });

  it('CompositeTool_AcceptsCliHints_TypeChecks', () => {
    // Arrange: create a CompositeTool with cli hints
    const tool: CompositeTool = {
      name: 'exarchos_test',
      description: 'test tool',
      actions: [],
      cli: { alias: 'tst', group: 'Testing' },
    };
    // Assert
    expect(tool.cli?.alias).toBe('tst');
  });

  it('ToolAction_WithoutCliHints_StillWorks', () => {
    // Arrange: ToolAction without cli field (backward compat)
    const action: ToolAction = {
      name: 'test',
      description: 'test',
      schema: z.object({}),
      phases: new Set([]),
      roles: new Set([]),
    };
    // Assert: cli is undefined
    expect(action.cli).toBeUndefined();
  });

  it('TOOL_REGISTRY_EntriesStillTypeCheck', () => {
    // Assert: existing registry is valid (no cli field = still works)
    expect(TOOL_REGISTRY.length).toBeGreaterThan(0);
    for (const tool of TOOL_REGISTRY) {
      expect(tool.name).toBeTruthy();
      expect(tool.actions.length).toBeGreaterThan(0);
    }
  });
});
