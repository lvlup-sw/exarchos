import { describe, it, expect, afterEach } from 'vitest';
import { z } from 'zod';
import {
  buildCompositeSchema,
  buildRegistrationSchema,
  buildToolDescription,
  coercedRecord,
  coercedPositiveInt,
  coercedNonnegativeInt,
  coercedStringArray,
  TOOL_REGISTRY,
  registerCustomTool,
  unregisterCustomTool,
  getFullRegistry,
  clearCustomTools,
  findActionInRegistry,
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

  // ─── Collision-detection guard (regression for #1127) ─────────────────────

  it('should throw when two actions declare the same field with incompatible enums', () => {
    const colliding: readonly ToolAction[] = [
      {
        name: 'first',
        description: 'First action',
        schema: z.object({ format: z.enum(['full', 'prompt-only']).default('full') }),
        phases: new Set(['ideate']),
        roles: new Set(['any']),
      },
      {
        name: 'second',
        description: 'Second action',
        schema: z.object({ format: z.enum(['table', 'json']).optional() }),
        phases: new Set(['ideate']),
        roles: new Set(['any']),
      },
    ];

    expect(() => buildRegistrationSchema(colliding)).toThrow(/collides/);
    expect(() => buildRegistrationSchema(colliding)).toThrow(/first|second/);
  });

  it('should throw when two actions declare the same field with incompatible base types', () => {
    const colliding: readonly ToolAction[] = [
      {
        name: 'a',
        description: 'A',
        schema: z.object({ limit: z.number().int() }),
        phases: new Set(['ideate']),
        roles: new Set(['any']),
      },
      {
        name: 'b',
        description: 'B',
        schema: z.object({ limit: z.string() }),
        phases: new Set(['ideate']),
        roles: new Set(['any']),
      },
    ];

    expect(() => buildRegistrationSchema(colliding)).toThrow(/collides/);
  });

  it('should throw when two actions share a field whose defaults differ', () => {
    // Guards the "defaults diverge" arm of describeContractConflict: same
    // base type (string), no enum, but mismatched defaults would otherwise
    // let the first declaration silently shadow the second at the
    // registration boundary.
    const colliding: readonly ToolAction[] = [
      {
        name: 'first',
        description: 'First action',
        schema: z.object({ mode: z.string().default('full') }),
        phases: new Set(['ideate']),
        roles: new Set(['any']),
      },
      {
        name: 'second',
        description: 'Second action',
        schema: z.object({ mode: z.string().default('json') }),
        phases: new Set(['ideate']),
        roles: new Set(['any']),
      },
    ];

    expect(() => buildRegistrationSchema(colliding)).toThrow(/collides/);
    expect(() => buildRegistrationSchema(colliding)).toThrow(/Default values differ/);
  });

  it('should throw when two actions share a literal-valued field with different values', () => {
    // Regression: before this fix, z.literal was classified as 'other' and
    // defaults=none on both sides silently passed — two actions could bind
    // the same field to incompatible literal values without detection.
    const colliding: readonly ToolAction[] = [
      {
        name: 'first',
        description: 'First',
        schema: z.object({ tag: z.literal('alpha') }),
        phases: new Set(['ideate']),
        roles: new Set(['any']),
      },
      {
        name: 'second',
        description: 'Second',
        schema: z.object({ tag: z.literal('beta') }),
        phases: new Set(['ideate']),
        roles: new Set(['any']),
      },
    ];

    expect(() => buildRegistrationSchema(colliding)).toThrow(/collides/);
  });

  it('should throw when a union-of-literals field diverges across actions', () => {
    // Union-of-literals is the hand-rolled form of z.enum(). Same contract
    // semantics must apply: mismatched value sets must collide.
    const colliding: readonly ToolAction[] = [
      {
        name: 'first',
        description: 'First',
        schema: z.object({
          mode: z.union([z.literal('a'), z.literal('b')]),
        }),
        phases: new Set(['ideate']),
        roles: new Set(['any']),
      },
      {
        name: 'second',
        description: 'Second',
        schema: z.object({
          mode: z.union([z.literal('a'), z.literal('c')]),
        }),
        phases: new Set(['ideate']),
        roles: new Set(['any']),
      },
    ];

    expect(() => buildRegistrationSchema(colliding)).toThrow(/collides/);
  });

  it('should allow two actions to share a field when their schemas are structurally identical', () => {
    const compatible: readonly ToolAction[] = [
      {
        name: 'create_pr',
        description: 'Create',
        schema: z.object({ prId: z.string().min(1) }),
        phases: new Set(['ideate']),
        roles: new Set(['any']),
      },
      {
        name: 'merge_pr',
        description: 'Merge',
        schema: z.object({ prId: z.string().min(1) }),
        phases: new Set(['ideate']),
        roles: new Set(['any']),
      },
    ];

    expect(() => buildRegistrationSchema(compatible)).not.toThrow();
  });

  it('should not collide on format across the real orchestrate registry (#1127 regression)', () => {
    const orchestrate = TOOL_REGISTRY.find((t) => t.name === 'exarchos_orchestrate')!;
    expect(() => buildRegistrationSchema(orchestrate.actions)).not.toThrow();
  });

  it('should accept doctor format values against the real orchestrate registration schema', () => {
    const orchestrate = TOOL_REGISTRY.find((t) => t.name === 'exarchos_orchestrate')!;
    const schema = buildRegistrationSchema(orchestrate.actions);

    // Regression for #1127: before the fix, agent_spec.format (full|prompt-only)
    // shadowed doctor/init.format (table|json), making these payloads fail
    // validation at the registered-tool boundary.
    expect(schema.safeParse({ action: 'doctor' }).success).toBe(true);
    expect(schema.safeParse({ action: 'doctor', format: 'json' }).success).toBe(true);
    expect(schema.safeParse({ action: 'doctor', format: 'table' }).success).toBe(true);
    expect(schema.safeParse({ action: 'init', nonInteractive: true }).success).toBe(true);
    expect(schema.safeParse({ action: 'init', format: 'json' }).success).toBe(true);
  });

  it('should expose agent_spec outputFormat on the real orchestrate registration schema', () => {
    const orchestrate = TOOL_REGISTRY.find((t) => t.name === 'exarchos_orchestrate')!;
    const schema = buildRegistrationSchema(orchestrate.actions);

    expect(
      schema.safeParse({
        action: 'agent_spec',
        agent: 'implementer',
        outputFormat: 'full',
      }).success,
    ).toBe(true);
    expect(
      schema.safeParse({
        action: 'agent_spec',
        agent: 'implementer',
        outputFormat: 'prompt-only',
      }).success,
    ).toBe(true);
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

describe('coercedStringArray', () => {
  const schema = coercedStringArray();

  it('should accept a native array', () => {
    const result = schema.safeParse(['a', 'b']);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data).toEqual(['a', 'b']);
  });

  it('should coerce a JSON-stringified array', () => {
    const result = schema.safeParse('["phase","featureId"]');
    expect(result.success).toBe(true);
    if (result.success) expect(result.data).toEqual(['phase', 'featureId']);
  });

  it('should reject a non-array string', () => {
    const result = schema.safeParse('not-json');
    expect(result.success).toBe(false);
  });

  it('should reject a stringified object', () => {
    const result = schema.safeParse('{"a":1}');
    expect(result.success).toBe(false);
  });

  it('should accept an empty array', () => {
    const result = schema.safeParse([]);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data).toEqual([]);
  });

  it('should coerce a stringified empty array', () => {
    const result = schema.safeParse('[]');
    expect(result.success).toBe(true);
    if (result.success) expect(result.data).toEqual([]);
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
    it('should have 8 actions: init, get, set, cancel, cleanup, reconcile, checkpoint, describe', () => {
      const composite = findComposite('exarchos_workflow');
      expect(composite).toBeDefined();
      const actionNames = composite!.actions.map((a) => a.name);
      expect(actionNames).toEqual(['init', 'get', 'set', 'cancel', 'cleanup', 'reconcile', 'checkpoint', 'describe']);
    });
  });

  describe('exarchos_orchestrate', () => {
    it('should have 64 actions for task management, review triage, gate checks, validation handlers, runbooks, agent spec, oneshot/pruning, doctor, init, VCS, classify_review_items (#1159), and composite actions', () => {
      const composite = findComposite('exarchos_orchestrate');
      expect(composite).toBeDefined();
      expect(composite!.actions).toHaveLength(64);

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
          'extract_task',
          'review_diff',
          'verify_worktree',
          'select_debug_track',
          'investigation_timer',
          'check_coverage_thresholds',
          'assess_refactor_scope',
          'check_pr_comments',
          'validate_pr_body',
          'validate_pr_stack',
          'debug_review_gate',
          'extract_fix_tasks',
          'generate_traceability',
          'spec_coverage_check',
          'verify_worktree_baseline',
          'setup_worktree',
          'verify_delegation_saga',
          'post_delegation_check',
          'reconcile_state',
          'pre_synthesis_check',
          'new_project',
          'check_coderabbit',
          'check_polish_scope',
          'needs_schema_sync',
          'verify_doc_links',
          'verify_review_triage',
          'prepare_review',
          'prune_stale_workflows',
          'request_synthesize',
          'finalize_oneshot',
          'create_pr',
          'merge_pr',
          'check_ci',
          'list_prs',
          'get_pr_comments',
          'add_pr_comment',
          'create_issue',
          'init',
        ]),
      );
    });
  });

  it('OrchestrateActions_MatchCompositeHandlers_InSync', async () => {
    const composite = findComposite('exarchos_orchestrate');
    expect(composite).toBeDefined();
    const registryNames = new Set(composite!.actions.map((a) => a.name));

    const { ACTION_HANDLER_KEYS } = await import('./orchestrate/composite.js');

    // Actions that are handled specially in the composite router (not via ACTION_HANDLERS)
    const SPECIAL_ACTIONS = new Set(['describe', 'runbook', 'doctor', 'init']);

    for (const handlerKey of ACTION_HANDLER_KEYS) {
      expect(
        registryNames.has(handlerKey),
        `Handler '${handlerKey}' in composite.ts is missing from registry.ts orchestrateActions`,
      ).toBe(true);
    }
    for (const registryName of registryNames) {
      if (SPECIAL_ACTIONS.has(registryName)) continue;
      expect(
        ACTION_HANDLER_KEYS.includes(registryName),
        `Registry action '${registryName}' has no handler in composite.ts`,
      ).toBe(true);
    }
  });

  it('should have non-empty phases for every action except init', () => {
    // init has empty phases by design — it relies on the guard's null-check
    // (no active workflow) rather than phase matching.
    const EMPTY_PHASE_ACTIONS = new Set([
      'exarchos_workflow.init',
    ]);

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

// ─── Task 23: CLI Hints on Core Actions ──────────────────────────────────────

describe('CLI hints on core workflow actions', () => {
  it('WorkflowTool_HasCliAlias', () => {
    const tool = TOOL_REGISTRY.find((t) => t.name === 'exarchos_workflow');
    expect(tool).toBeDefined();
    expect(tool!.cli?.alias).toBe('wf');
  });

  it('InitAction_HasFlagAliases', () => {
    const action = findAction('exarchos_workflow', 'init');
    expect(action).toBeDefined();
    expect(action!.cli?.flags?.featureId?.alias).toBe('f');
    expect(action!.cli?.flags?.workflowType?.alias).toBe('t');
  });

  it('GetAction_HasStatusAlias', () => {
    const action = findAction('exarchos_workflow', 'get');
    expect(action).toBeDefined();
    expect(action!.cli?.alias).toBe('status');
    expect(action!.cli?.flags?.featureId?.alias).toBe('f');
    expect(action!.cli?.flags?.query?.alias).toBe('q');
  });

  it('SetAction_HasFlagAliases', () => {
    const action = findAction('exarchos_workflow', 'set');
    expect(action).toBeDefined();
    expect(action!.cli?.flags?.featureId?.alias).toBe('f');
  });

  it('ViewTool_HasCliAlias', () => {
    const tool = TOOL_REGISTRY.find((t) => t.name === 'exarchos_view');
    expect(tool).toBeDefined();
    expect(tool!.cli?.alias).toBe('vw');
  });

  it('PipelineAction_HasLsAlias', () => {
    const action = findAction('exarchos_view', 'pipeline');
    expect(action).toBeDefined();
    expect(action!.cli?.alias).toBe('ls');
  });

  it('TasksAction_HasFlagAliases', () => {
    const action = findAction('exarchos_view', 'tasks');
    expect(action).toBeDefined();
    expect(action!.cli?.flags?.workflowId?.alias).toBe('w');
    expect(action!.cli?.flags?.limit?.alias).toBe('l');
  });

  it('EventTool_HasCliAlias', () => {
    const tool = TOOL_REGISTRY.find((t) => t.name === 'exarchos_event');
    expect(tool).toBeDefined();
    expect(tool!.cli?.alias).toBe('ev');
  });

  it('OrchestrateTool_HasCliAlias', () => {
    const tool = TOOL_REGISTRY.find((t) => t.name === 'exarchos_orchestrate');
    expect(tool).toBeDefined();
    expect(tool!.cli?.alias).toBe('orch');
  });

  it('SyncTool_HasCliAlias', () => {
    const tool = TOOL_REGISTRY.find((t) => t.name === 'exarchos_sync');
    expect(tool).toBeDefined();
    expect(tool!.cli?.alias).toBe('sy');
  });
});

// ─── Task 24: CLI Examples on Common Actions ─────────────────────────────────

describe('CLI examples on common actions', () => {
  it('CliHints_ExamplesPresent_ForCommonActions', () => {
    const initAction = findAction('exarchos_workflow', 'init');
    expect(initAction!.cli?.examples).toBeDefined();
    expect(initAction!.cli!.examples!.length).toBeGreaterThan(0);

    const getAction = findAction('exarchos_workflow', 'get');
    expect(getAction!.cli?.examples).toBeDefined();
    expect(getAction!.cli!.examples!.length).toBeGreaterThan(0);

    const setAction = findAction('exarchos_workflow', 'set');
    expect(setAction!.cli?.examples).toBeDefined();
    expect(setAction!.cli!.examples!.length).toBeGreaterThan(0);

    const pipelineAction = findAction('exarchos_view', 'pipeline');
    expect(pipelineAction!.cli?.examples).toBeDefined();
    expect(pipelineAction!.cli!.examples!.length).toBeGreaterThan(0);

    const tasksAction = findAction('exarchos_view', 'tasks');
    expect(tasksAction!.cli?.examples).toBeDefined();
    expect(tasksAction!.cli!.examples!.length).toBeGreaterThan(0);

    const appendAction = findAction('exarchos_event', 'append');
    expect(appendAction!.cli?.examples).toBeDefined();
    expect(appendAction!.cli!.examples!.length).toBeGreaterThan(0);
  });

  it('InitAction_ExamplesContainExpectedContent', () => {
    const action = findAction('exarchos_workflow', 'init');
    expect(action!.cli!.examples).toContain('exarchos wf init -f my-feature -t feature');
  });

  it('GetAction_ExamplesContainExpectedContent', () => {
    const action = findAction('exarchos_workflow', 'get');
    expect(action!.cli!.examples).toContain('exarchos wf status -f my-feature');
    expect(action!.cli!.examples).toContain('exarchos wf status -f my-feature -q phase');
  });

  it('PipelineAction_ExamplesContainExpectedContent', () => {
    const action = findAction('exarchos_view', 'pipeline');
    expect(action!.cli!.examples).toContain('exarchos vw ls');
  });
});

// ─── Dynamic Tool Registration Tests ─────────────────────────────────────────

describe('Dynamic Tool Registration', () => {
  const customTool: CompositeTool = {
    name: 'exarchos_deploy',
    description: 'Custom deployment tool',
    actions: [
      {
        name: 'trigger',
        description: 'Trigger a deployment',
        schema: z.object({ target: z.string() }),
        phases: new Set(['deploy']),
        roles: new Set(['lead']),
      },
      {
        name: 'status',
        description: 'Get deployment status',
        schema: z.object({ deployId: z.string().optional() }),
        phases: new Set(['deploy']),
        roles: new Set(['any']),
      },
    ],
  };

  afterEach(() => {
    clearCustomTools();
  });

  it('RegisterCustomTool_AddsToRegistry', () => {
    registerCustomTool(customTool);

    const full = getFullRegistry();
    const found = full.find((t) => t.name === 'exarchos_deploy');
    expect(found).toBeDefined();
    expect(found!.description).toBe('Custom deployment tool');
    expect(found!.actions).toHaveLength(2);
  });

  it('RegisterCustomTool_BuiltInName_Throws', () => {
    const builtInNames = [
      'exarchos_workflow',
      'exarchos_event',
      'exarchos_orchestrate',
      'exarchos_view',
      'exarchos_sync',
    ];

    for (const name of builtInNames) {
      const badTool: CompositeTool = {
        name,
        description: 'trying to override',
        actions: [
          {
            name: 'a',
            description: 'a',
            schema: z.object({}),
            phases: new Set(['ideate']),
            roles: new Set(['any']),
          },
          {
            name: 'b',
            description: 'b',
            schema: z.object({}),
            phases: new Set(['ideate']),
            roles: new Set(['any']),
          },
        ],
      };
      expect(
        () => registerCustomTool(badTool),
        `Should throw for built-in tool name: ${name}`,
      ).toThrow(/built-in/i);
    }
  });

  it('GetFullRegistry_ReturnsBuiltInPlusCustom', () => {
    // Before registration
    expect(getFullRegistry()).toHaveLength(TOOL_REGISTRY.length);

    // After registration
    registerCustomTool(customTool);
    expect(getFullRegistry()).toHaveLength(TOOL_REGISTRY.length + 1);

    // Built-ins are still there
    const names = getFullRegistry().map((t) => t.name);
    expect(names).toContain('exarchos_workflow');
    expect(names).toContain('exarchos_deploy');
  });

  it('RegisterCustomTool_GeneratesValidSchema', () => {
    registerCustomTool(customTool);

    const full = getFullRegistry();
    const tool = full.find((t) => t.name === 'exarchos_deploy')!;
    const schema = buildRegistrationSchema(tool.actions);

    // Should accept valid input
    const result = schema.safeParse({ action: 'trigger', target: 'production' });
    expect(result.success).toBe(true);

    // Should reject invalid action
    const invalid = schema.safeParse({ action: 'nonexistent' });
    expect(invalid.success).toBe(false);
  });

  it('UnregisterCustomTool_RemovesTool', () => {
    registerCustomTool(customTool);
    expect(getFullRegistry().find((t) => t.name === 'exarchos_deploy')).toBeDefined();

    unregisterCustomTool('exarchos_deploy');
    expect(getFullRegistry().find((t) => t.name === 'exarchos_deploy')).toBeUndefined();
  });

  it('UnregisterCustomTool_BuiltInName_Throws', () => {
    expect(
      () => unregisterCustomTool('exarchos_workflow'),
    ).toThrow(/built-in|cannot unregister/i);
  });

  it('UnregisterCustomTool_UnknownName_Throws', () => {
    expect(
      () => unregisterCustomTool('exarchos_nonexistent'),
    ).toThrow(/not registered|not found/i);
  });

  it('RegisterCustomTool_DuplicateName_Throws', () => {
    registerCustomTool(customTool);
    expect(
      () => registerCustomTool(customTool),
    ).toThrow(/already registered/i);
  });
});

// ─── Gate Metadata Tests ──────────────────────────────────────────────────────

describe('Gate Metadata', () => {
  it('GateMetadata_CheckActions_HaveGateField', () => {
    // check_event_emissions is intentionally excluded — it's an advisory hint action
    // that returns missing event suggestions, not a gate with blocking/dimension metadata.
    const expectedCheckActions = new Set([
      'check_tdd_compliance', 'check_static_analysis', 'check_security_scan',
      'check_context_economy', 'check_operational_resilience', 'check_workflow_determinism',
      'check_review_verdict', 'check_convergence', 'check_provenance_chain',
      'check_design_completeness', 'check_plan_coverage', 'check_task_decomposition',
      'check_post_merge',
    ]);
    const visited = new Set<string>();

    for (const composite of TOOL_REGISTRY) {
      for (const action of composite.actions) {
        if (expectedCheckActions.has(action.name)) {
          visited.add(action.name);
          expect(action.gate, `${action.name} should have gate metadata`).toBeDefined();
          expect(typeof action.gate!.blocking).toBe('boolean');
        }
      }
    }

    // Ensure every expected check action was actually found in the registry
    for (const expected of expectedCheckActions) {
      expect(
        visited.has(expected),
        `Expected check action '${expected}' was not found in TOOL_REGISTRY`,
      ).toBe(true);
    }
  });
});

// ─── Slim Description Tests ───────────────────────────────────────────────────

describe('Slim Description', () => {
  it('SlimDescription_AllVisibleTools_HaveSlimDescription', () => {
    for (const tool of TOOL_REGISTRY) {
      if (tool.hidden) continue;
      expect(tool.slimDescription, `${tool.name} should have slimDescription`).toBeDefined();
      expect(tool.slimDescription!.length).toBeGreaterThan(0);
      expect(tool.slimDescription!).toContain('describe');  // Must mention describe action
    }
  });
});

// ─── Dual Mode buildToolDescription Tests ─────────────────────────────────────

describe('buildToolDescription dual mode', () => {
  it('BuildToolDescription_SlimMode_ReturnsSlimDescription', () => {
    const tool = TOOL_REGISTRY.find(t => t.name === 'exarchos_workflow')!;
    const desc = buildToolDescription(tool, true);
    expect(desc).toBe(tool.slimDescription);
  });

  it('BuildToolDescription_FullMode_ReturnsFullDescription', () => {
    const tool = TOOL_REGISTRY.find(t => t.name === 'exarchos_workflow')!;
    const full = buildToolDescription(tool, false);
    expect(full).toContain('Actions:');
    expect(full).toContain('- init(');
  });

  it('BuildToolDescription_DefaultMode_ReturnsFullDescription', () => {
    const tool = TOOL_REGISTRY.find(t => t.name === 'exarchos_workflow')!;
    const desc = buildToolDescription(tool);
    expect(desc).toContain('Actions:');
    expect(desc).toContain('- init(');
  });
});

// ─── findActionInRegistry Tests ──────────────────────────────────────────────

describe('findActionInRegistry', () => {
  it('FindActionInRegistry_ValidAction_ReturnsAction', () => {
    const action = findActionInRegistry('exarchos_workflow', 'init');
    expect(action).toBeDefined();
    expect(action!.name).toBe('init');
  });

  it('FindActionInRegistry_InvalidAction_ReturnsUndefined', () => {
    expect(findActionInRegistry('exarchos_workflow', 'nonexistent')).toBeUndefined();
  });

  it('FindActionInRegistry_InvalidTool_ReturnsUndefined', () => {
    expect(findActionInRegistry('nonexistent_tool', 'init')).toBeUndefined();
  });
});

// ─── Runbook Action Registry Tests ──────────────────────────────────────────

describe('Runbook action in registry', () => {
  it('RunbookAction_ExistsInOrchestrateRegistry', () => {
    const orchTool = findComposite('exarchos_orchestrate');
    expect(orchTool).toBeDefined();
    const runbookAction = orchTool!.actions.find(a => a.name === 'runbook');
    expect(runbookAction, 'exarchos_orchestrate should have a runbook action').toBeDefined();
    expect(runbookAction!.description).toBeTruthy();
    // Should accept both empty and parameterized input
    expect(runbookAction!.schema.safeParse({}).success).toBe(true);
    expect(runbookAction!.schema.safeParse({ phase: 'delegate' }).success).toBe(true);
    expect(runbookAction!.schema.safeParse({ id: 'task-completion' }).success).toBe(true);
  });
});

// ─── Describe Action Registry Tests ──────────────────────────────────────────

describe('Describe action in registry', () => {
  it('DescribeAction_AllVisibleTools_HaveDescribeAction', () => {
    for (const tool of TOOL_REGISTRY) {
      if (tool.hidden) continue;
      const describeAction = tool.actions.find(a => a.name === 'describe');
      expect(describeAction, `${tool.name} should have a describe action`).toBeDefined();
    }
  });
});

// ─── Quality Hints View Action Tests ─────────────────────────────────────────

describe('quality_hints view action', () => {
  it('ViewActions_IncludesQualityHintsAction', () => {
    const viewTool = TOOL_REGISTRY.find((t) => t.name === 'exarchos_view');
    expect(viewTool).toBeDefined();
    const qualityHints = viewTool!.actions.find((a) => a.name === 'quality_hints');
    expect(qualityHints).toBeDefined();
    expect(qualityHints!.name).toBe('quality_hints');
  });

  it('QualityHints_SchemaAcceptsWorkflowIdAndSkill', () => {
    const action = findActionInRegistry('exarchos_view', 'quality_hints');
    expect(action).toBeDefined();

    // workflowId only
    const result1 = action!.schema.safeParse({ workflowId: 'test-feature' });
    expect(result1.success).toBe(true);

    // workflowId + skill
    const result2 = action!.schema.safeParse({
      workflowId: 'test-feature',
      skill: 'refactor',
    });
    expect(result2.success).toBe(true);

    // empty object (both optional)
    const result3 = action!.schema.safeParse({});
    expect(result3.success).toBe(true);
  });
});

// ─── AutoEmits Drift Tests ──────────────────────────────────────────────────

describe('AutoEmits Drift Tests', () => {
  it('RegistryDrift_AutoEmitsMatchEventEmissionRegistry', async () => {
    const { EVENT_EMISSION_REGISTRY } = await import('./event-store/schemas.js');

    // At least one action must have autoEmits populated
    let anyPopulated = false;
    const violations: string[] = [];

    for (const tool of TOOL_REGISTRY) {
      for (const action of tool.actions) {
        if (!action.autoEmits || action.autoEmits.length === 0) continue;
        anyPopulated = true;

        for (const emission of action.autoEmits) {
          const source = (EVENT_EMISSION_REGISTRY as Record<string, string>)[emission.event];
          if (!source) {
            violations.push(
              `${tool.name}.${action.name}: autoEmits '${emission.event}' not found in EVENT_EMISSION_REGISTRY`,
            );
          } else if (source !== 'auto') {
            violations.push(
              `${tool.name}.${action.name}: autoEmits '${emission.event}' has source '${source}', expected 'auto'`,
            );
          }
        }
      }
    }

    expect(anyPopulated, 'At least one action must have autoEmits populated').toBe(true);
    expect(violations, `AutoEmits drift:\n${violations.join('\n')}`).toEqual([]);
  });

  it('RegistryDrift_DescriptionEmitsImpliesAutoEmitsField', () => {
    const emitsPatterns = [/Auto-emits/i, /Emits gate\.executed/i, /Emits task\./i];
    const violations: string[] = [];

    for (const tool of TOOL_REGISTRY) {
      for (const action of tool.actions) {
        const matchesPattern = emitsPatterns.some((p) => p.test(action.description));
        if (matchesPattern) {
          if (!action.autoEmits || action.autoEmits.length === 0) {
            violations.push(
              `${tool.name}.${action.name}: description mentions emissions but autoEmits is empty/undefined. Description: "${action.description}"`,
            );
          }
        }
      }
    }

    expect(violations, `Description/autoEmits drift:\n${violations.join('\n')}`).toEqual([]);
  });
});

// ─── Plugin Integration: prepare_review & pluginFindings (DR-1, DR-3) ────────

describe('Plugin Integration Registry Wiring', () => {
  it('RegistryActions_PrepareReview_Registered', () => {
    const orchTool = findComposite('exarchos_orchestrate');
    expect(orchTool).toBeDefined();
    const prepareReview = orchTool!.actions.find((a) => a.name === 'prepare_review');
    expect(prepareReview, 'exarchos_orchestrate should have a prepare_review action').toBeDefined();
    expect(prepareReview!.description).toBeTruthy();
    // Should accept valid input
    expect(prepareReview!.schema.safeParse({ featureId: 'test-feature' }).success).toBe(true);
    // Should accept optional fields
    expect(prepareReview!.schema.safeParse({
      featureId: 'test-feature',
      scope: 'full',
      dimensions: ['error-handling'],
    }).success).toBe(true);
    // Should include review phases
    expect(prepareReview!.phases.has('review')).toBe(true);
    expect(prepareReview!.phases.has('overhaul-review')).toBe(true);
    expect(prepareReview!.phases.has('debug-review')).toBe(true);
    // Should be lead-only
    expect(prepareReview!.roles.has('lead')).toBe(true);
  });

  it('RegistryActions_ClassifyReviewItems_IncludesSynthesizePhase', () => {
    // Regression: shepherd invokes classify_review_items during synthesize.
    // If this action is restricted to REVIEW_PHASES only, the runtime
    // phase-guard rejects the call and breaks the shepherd loop (#1161).
    const action = findAction('exarchos_orchestrate', 'classify_review_items');
    expect(action).toBeDefined();
    expect(action!.phases.has('synthesize')).toBe(true);
    expect(action!.phases.has('review')).toBe(true);
    expect(action!.phases.has('overhaul-review')).toBe(true);
    expect(action!.phases.has('debug-review')).toBe(true);
  });

  it('RegistryActions_CheckReviewVerdict_HasPluginFindingsInSchema', () => {
    const action = findAction('exarchos_orchestrate', 'check_review_verdict');
    expect(action).toBeDefined();

    // Verify the schema shape includes pluginFindings by checking parsed output
    const result = action!.schema.safeParse({
      featureId: 'test-feature',
      high: 0,
      medium: 1,
      low: 2,
      pluginFindings: [
        {
          source: 'axiom',
          severity: 'MEDIUM',
          dimension: 'error-handling',
          file: 'src/foo.ts',
          line: 42,
          message: 'Missing error boundary',
        },
      ],
    });
    expect(result.success).toBe(true);
    // Crucially: the parsed data must RETAIN pluginFindings (not strip it)
    if (result.success) {
      const data = result.data as Record<string, unknown>;
      expect(data.pluginFindings).toBeDefined();
      expect(Array.isArray(data.pluginFindings)).toBe(true);
      const findings = data.pluginFindings as Array<Record<string, unknown>>;
      expect(findings).toHaveLength(1);
      expect(findings[0].source).toBe('axiom');
      expect(findings[0].severity).toBe('MEDIUM');
    }

    // Should also accept without pluginFindings (optional)
    const resultWithout = action!.schema.safeParse({
      featureId: 'test-feature',
      high: 0,
      medium: 0,
      low: 0,
    });
    expect(resultWithout.success).toBe(true);
  });

  it('RegistryActions_RequestSynthesize_AllowsPlanAndImplementingPhases', () => {
    // request_synthesize must be callable from both `plan` and `implementing`
    // phases. The synthesisOptedIn guard only fires at the implementing →
    // choice-state boundary, so appending the event earlier (during planning)
    // is idempotent — the event sits in the stream until finalize_oneshot
    // reads it. Restricting to `implementing` only broke the "I know I'll
    // want a PR" signal during planning.
    const action = findAction('exarchos_orchestrate', 'request_synthesize');
    expect(action, 'exarchos_orchestrate should have a request_synthesize action').toBeDefined();
    expect(action!.phases.has('plan')).toBe(true);
    expect(action!.phases.has('implementing')).toBe(true);
  });
});

// RED for debug-delegation-gate Issue B: the check_tdd_compliance schema
// silently accepted unknown keys (e.g. `base` instead of `baseBranch`),
// causing `baseBranch` to default to `main` without warning. The schema
// must be `.strict()` so the dispatch layer rejects unknown keys with a
// clear validation error.
describe('check_tdd_compliance schema strictness', () => {
  const findAction = (toolName: string, actionName: string) => {
    const tool = TOOL_REGISTRY.find((t) => t.name === toolName);
    return tool?.actions.find((a) => a.name === actionName);
  };

  it('TddComplianceSchema_KnownKeys_Parses', () => {
    const action = findAction('exarchos_orchestrate', 'check_tdd_compliance');
    expect(action).toBeDefined();
    const result = action!.schema.safeParse({
      featureId: 'demo',
      taskId: '001',
      branch: 'feature/demo',
      baseBranch: 'main',
    });
    expect(result.success).toBe(true);
  });

  it('TddComplianceSchema_UnknownKey_Rejects', () => {
    const action = findAction('exarchos_orchestrate', 'check_tdd_compliance');
    expect(action).toBeDefined();
    // Passing `base` (the common mistake) instead of `baseBranch` must fail,
    // not silently strip.
    const result = action!.schema.safeParse({
      featureId: 'demo',
      taskId: '001',
      branch: 'feature/demo',
      base: 'feature/integration',
    });
    expect(result.success).toBe(false);
  });
});
