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
  ActionAnnotationsSchema,
  validateAnnotations,
  validateAction,
  WorkflowSetOutputSchema,
  WorkflowTransitionOutputSchema,
  WorkflowUpdateOutputSchema,
  resolveEconomyBudget,
  DEFAULT_ECONOMY_BUDGET_TOKENS,
  DESCRIBE_ECONOMY_BUDGET_TOKENS,
  EVENT_DESCRIBE_ECONOMY_BUDGET_TOKENS,
  RUNBOOK_ECONOMY_BUDGET_TOKENS,
} from '../../src/registry.js';
import type { ToolAction, CompositeTool, ActionAnnotations } from '../../src/registry.js';
import {
  ActionContractError,
  contractEmissionsOf,
  none,
  normalizeActionContract,
  type ActionContract,
} from '../../src/registry/action-contract.js';
import {
  makeDescribeAction,
  makeEventDescribeAction,
  makeWorkflowDescribeAction,
} from '../../src/registry/describe-actions.js';
import { envelopeDataSchemaIsTyped } from '../../src/verbs/worktree/schemas.js';
import { handleDescribe } from '../../src/describe/handler.js';
import { wrap, wrapError } from '../../src/format.js';
import { zodToJsonSchema } from '../../src/utils/json-schema.js';
import { ConcurrencyError } from '../../src/events/concurrency-error.js';
import { rmrfAsync } from '../../tools/test-helpers/temp-dir.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { LAUNCHER_VERB_CONFORMANCE } from '../../src/runtime/launcher/verb.js';
import { TIER1_HARNESSES } from '../../src/runtime/launcher/harness-registry.js';
import { validateAutoEmission } from '../../src/registry/gate-metadata.js';
import type { AutoEmission } from '../../src/registry/gate-metadata.js';

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

    const initResult = schema.safeParse({ action: 'init', featureId: 'test' });
    expect(initResult.success).toBe(true);

    const getResult = schema.safeParse({ action: 'get', query: 'phase' });
    expect(getResult.success).toBe(true);

    const getNoQueryResult = schema.safeParse({ action: 'get' });
    expect(getNoQueryResult.success).toBe(true);

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

  /** `streamId` is a misspelling of `stream`. The schema must reject it and must not drop it silently. */
  it('should reject unrecognized parameters with a clear error', () => {
    const schema = buildRegistrationSchema(testActions);

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

  /**
   * Both fields are plain strings with no enum, so only the default differs.
   * Without this check, the first declaration hides the second in the registration schema.
   */
  it('should throw when two actions share a field whose defaults differ', () => {
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

  /** A `z.literal` field is a one-member enum in the field contract. Neither field has a default, so only the value differs. */
  it('should throw when two actions share a literal-valued field with different values', () => {
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

  /** A union of literals is a hand-written `z.enum`, so two different value sets must collide. */
  it('should throw when a union-of-literals field diverges across actions', () => {
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

  /**
   * `riskTier` and `designDepth` are sibling action input fields, and `boundaryTouching` stands for the obligation fields.
   * Two actions that declare the three fields with the same base types must compose without a throw.
   * A second action with a different `designDepth` value set must still collide.
   */
  it('RegistrationSchema_RiskTierPlusDesignDepth_NoFieldCollision', () => {
    const riskTier = z.enum(['low', 'medium', 'high']).optional();
    const designDepth = z.enum(['thin', 'standard', 'deep']).optional();
    const boundaryTouching = z.boolean().optional();

    const combined: readonly ToolAction[] = [
      {
        name: 'prepare_delegation',
        description: 'Carries riskTier + designDepth',
        schema: z.object({ riskTier, designDepth, boundaryTouching }),
        phases: new Set(['plan']),
        roles: new Set(['any']),
      },
      {
        name: 'transition',
        description: 'Re-declares the same fields with identical base types',
        schema: z.object({ riskTier, designDepth, boundaryTouching }),
        phases: new Set(['plan']),
        roles: new Set(['any']),
      },
    ];

    expect(() => buildRegistrationSchema(combined)).not.toThrow();

    const shadowed: readonly ToolAction[] = [
      {
        name: 'first',
        description: 'Declares the canonical designDepth',
        schema: z.object({ designDepth }),
        phases: new Set(['plan']),
        roles: new Set(['any']),
      },
      {
        name: 'second',
        description: 'Shadows designDepth with a divergent enum',
        schema: z.object({ designDepth: z.enum(['shallow', 'full']).optional() }),
        phases: new Set(['plan']),
        roles: new Set(['any']),
      },
    ];
    expect(() => buildRegistrationSchema(shadowed)).toThrow(/collides/);
  });

  /**
   * `doctor` and `onboard` declare `format` with the values `table` and `json`.
   * `agent_spec` names its field `outputFormat`. A `format` field there with `full` and `prompt-only` collides with those values.
   */
  it('should accept doctor format values against the real orchestrate registration schema', () => {
    const orchestrate = TOOL_REGISTRY.find((t) => t.name === 'exarchos_orchestrate')!;
    const schema = buildRegistrationSchema(orchestrate.actions);

    expect(schema.safeParse({ action: 'doctor' }).success).toBe(true);
    expect(schema.safeParse({ action: 'doctor', format: 'json' }).success).toBe(true);
    expect(schema.safeParse({ action: 'doctor', format: 'table' }).success).toBe(true);
    expect(schema.safeParse({ action: 'onboard', dryRun: true }).success).toBe(true);
    expect(schema.safeParse({ action: 'onboard', format: 'json' }).success).toBe(true);
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

describe('merge_orchestrate description', () => {
  /** The description must state the wrong uses and name the correct action for each one. */
  it('MergeOrchestrateDescription_StatesDoNotUseFor_WithPointers', () => {
    const action = findActionInRegistry('exarchos_orchestrate', 'merge_orchestrate');
    expect(action).toBeDefined();
    const description = action!.description;

    expect(description).toContain('Do NOT use for');

    expect(description).toContain('merge_pr');
    expect(description).toContain('verify_worktree');
    expect(description).toContain('request_synthesize');
  });
});

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

/**
 * `findVariantPropertyShape` returns the JSON Schema of one property.
 * When the schema has an `anyOf` or `oneOf`, it reads the first variant that holds the property.
 * If not, it reads the top-level `properties`.
 */
describe('buildRegistrationSchema JSON Schema', () => {
  function findVariantPropertyShape(
    json: Record<string, unknown>,
    propName: string,
  ): Record<string, unknown> | undefined {
    const anyOf = (json.anyOf ?? json.oneOf) as
      | Array<Record<string, unknown>>
      | undefined;
    if (!anyOf) {
      const props = json.properties as Record<string, Record<string, unknown>> | undefined;
      return props?.[propName];
    }
    for (const variant of anyOf) {
      const props = variant.properties as Record<string, Record<string, unknown>> | undefined;
      if (props && propName in props) return props[propName];
    }
    return undefined;
  }

  /** The `event` field of the event tool is a `coercedRecord()`. */
  it('should emit type:object for coercedRecord fields', () => {
    const event = TOOL_REGISTRY.find((t) => t.name === 'exarchos_event')!;
    const schema = buildRegistrationSchema(event.actions);
    const json = zodToJsonSchema(schema) as unknown as Record<string, unknown>;
    const eventProp = findVariantPropertyShape(json, 'event');
    expect(eventProp).toBeDefined();
    expect(eventProp).toMatchObject({ type: 'object' });
  });

  it('should emit type:integer for coercedPositiveInt fields', () => {
    const event = TOOL_REGISTRY.find((t) => t.name === 'exarchos_event')!;
    const schema = buildRegistrationSchema(event.actions);
    const json = zodToJsonSchema(schema) as unknown as Record<string, unknown>;
    const limitProp = findVariantPropertyShape(json, 'limit');
    expect(limitProp).toBeDefined();
    expect(limitProp).toMatchObject({ type: 'integer', exclusiveMinimum: 0 });
  });

  it('should emit type:integer for coercedNonnegativeInt fields', () => {
    const event = TOOL_REGISTRY.find((t) => t.name === 'exarchos_event')!;
    const schema = buildRegistrationSchema(event.actions);
    const json = zodToJsonSchema(schema) as unknown as Record<string, unknown>;
    const offsetProp = findVariantPropertyShape(json, 'offset');
    expect(offsetProp).toBeDefined();
    expect(offsetProp).toMatchObject({ type: 'integer', minimum: 0 });
  });
});

/** The main phases of a feature workflow, which starts at `plan`. The set omits `merge-pending` and `blocked`. */
const ALL_FEATURE_PHASES = new Set([
  'plan',
  'plan-review',
  'delegate',
  'review',
  'synthesize',
]);

function findComposite(name: string) {
  return TOOL_REGISTRY.find((c) => c.name === name);
}

  function findAction(toolName: string, actionName: string): ToolAction {
    const tool = TOOL_REGISTRY.find((t) => t.name === toolName);
    const action = tool?.actions.find((a) => a.name === actionName);
    if (action === undefined) throw new Error(`action '${toolName}.${actionName}' not registered`);
    return action;
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

  /**
   * The phase-kind binding is internal verification routing: the `PhaseKind` union, the `KIND_OBLIGATIONS` table,
   * the gate-set resolver and the boundary that appends `phase.blocked`.
   * It must add no visible MCP tool and no composite. `exarchos_sync` is the only hidden composite.
   * The four visible composites are the visible MCP tools, and each one is a top-level CLI verb.
   */
  it('Registry_VisibleToolCount_UnchangedByPhaseKind', () => {
    const visibleTools = TOOL_REGISTRY.filter((t) => !t.hidden);
    expect(visibleTools.length).toBe(4);
    expect(visibleTools.length).toBeLessThanOrEqual(15);
    expect(visibleTools.map((t) => t.name).sort()).toEqual([
      'exarchos_event',
      'exarchos_orchestrate',
      'exarchos_view',
      'exarchos_workflow',
    ]);
    expect(TOOL_REGISTRY).toHaveLength(5);
  });

  /**
   * The `phase.entered` and `phase.exited` events, the gate-set resolver, `mintCapabilitiesForKind`
   * and `resolvePhaseMode` stay internal to the four visible tools.
   * The registry must expose none of them as a visible tool or as a composite action.
   * The `forbidden` list holds the names that such an action can have.
   */
  it('toolRegistry_PhaseKindWork_AddsNoVisibleToolOrVerb', () => {
    const visibleTools = TOOL_REGISTRY.filter((t) => !t.hidden);
    expect(visibleTools.map((t) => t.name).sort()).toEqual([
      'exarchos_event',
      'exarchos_orchestrate',
      'exarchos_view',
      'exarchos_workflow',
    ]);
    expect(TOOL_REGISTRY).toHaveLength(5);

    const allActionNames = TOOL_REGISTRY.flatMap((t) => t.actions.map((a) => a.name));
    const forbidden = [
      'resolve_gate_set',
      'resolveGateSet',
      'phase_kind',
      'mint_capabilities',
      'resolve_phase_mode',
      'kind_obligations',
      'phase_entered',
      'phase_exited',
    ];
    for (const name of forbidden) {
      expect(allActionNames).not.toContain(name);
    }
  });

  describe('exarchos_workflow', () => {
    /** The workflow tool has no `set` action. `transition` changes the phase, and `update` changes the other state. */
    it('should have 11 actions: init, get, transition, update, cancel, cleanup, reconcile, rehydrate, checkpoint, feedback, describe', () => {
      const composite = findComposite('exarchos_workflow');
      expect(composite).toBeDefined();
      const actionNames = composite!.actions.map((a) => a.name);
      expect(actionNames).toEqual(['init', 'get', 'transition', 'update', 'cancel', 'cleanup', 'reconcile', 'rehydrate', 'checkpoint', 'feedback', 'describe']);
    });
  });

  describe('exarchos_orchestrate', () => {
    /**
     * Pins the action count of `exarchos_orchestrate` and names actions that must exist.
     * The count alone passes when a different action takes the place of a named action.
     * Each new capability is an action on this tool and not a new visible tool.
     */
    it('should have 71 actions for task management, review triage, gate checks, validation handlers, runbooks, agent spec, oneshot/pruning, onboard (DR-2 task 011), doctor, VCS, classify_review_items (#1159), merge_orchestrate (DR-MO-1), check_integration_suite (#1329), check_invariant_conformance (DR-3), invariants_scaffold/invariants_add (invariants-catalog-wizard P2), check_test_adequacy + check_contract_drift + check_mock_boundary (verification-ladder slice 1), and composite actions', () => {
      const composite = findComposite('exarchos_orchestrate');
      expect(composite).toBeDefined();
      expect(composite!.actions).toHaveLength(85);

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
          'check_test_adequacy',
          'check_contract_drift',
          'check_mock_boundary',
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
          'onboard',
          'merge_orchestrate',
          'check_integration_suite',
          'check_invariant_conformance',
          'invariants_scaffold',
          'invariants_add',
          'mutation-adequacy',
          'acquire_worktree',
          'release_worktree',
          'prune_worktrees',
          'serialize_merge',
          'check_exploration_depth',
        ]),
      );
    });
  });

  /**
   * Each registered orchestrate action must have an `ACTION_HANDLERS` entry or an explicit `if (action === ...)` branch in the composite router.
   * `SPECIAL_BRANCH_DISPATCH` lists the actions that have only a branch.
   * A skip list alone hides an action that has no branch and no handler entry, and that action returns `UNKNOWN_ACTION` at runtime.
   * Thus the test dispatches each branch action with minimal arguments and asserts that the result is not `UNKNOWN_ACTION`.
   * The suite of each handler covers its behavior.
   */
  it('OrchestrateActions_MatchCompositeHandlers_InSync', async () => {
    const composite = findComposite('exarchos_orchestrate');
    expect(composite).toBeDefined();
    const registryNames = new Set(composite!.actions.map((a) => a.name));

    const { ACTION_HANDLER_KEYS } = await import('../../src/verbs/composite.js');

    const SPECIAL_ACTIONS = new Set([
      'describe',
      'runbook',
      'doctor',
      'invariants_scaffold',
      'invariants_add',
      'invariants_amend',
    ]);

    const SPECIAL_BRANCH_DISPATCH = new Set([...SPECIAL_ACTIONS, 'onboard']);

    for (const handlerKey of ACTION_HANDLER_KEYS) {
      expect(
        registryNames.has(handlerKey),
        `Handler '${handlerKey}' in composite.ts is missing from registry.ts orchestrateActions`,
      ).toBe(true);
    }
    for (const registryName of registryNames) {
      if (SPECIAL_ACTIONS.has(registryName)) continue;
      if (SPECIAL_BRANCH_DISPATCH.has(registryName)) continue;
      expect(
        ACTION_HANDLER_KEYS.includes(registryName),
        `Registry action '${registryName}' has no handler in composite.ts`,
      ).toBe(true);
    }

    const { handleOrchestrate } = await import('../../src/verbs/composite.js');
    const { EventStore } = await import('../../src/events/store.js');
    const { mkdtemp, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const path = await import('node:path');

    const branchOnly = [...registryNames].filter(
      (n) => !ACTION_HANDLER_KEYS.includes(n),
    );
    for (const name of branchOnly) {
      expect(
        SPECIAL_BRANCH_DISPATCH.has(name),
        `Registry action '${name}' is neither in ACTION_HANDLERS nor a known special branch`,
      ).toBe(true);
    }

    const base = await mkdtemp(path.join(tmpdir(), 'registry-dispatch-'));
    try {
      const stateDir = path.join(base, 'state');
      const eventStore = new EventStore(stateDir);
      await eventStore.initialize();
      const ctx = {
        stateDir,
        eventStore,
        enableTelemetry: false,
        cwd: base,
      } as unknown as Parameters<typeof handleOrchestrate>[1];

      const minimalArgs: Record<string, Record<string, unknown>> = {
        describe: { action: 'describe', actions: ['doctor'] },
        runbook: { action: 'runbook' },
        doctor: { action: 'doctor' },
        onboard: { action: 'onboard', dryRun: true, surface: 'cli' },
        invariants_scaffold: { action: 'invariants_scaffold', repoRoot: base },
        invariants_add: {
          action: 'invariants_add',
          repoRoot: base,
          entry: { dimension: 'x', summary: 'y' },
          dryRun: true,
        },
        invariants_amend: {
          action: 'invariants_amend',
          repoRoot: base,
          id: 'U-1',
          patch: { summary: 'y' },
          dryRun: true,
        },
      };

      for (const name of [...SPECIAL_BRANCH_DISPATCH]) {
        const result = await handleOrchestrate(minimalArgs[name], ctx);
        const errCode =
          result.success === false ? result.error?.code : undefined;
        expect(
          errCode,
          `Special action '${name}' fell through to UNKNOWN_ACTION — its composite dispatch branch is missing`,
        ).not.toBe('UNKNOWN_ACTION');
      }
    } finally {
      await rmrfAsync(base).catch(
        () => {},
      );
    }
  });

  /**
   * `check_invariant_conformance` is an action on `exarchos_orchestrate`, not a new tool.
   * It declares a `gate.executed` emission, so it cannot be `readOnly`: `RegistryDrift_AutoEmitsImpliesNotReadOnly` forbids that.
   * Its safety class is `local-mutation`, and it is not destructive.
   * The visible tools must stay at 15 or fewer.
   */
  it('Registry_CheckInvariantConformance_RegisteredReadOnlyUnder15Tools', () => {
    const action = findAction('exarchos_orchestrate', 'check_invariant_conformance');
    expect(action, 'check_invariant_conformance must be registered on exarchos_orchestrate').toBeDefined();

    expect(action!.annotations).toBeDefined();
    expect(action!.annotations!.safety).toBe('local-mutation');
    expect(action!.annotations!.readOnly).toBe(false);
    expect(action!.annotations!.destructive).toBe(false);
    expect(action!.annotations!.openWorld).toBe(false);
    expect(action!.outputSchema).toBeDefined();

    expect(action!.phases.has('review')).toBe(true);
    expect(action!.roles.has('lead')).toBe(true);
    expect(contractEmissionsOf(action!).some((e) => e.event === 'gate.executed')).toBe(true);

    const visibleTools = TOOL_REGISTRY.filter((t) => !t.hidden);
    expect(visibleTools.length).toBeLessThanOrEqual(15);
  });

  /**
   * `invariants_scaffold` is an action on `exarchos_orchestrate`, not a fifth visible tool.
   * It writes files, so its safety class is `local-mutation`.
   * Its description must tell the agent when not to use it.
   */
  it('Registry_InvariantsScaffold_HasOutputSchemaAndAnnotations', () => {
    const action = findAction('exarchos_orchestrate', 'invariants_scaffold');
    expect(action, 'invariants_scaffold must be registered on exarchos_orchestrate').toBeDefined();

    expect(action!.annotations).toBeDefined();
    expect(action!.annotations!.safety).toBe('local-mutation');
    expect(action!.annotations!.readOnly).toBe(false);
    expect(action!.annotations!.destructive).toBe(false);
    expect(action!.annotations!.openWorld).toBe(false);
    expect(action!.outputSchema).toBeDefined();

    expect(action!.description.toLowerCase()).toContain('do not use');

    const visibleTools = TOOL_REGISTRY.filter((t) => !t.hidden);
    expect(visibleTools.length).toBeLessThanOrEqual(15);
  });

  /**
   * `invariants_add` declares the `invariant.authored` and `catalog.registered` emissions.
   * The dispatch branch in `composite.ts` applies the dry-run default, so the `dryRun` schema field stays optional.
   * A Zod default on `dryRun` collides in `buildRegistrationSchema` with the actions that declare `dryRun` with no default.
   * The test parses the schema with `dryRun` omitted. It does not dispatch the action.
   */
  it('Registry_InvariantsAdd_DryRunDefault', () => {
    const action = findAction('exarchos_orchestrate', 'invariants_add');
    expect(action, 'invariants_add must be registered on exarchos_orchestrate').toBeDefined();

    expect(action!.annotations!.safety).toBe('local-mutation');
    expect(action!.annotations!.readOnly).toBe(false);
    expect(action!.outputSchema).toBeDefined();
    expect(action!.description.toLowerCase()).toContain('do not use');

    const events = contractEmissionsOf(action!).map((e) => e.event);
    expect(events).toContain('invariant.authored');
    expect(events).toContain('catalog.registered');

    const parsed = action!.schema.safeParse({
      entry: { dimension: 'd' },
      catalog: '.exarchos/invariants.md',
      tier: 'user',
    });
    expect(parsed.success).toBe(true);

    const visibleTools = TOOL_REGISTRY.filter((t) => !t.hidden);
    expect(visibleTools.length).toBeLessThanOrEqual(15);
  });

  /** `init` has no phases by design. Its guard checks that no workflow is active, and does not match a phase. */
  it('should have non-empty phases for every action except init', () => {
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

    /**
     * The view composite dispatches `session_provenance` and `provenance`, so the registry must hold both.
     * Without a registry entry, dispatch skips the Zod validation of the action, and `describe` does not list it.
     * `handleViewSessionProvenance` receives no event store, so its schema has no correlation fields.
     * `handleViewProvenance` queries the event store, so its schema must have `operationId`, `correlationId` and `causationId`.
     */
    it('TOOL_REGISTRY_viewActions_IncludesSessionProvenanceAndProvenance', () => {
      const viewComposite = findComposite('exarchos_view');
      expect(viewComposite).toBeDefined();

      const sessionProvenance = viewComposite!.actions.find(
        (a) => a.name === 'session_provenance',
      );
      expect(sessionProvenance, 'session_provenance must be registered').toBeDefined();
      expect(
        sessionProvenance!.schema instanceof z.ZodObject,
        'session_provenance.schema must be a ZodObject',
      ).toBe(true);
      const sessionProvenanceShape = (
        sessionProvenance!.schema as z.ZodObject
      ).shape;
      const sessionProvenanceParse = sessionProvenance!.schema.safeParse({
        sessionId: 'sess-abc',
        workflowId: 'wf-1',
        metric: 'cost',
      });
      expect(sessionProvenanceParse.success).toBe(true);
      expect(sessionProvenanceShape).not.toHaveProperty('operationId');
      expect(sessionProvenanceShape).not.toHaveProperty('correlationId');
      expect(sessionProvenanceShape).not.toHaveProperty('causationId');

      const provenance = viewComposite!.actions.find(
        (a) => a.name === 'provenance',
      );
      expect(provenance, 'provenance must be registered').toBeDefined();
      expect(
        provenance!.schema instanceof z.ZodObject,
        'provenance.schema must be a ZodObject',
      ).toBe(true);
      const provenanceShape = (provenance!.schema as z.ZodObject).shape;
      expect(provenanceShape).toHaveProperty('operationId');
      expect(provenanceShape).toHaveProperty('correlationId');
      expect(provenanceShape).toHaveProperty('causationId');
      expect(
        provenance!.schema.safeParse({ workflowId: 'wf-1' }).success,
      ).toBe(true);
    });
  });

  /**
   * Covers `serialize_merge` on `exarchos_orchestrate`, and `ps` and `wait` on `exarchos_view`.
   * The registry runs `validateAction` on each action at module load.
   * Thus a missing `outputSchema` or a malformed `annotations` block throws at import.
   * These tests give that regression a named failure.
   */
  describe('WLM operational-core registration floor (DR-4/DR-7)', () => {
    const NEW_ACTIONS: ReadonlyArray<readonly [string, string]> = [
      ['exarchos_orchestrate', 'serialize_merge'],
      ['exarchos_view', 'ps'],
      ['exarchos_view', 'wait'],
    ];

    /**
     * Each action must declare an `outputSchema` with a `parse` method, which is the shape that `validateAction` requires.
     * Each core annotation field must have the correct type.
     * `ps` appends nothing, so its annotation must be read-only.
     * `reconcile_worktrees` appends its repairs and converges on a repeat, so it is `local-mutation` and idempotent.
     */
    it('Registry_NewActions_DeclareOutputSchemaAndCoreAnnotations', () => {
      for (const [tool, name] of NEW_ACTIONS) {
        const action = findAction(tool, name);
        expect(action, `${tool}.${name} must be registered`).toBeDefined();

        expect(
          action!.outputSchema,
          `${tool}.${name} must declare an outputSchema`,
        ).toBeDefined();
        expect(
          typeof (action!.outputSchema as { parse?: unknown }).parse,
          `${tool}.${name}.outputSchema must be a Zod schema (got non-parseable value)`,
        ).toBe('function');

        const ann = action!.annotations;
        expect(ann, `${tool}.${name} must declare annotations`).toBeDefined();
        expect(typeof ann!.safety, `${tool}.${name}.annotations.safety`).toBe(
          'string',
        );
        expect(
          typeof ann!.readOnly,
          `${tool}.${name}.annotations.readOnly`,
        ).toBe('boolean');
        expect(
          typeof ann!.destructive,
          `${tool}.${name}.annotations.destructive`,
        ).toBe('boolean');
        expect(
          typeof ann!.idempotent,
          `${tool}.${name}.annotations.idempotent`,
        ).toBe('boolean');
        expect(
          typeof ann!.openWorld,
          `${tool}.${name}.annotations.openWorld`,
        ).toBe('boolean');
      }

      const ps = findAction('exarchos_view', 'ps');
      const wait = findAction('exarchos_view', 'wait');
      expect(ps!.annotations!.safety).toBe('read-only');
      expect(ps!.annotations!.readOnly).toBe(true);
      expect(ps!.annotations!.destructive).toBe(false);
      expect(wait!.annotations!.readOnly).toBe(true);
      const reconcile = findAction('exarchos_orchestrate', 'reconcile_worktrees');
      expect(reconcile!.annotations!.safety).toBe('local-mutation');
      expect(reconcile!.annotations!.readOnly).toBe(false);
      expect(reconcile!.annotations!.idempotent).toBe(true);
      expect(reconcile!.annotations!.destructive).toBe(false);
      const serializeMerge = findAction('exarchos_orchestrate', 'serialize_merge');
      expect(serializeMerge!.annotations!.readOnly).toBe(false);
    });

    /**
     * This file imports `TOOL_REGISTRY`, so the `validateAction` loop at module load did not throw.
     * The test runs `validateAction` again on each of the three actions, to name the action that fails.
     */
    it('Registry_ModuleLoad_DoesNotThrowOnNewActions', () => {
      for (const [tool, name] of NEW_ACTIONS) {
        const action = findAction(tool, name);
        expect(action, `${tool}.${name} must be registered`).toBeDefined();
        expect(
          () => validateAction(action!, tool),
          `${tool}.${name} fails the module-load validateAction gate — it would ` +
            `throw at import time and crash MCP startup`,
        ).not.toThrow();
      }

      return expect(import('../../src/registry.js')).resolves.toBeDefined();
    });

    /** The three actions sit on existing composites. The registry must still hold four visible tools and five composites in total. */
    it('Registry_VisibleCompositeToolCount_StaysFour', () => {
      const visibleTools = TOOL_REGISTRY.filter((t) => !t.hidden);
      expect(visibleTools.length).toBe(4);
      expect(visibleTools.map((t) => t.name).sort()).toEqual([
        'exarchos_event',
        'exarchos_orchestrate',
        'exarchos_view',
        'exarchos_workflow',
      ]);
      expect(TOOL_REGISTRY).toHaveLength(5);
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

    it('should accept empty input for sync now', () => {
      const action = findAction('exarchos_sync', 'now');
      expect(action).toBeDefined();

      const result = action!.schema.safeParse({});
      expect(result.success).toBe(true);
    });
  });
});

describe('CLI hints', () => {
  it('ToolAction_AcceptsCliHints_TypeChecks', () => {
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
    expect(action.cli?.alias).toBe('ls');
    expect(action.cli?.flags?.id?.alias).toBe('i');
    expect(action.cli?.format).toBe('table');
  });

  it('CompositeTool_AcceptsCliHints_TypeChecks', () => {
    const tool: CompositeTool = {
      name: 'exarchos_test',
      description: 'test tool',
      actions: [],
      cli: { alias: 'tst', group: 'Testing' },
    };
    expect(tool.cli?.alias).toBe('tst');
  });

  it('ToolAction_WithoutCliHints_StillWorks', () => {
    const action: ToolAction = {
      name: 'test',
      description: 'test',
      schema: z.object({}),
      phases: new Set([]),
      roles: new Set([]),
    };
    expect(action.cli).toBeUndefined();
  });

  it('TOOL_REGISTRY_EntriesStillTypeCheck', () => {
    expect(TOOL_REGISTRY.length).toBeGreaterThan(0);
    for (const tool of TOOL_REGISTRY) {
      expect(tool.name).toBeTruthy();
      expect(tool.actions.length).toBeGreaterThan(0);
    }
  });
});

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

  it('TransitionAction_HasFlagAliases', () => {
    const action = findAction('exarchos_workflow', 'transition');
    expect(action).toBeDefined();
    expect(action!.cli?.flags?.featureId?.alias).toBe('f');
    expect(action!.cli?.flags?.target?.alias).toBe('t');
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

describe('CLI examples on common actions', () => {
  it('CliHints_ExamplesPresent_ForCommonActions', () => {
    const initAction = findAction('exarchos_workflow', 'init');
    expect(initAction!.cli?.examples).toBeDefined();
    expect(initAction!.cli!.examples!.length).toBeGreaterThan(0);

    const getAction = findAction('exarchos_workflow', 'get');
    expect(getAction!.cli?.examples).toBeDefined();
    expect(getAction!.cli!.examples!.length).toBeGreaterThan(0);

    const transitionAction = findAction('exarchos_workflow', 'transition');
    expect(transitionAction!.cli?.examples).toBeDefined();
    expect(transitionAction!.cli!.examples!.length).toBeGreaterThan(0);

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

describe('Dynamic Tool Registration', () => {
  const fixtureContract: ActionContract = {
    requires: none('custom fixture has no additional obligations'),
    ensures: none('custom fixture has no durable postcondition'),
    needs: none('custom fixture declares no capabilities'),
    touches: {
      frame: 'single-machine',
      resources: none('custom fixture touches no durable resources'),
    },
    executionAuthority: { kind: 'local' },
    replay: { kind: 'claim-required', scope: 'stream-subject-request' },
    emissions: none('custom fixture emits no events'),
  };

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
        actionContract: fixtureContract,
      },
      {
        name: 'status',
        description: 'Get deployment status',
        schema: z.object({ deployId: z.string().optional() }),
        phases: new Set(['deploy']),
        roles: new Set(['any']),
        actionContract: fixtureContract,
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
    expect(getFullRegistry()).toHaveLength(TOOL_REGISTRY.length);

    registerCustomTool(customTool);
    expect(getFullRegistry()).toHaveLength(TOOL_REGISTRY.length + 1);

    const names = getFullRegistry().map((t) => t.name);
    expect(names).toContain('exarchos_workflow');
    expect(names).toContain('exarchos_deploy');
  });

  it('RegisterCustomTool_GeneratesValidSchema', () => {
    registerCustomTool(customTool);

    const full = getFullRegistry();
    const tool = full.find((t) => t.name === 'exarchos_deploy')!;
    const schema = buildRegistrationSchema(tool.actions);

    const result = schema.safeParse({ action: 'trigger', target: 'production' });
    expect(result.success).toBe(true);

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

describe('Gate Metadata', () => {
  /**
   * The list omits `check_event_emissions`, which suggests missing events and is not a gate.
   * The test also asserts that the registry holds each expected action.
   */
  it('GateMetadata_CheckActions_HaveGateField', () => {
    const expectedCheckActions = new Set([
      'check_static_analysis', 'check_security_scan',
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

    for (const expected of expectedCheckActions) {
      expect(
        visited.has(expected),
        `Expected check action '${expected}' was not found in TOOL_REGISTRY`,
      ).toBe(true);
    }
  });

  /** The gate blocks on a violation of a check-mode invariant, so its gate metadata must declare `blocking: true`. */
  it('GateMetadata_CheckInvariantConformance_IsBlocking', () => {
    const action = findAction('exarchos_orchestrate', 'check_invariant_conformance');
    expect(action, 'check_invariant_conformance must be registered').toBeDefined();
    expect(action!.gate, 'check_invariant_conformance must carry gate metadata').toBeDefined();
    expect(action!.gate!.blocking).toBe(true);
  });
});

describe('Slim Description', () => {
  it('SlimDescription_AllVisibleTools_HaveSlimDescription', () => {
    for (const tool of TOOL_REGISTRY) {
      if (tool.hidden) continue;
      expect(tool.slimDescription, `${tool.name} should have slimDescription`).toBeDefined();
      expect(tool.slimDescription!.length).toBeGreaterThan(0);
      expect(tool.slimDescription!).toContain('describe');
    }
  });
});

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

describe('Runbook action in registry', () => {
  it('RunbookAction_ExistsInOrchestrateRegistry', () => {
    const orchTool = findComposite('exarchos_orchestrate');
    expect(orchTool).toBeDefined();
    const runbookAction = orchTool!.actions.find(a => a.name === 'runbook');
    expect(runbookAction, 'exarchos_orchestrate should have a runbook action').toBeDefined();
    expect(runbookAction!.description).toBeTruthy();
    expect(runbookAction!.schema.safeParse({}).success).toBe(true);
    expect(runbookAction!.schema.safeParse({ phase: 'delegate' }).success).toBe(true);
    expect(runbookAction!.schema.safeParse({ id: 'task-completion' }).success).toBe(true);
  });
});

describe('Describe action in registry', () => {
  it('DescribeAction_AllVisibleTools_HaveDescribeAction', () => {
    for (const tool of TOOL_REGISTRY) {
      if (tool.hidden) continue;
      const describeAction = tool.actions.find(a => a.name === 'describe');
      expect(describeAction, `${tool.name} should have a describe action`).toBeDefined();
    }
  });
});

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

    const result1 = action!.schema.safeParse({ workflowId: 'test-feature' });
    expect(result1.success).toBe(true);

    const result2 = action!.schema.safeParse({
      workflowId: 'test-feature',
      skill: 'refactor',
    });
    expect(result2.success).toBe(true);

    const result3 = action!.schema.safeParse({});
    expect(result3.success).toBe(true);
  });
});

describe('AutoEmits Drift Tests', () => {
  /**
   * Each declared emission must have the source `auto` in `EVENT_EMISSION_REGISTRY`.
   * `normalizeEmission` in `src/registry/action-contract.ts` makes the same check at admission.
   * This census catches a declaration that reaches `TOOL_REGISTRY` without that check.
   * It also asserts a floor on the count of actions that declare emissions, so a mass loss of declarations fails.
   */
  it('RegistryDrift_AutoEmitsMatchEventEmissionRegistry', async () => {
    const { EVENT_EMISSION_REGISTRY } = await import('../../src/events/schemas.js');

    let populatedCount = 0;
    const violations: string[] = [];

    for (const tool of TOOL_REGISTRY) {
      for (const action of tool.actions) {
        const emissions = contractEmissionsOf(action);
        if (emissions.length === 0) continue;
        populatedCount += 1;

        for (const emission of emissions) {
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

    expect(populatedCount, 'declared autoEmits population dropped below the floor').toBeGreaterThan(
      56,
    );
    expect(violations, `AutoEmits drift:\n${violations.join('\n')}`).toEqual([]);
  });

  it('RegistryDrift_DescriptionEmitsImpliesAutoEmitsField', () => {
    const emitsPatterns = [/Auto-emits/i, /Emits gate\.executed/i, /Emits task\./i];
    const violations: string[] = [];

    for (const tool of TOOL_REGISTRY) {
      for (const action of tool.actions) {
        const matchesPattern = emitsPatterns.some((p) => p.test(action.description));
        if (matchesPattern) {
          if (contractEmissionsOf(action).length === 0) {
            violations.push(
              `${tool.name}.${action.name}: description mentions emissions but autoEmits is empty/undefined. Description: "${action.description}"`,
            );
          }
        }
      }
    }

    expect(violations, `Description/autoEmits drift:\n${violations.join('\n')}`).toEqual([]);
  });

  /**
   * An action that emits events writes to the event store, so it must not declare `readOnly: true`.
   * A wrong annotation lets a client with only the read-only capability change state.
   */
  it('RegistryDrift_AutoEmitsImpliesNotReadOnly', () => {
    const violations: string[] = [];
    for (const tool of TOOL_REGISTRY) {
      for (const action of tool.actions) {
        const emissions = contractEmissionsOf(action);
        if (emissions.length === 0) continue;
        if (action.annotations?.readOnly === true) {
          const events = emissions.map((e) => e.event).join(', ');
          violations.push(
            `${tool.name}.${action.name}: declares autoEmits [${events}] but annotations.readOnly === true`,
          );
        }
      }
    }
    expect(
      violations,
      `Actions with autoEmits must not be readOnly:\n${violations.join('\n')}`,
    ).toEqual([]);
  });
});

describe('Plugin Integration Registry Wiring', () => {
  it('RegistryActions_PrepareReview_Registered', () => {
    const orchTool = findComposite('exarchos_orchestrate');
    expect(orchTool).toBeDefined();
    const prepareReview = orchTool!.actions.find((a) => a.name === 'prepare_review');
    expect(prepareReview, 'exarchos_orchestrate should have a prepare_review action').toBeDefined();
    expect(prepareReview!.description).toBeTruthy();
    expect(prepareReview!.schema.safeParse({ featureId: 'test-feature' }).success).toBe(true);
    expect(prepareReview!.schema.safeParse({
      featureId: 'test-feature',
      scope: 'full',
      dimensions: ['error-handling'],
    }).success).toBe(true);
    expect(prepareReview!.phases.has('review')).toBe(true);
    expect(prepareReview!.phases.has('overhaul-review')).toBe(true);
    expect(prepareReview!.phases.has('debug-review')).toBe(true);
    expect(prepareReview!.roles.has('lead')).toBe(true);
  });

  /** The shepherd loop calls `classify_review_items` in `synthesize`. Without that phase, the phase guard rejects the call. */
  it('RegistryActions_ClassifyReviewItems_IncludesSynthesizePhase', () => {
    const action = findAction('exarchos_orchestrate', 'classify_review_items');
    expect(action).toBeDefined();
    expect(action!.phases.has('synthesize')).toBe(true);
    expect(action!.phases.has('review')).toBe(true);
    expect(action!.phases.has('overhaul-review')).toBe(true);
    expect(action!.phases.has('debug-review')).toBe(true);
  });

  /** The parsed data must keep `pluginFindings`. A schema that does not declare the field strips it. */
  it('RegistryActions_CheckReviewVerdict_HasPluginFindingsInSchema', () => {
    const action = findAction('exarchos_orchestrate', 'check_review_verdict');
    expect(action).toBeDefined();

    const result = action!.schema.safeParse({
      featureId: 'test-feature',
      high: 0,
      medium: 1,
      low: 2,
      pluginFindings: [
        {
          source: 'impeccable',
          severity: 'MEDIUM',
          dimension: 'error-handling',
          file: 'src/foo.ts',
          line: 42,
          message: 'Missing error boundary',
        },
      ],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      const data = result.data as Record<string, unknown>;
      expect(data.pluginFindings).toBeDefined();
      expect(Array.isArray(data.pluginFindings)).toBe(true);
      const findings = data.pluginFindings as Array<Record<string, unknown>>;
      expect(findings).toHaveLength(1);
      expect(findings[0].source).toBe('impeccable');
      expect(findings[0].severity).toBe('MEDIUM');
    }

    const resultWithout = action!.schema.safeParse({
      featureId: 'test-feature',
      high: 0,
      medium: 0,
      low: 0,
    });
    expect(resultWithout.success).toBe(true);
  });

  /**
   * A caller can request synthesis in `plan`, before the work starts.
   * The request event stays in the stream until `finalize_oneshot` reads it.
   */
  it('RegistryActions_RequestSynthesize_AllowsPlanAndImplementingPhases', () => {
    const action = findAction('exarchos_orchestrate', 'request_synthesize');
    expect(action, 'exarchos_orchestrate should have a request_synthesize action').toBeDefined();
    expect(action!.phases.has('plan')).toBe(true);
    expect(action!.phases.has('implementing')).toBe(true);
  });
});

describe('#1499 state-source migration schema (regression guard)', () => {
  /**
   * The skill callers of these two actions can pass only `stateFile`, so `featureId` must stay optional.
   * A call with only `featureId` reads the event store, and it must also validate.
   */
  it.each([
    'verify_review_triage',
    'extract_fix_tasks',
  ])('%s accepts a stateFile-only input (featureId optional)', (action) => {
    const found = findActionInRegistry('exarchos_orchestrate', action);
    expect(found, `${action} must be registered`).toBeDefined();
    expect(
      found!.schema.safeParse({ stateFile: '/tmp/wf.state.json' }).success,
      `${action} must accept stateFile-only`,
    ).toBe(true);
    expect(found!.schema.safeParse({ featureId: 'wf-x' }).success).toBe(true);
  });

  /**
   * These two actions declare durable gate evidence, and the postcondition observer reads it on the stream that the call names.
   * A call with only `stateFile` names no stream, so the schema must reject it.
   * `stateFile` stays as an override for state resolution.
   */
  it.each([
    'pre_synthesis_check',
    'post_delegation_check',
  ])('%s requires featureId — the stream its declared evidence records against', (action) => {
    const found = findActionInRegistry('exarchos_orchestrate', action);
    expect(found, `${action} must be registered`).toBeDefined();
    expect(
      found!.schema.safeParse({ stateFile: '/tmp/wf.state.json', repoRoot: '.' }).success,
      `${action} must reject stateFile-only`,
    ).toBe(false);
    expect(found!.schema.safeParse({ featureId: 'wf-x', repoRoot: '.' }).success).toBe(true);
  });
});

/** The output schema of `transition` keeps an optional `_meta.deprecation` slot. */
describe('Registry_OutputSchema (T40, DR-11)', () => {
  function findAction(toolName: string, actionName: string): ToolAction {
    const tool = TOOL_REGISTRY.find((t) => t.name === toolName);
    const action = tool?.actions.find((a) => a.name === actionName);
    if (action === undefined) throw new Error(`action '${toolName}.${actionName}' not registered`);
    return action;
  }

  /**
   * Each envelope holds `next_actions` and `_perf`, as the success branch of `EnvelopeSchema` requires.
   * The schema must accept an envelope with a full deprecation block and an envelope with none.
   * It must reject a deprecation block whose `replacement` is missing or empty.
   */
  it('Registry_OutputSchema_RegistersMetaDeprecationOnAffectedActions', () => {
    const transitionAction = findAction('exarchos_workflow', 'transition');

    expect(transitionAction).toBeDefined();
    expect(transitionAction!.outputSchema).toBeDefined();

    const perf = { ms: 0, bytes: 0, tokens: 0 };

    const goodEnvelope = {
      success: true,
      data: { phase: 'plan', updatedAt: '2026-05-08T00:00:00Z' },
      next_actions: [],
      _meta: {
        deprecation: {
          since: '2.10.0',
          removeIn: '2.11.0',
          replacement: 'transition',
        },
      },
      _perf: perf,
    };
    expect(transitionAction!.outputSchema!.safeParse(goodEnvelope).success).toBe(
      true,
    );

    const missingReplacement = {
      success: true,
      data: { phase: 'plan' },
      next_actions: [],
      _meta: { deprecation: { since: '2.10.0', removeIn: '2.11.0' } },
      _perf: perf,
    };
    expect(
      transitionAction!.outputSchema!.safeParse(missingReplacement).success,
    ).toBe(false);

    const emptyReplacement = {
      success: true,
      data: { phase: 'plan' },
      next_actions: [],
      _meta: {
        deprecation: { since: '2.10.0', removeIn: '2.11.0', replacement: '' },
      },
      _perf: perf,
    };
    expect(
      transitionAction!.outputSchema!.safeParse(emptyReplacement).success,
    ).toBe(false);

    const noDeprecation = {
      success: true,
      data: { phase: 'plan', updatedAt: '2026-05-08T00:00:00Z' },
      next_actions: [],
      _meta: {},
      _perf: perf,
    };
    expect(transitionAction!.outputSchema!.safeParse(noDeprecation).success).toBe(
      true,
    );
  });
});

/**
 * `WorkflowSetOutputSchema`, `WorkflowTransitionOutputSchema` and `WorkflowUpdateOutputSchema` are deprecated wrappers.
 * Each one derives from the `EnvelopeSchema` factory in `contract/schemas/envelope.ts`.
 */
describe('Registry_OutputSchema (Wave 0 / G.2)', () => {
  /** `wrap()` builds the envelope. The transition and set wrappers must also accept a deprecation block in `_meta`. */
  it('WorkflowTransitionOutputSchema_DerivedFromEnvelopeFactory_ParsesValidSuccessEnvelope', () => {
    const env = wrap(
      { phase: 'plan' },
      { deprecation: { since: '2.10', removeIn: '2.12', replacement: 'transition' } },
    );
    expect(WorkflowTransitionOutputSchema.safeParse(env).success).toBe(true);

    expect(WorkflowSetOutputSchema.safeParse(env).success).toBe(true);
    const updateEnv = wrap({ phase: 'plan' }, {});
    expect(WorkflowUpdateOutputSchema.safeParse(updateEnv).success).toBe(true);
  });

  it('WorkflowTransitionOutputSchema_DerivedFromEnvelopeFactory_ParsesValidErrorEnvelope', () => {
    const errEnv = wrapError(
      new ConcurrencyError({
        streamId: 'stream-x',
        reducerId: 'reducer-y',
        expectedVersion: 1,
        actualVersion: 2,
      }),
    );
    expect(WorkflowTransitionOutputSchema.safeParse(errEnv).success).toBe(true);
    expect(WorkflowSetOutputSchema.safeParse(errEnv).success).toBe(true);
    expect(WorkflowUpdateOutputSchema.safeParse(errEnv).success).toBe(true);
  });

  /**
   * A `RESERVED_FIELD` error carries a typed `data` block with `rejectedPath`, `rule` and `alternateWritePath`.
   * The error branch of the `update` output schema must accept that envelope and keep `data`.
   */
  it('WorkflowUpdate_ErrorBranch_OutputSchemaPermitsTypedData', () => {
    const reservedFieldEnv = {
      success: false as const,
      error: {
        code: 'RESERVED_FIELD',
        message: 'Cannot update reserved field: phase',
        data: {
          rejectedPath: 'phase',
          rule: '`phase` is top-level immutable — set once at init, never directly mutated thereafter.',
          alternateWritePath:
            'Use `exarchos_workflow.transition({featureId, toPhase})` — phase changes are HSM-validated and emit transition events.',
        },
      },
      _meta: {},
      _perf: { ms: 0, bytes: 0, tokens: 0 },
    };

    const parsed = WorkflowUpdateOutputSchema.safeParse(reservedFieldEnv);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      const env = parsed.data as { success: false; error: Record<string, unknown> };
      expect(env.error.data).toBeDefined();
      const errData = env.error.data as Record<string, unknown>;
      expect(errData.rejectedPath).toBe('phase');
      expect(errData.alternateWritePath).toMatch(/transition/i);
    }
  });
});

/**
 * An annotation record holds the server-trusted `safety` class and four advisory flags.
 * The flags are `readOnly`, `destructive`, `idempotent` and `openWorld`.
 * The schema rejects a record whose flags contradict its `safety` class, such as `read-only` with `readOnly: false`.
 * Without that rule, a contradictory record can give an action that writes the server-trusted `read-only` class.
 */
describe('ActionAnnotationsSchema', () => {
  const valid: ActionAnnotations = {
    safety: 'read-only',
    readOnly: true,
    destructive: false,
    idempotent: true,
    openWorld: false,
  };

  it('ActionAnnotationsSchema_RejectsMissingSafetyField_Fails', () => {
    const { safety: _drop, ...withoutSafety } = valid;
    const result = ActionAnnotationsSchema.safeParse(withoutSafety);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path.join('.') === 'safety')).toBe(
        true,
      );
    }
  });

  it('ActionAnnotationsSchema_RejectsMissingReadOnlyField_Fails', () => {
    const { readOnly: _drop, ...withoutReadOnly } = valid;
    const result = ActionAnnotationsSchema.safeParse(withoutReadOnly);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(
        result.error.issues.some((i) => i.path.join('.') === 'readOnly'),
      ).toBe(true);
    }
  });

  /** The schema must also accept the canonical record of each `safety` value. */
  it('ActionAnnotationsSchema_AcceptsCompleteRecord_Succeeds', () => {
    const result = ActionAnnotationsSchema.safeParse(valid);
    expect(result.success).toBe(true);

    const canonicalByEnumValue: Record<ActionAnnotations['safety'], ActionAnnotations> = {
      'read-only': {
        safety: 'read-only',
        readOnly: true,
        destructive: false,
        idempotent: true,
        openWorld: false,
      },
      'local-mutation': {
        safety: 'local-mutation',
        readOnly: false,
        destructive: false,
        idempotent: false,
        openWorld: false,
      },
      'remote-mutation': {
        safety: 'remote-mutation',
        readOnly: false,
        destructive: false,
        idempotent: false,
        openWorld: true,
      },
      compensable: {
        safety: 'compensable',
        readOnly: false,
        destructive: true,
        idempotent: false,
        openWorld: false,
      },
    };
    for (const canonical of Object.values(canonicalByEnumValue)) {
      expect(ActionAnnotationsSchema.safeParse(canonical).success).toBe(true);
    }
  });

  it('ActionAnnotationsSchema_RejectsInvalidSafetyEnum_Fails', () => {
    const result = ActionAnnotationsSchema.safeParse({
      ...valid,
      safety: 'partial-mutation',
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path.join('.') === 'safety')).toBe(
        true,
      );
    }
  });

  it('ActionAnnotationsSchema_RejectsReadOnlySafetyWithReadOnlyFalse_Fails', () => {
    const result = ActionAnnotationsSchema.safeParse({
      safety: 'read-only',
      readOnly: false,
      destructive: false,
      idempotent: true,
      openWorld: false,
    });
    expect(result.success).toBe(false);
  });

  it('ActionAnnotationsSchema_RejectsReadOnlySafetyWithDestructiveTrue_Fails', () => {
    const result = ActionAnnotationsSchema.safeParse({
      safety: 'read-only',
      readOnly: true,
      destructive: true,
      idempotent: true,
      openWorld: false,
    });
    expect(result.success).toBe(false);
  });

  it('ActionAnnotationsSchema_RejectsLocalMutationWithReadOnlyTrue_Fails', () => {
    const result = ActionAnnotationsSchema.safeParse({
      safety: 'local-mutation',
      readOnly: true,
      destructive: false,
      idempotent: false,
      openWorld: false,
    });
    expect(result.success).toBe(false);
  });

  it('ActionAnnotationsSchema_RejectsCompensableWithDestructiveFalse_Fails', () => {
    const result = ActionAnnotationsSchema.safeParse({
      safety: 'compensable',
      readOnly: false,
      destructive: false,
      idempotent: false,
      openWorld: false,
    });
    expect(result.success).toBe(false);
  });

  it('ActionAnnotationsSchema_RejectsRemoteMutationWithOpenWorldFalse_Fails', () => {
    const result = ActionAnnotationsSchema.safeParse({
      safety: 'remote-mutation',
      readOnly: false,
      destructive: false,
      idempotent: false,
      openWorld: false,
    });
    expect(result.success).toBe(false);
  });
});

describe('validateAnnotations', () => {
  const valid: ActionAnnotations = {
    safety: 'local-mutation',
    readOnly: false,
    destructive: false,
    idempotent: true,
    openWorld: false,
  };

  /** The message must name the action and at least one missing field, so an operator can find the fault. */
  it('validateAnnotations_ThrowsOnPartialObject_IncludesFieldName', () => {
    const partial = { safety: 'local-mutation', readOnly: false };

    let caught: Error | undefined;
    try {
      validateAnnotations(partial, 'composeMessage');
    } catch (err) {
      caught = err as Error;
    }

    expect(caught).toBeInstanceOf(Error);
    expect(caught!.message).toContain('composeMessage');
    const mentionsAMissingField =
      caught!.message.includes('destructive') ||
      caught!.message.includes('idempotent') ||
      caught!.message.includes('openWorld');
    expect(mentionsAMissingField).toBe(true);
  });

  it('validateAnnotations_AcceptsCompleteRecord_DoesNotThrow', () => {
    expect(() => validateAnnotations(valid, 'composeMessage')).not.toThrow();
  });
});

/**
 * Each action of each tool, visible or hidden, must declare a Zod `outputSchema` and an `annotations` record.
 * A failure names the `<tool>.<action>` that breaks the rule.
 */
describe('Registry invariants — outputSchema + annotations', () => {
  it('Registry_AllActionsAcrossVisibleAndHiddenTools_DeclareOutputSchema', () => {
    const offenders: string[] = [];
    for (const tool of getFullRegistry()) {
      for (const action of tool.actions) {
        const id = `${tool.name}.${action.name}`;
        if (action.outputSchema === undefined) {
          offenders.push(`${id} (missing outputSchema)`);
          continue;
        }
        if (typeof (action.outputSchema as { parse?: unknown }).parse !== 'function') {
          offenders.push(`${id} (outputSchema is not a Zod schema)`);
        }
      }
    }
    expect(offenders, offenders.join('\n')).toEqual([]);
  });

  /** The test validates each record again, so a record that drifts from the schema fails here. */
  it('Registry_AllActionsAcrossVisibleAndHiddenTools_DeclareAnnotations', () => {
    const offenders: string[] = [];
    for (const tool of getFullRegistry()) {
      for (const action of tool.actions) {
        const id = `${tool.name}.${action.name}`;
        if (action.annotations === undefined) {
          offenders.push(`${id} (missing annotations)`);
          continue;
        }
        try {
          validateAnnotations(action.annotations, id);
        } catch (err) {
          offenders.push(
            `${id} (invalid annotations: ${err instanceof Error ? err.message : String(err)})`,
          );
        }
      }
    }
    expect(offenders, offenders.join('\n')).toEqual([]);
  });
});

/**
 * `validateAction` is the gate that the registry runs on each action at module load.
 * Its error names the `<tool>.<action>` that has no `outputSchema`, no valid `annotations` or no `actionContract`.
 */
describe('validateAction', () => {
  const importValidateAction = async () => {
    const mod = await import('../../src/registry.js');
    return (mod as { validateAction: (
      action: { name: string; outputSchema?: z.ZodType; annotations?: unknown },
      toolName: string,
    ) => void }).validateAction;
  };

  const validAnnotations: ActionAnnotations = {
    safety: 'local-mutation',
    readOnly: false,
    destructive: false,
    idempotent: false,
    openWorld: false,
  };

  it('ValidateAction_MissingOutputSchema_ThrowsWithActionName', async () => {
    const validateAction = await importValidateAction();
    expect(() =>
      validateAction(
        { name: 'noOutput', annotations: validAnnotations },
        'exarchos_workflow',
      ),
    ).toThrow(/exarchos_workflow\.noOutput/);
    expect(() =>
      validateAction(
        { name: 'noOutput', annotations: validAnnotations },
        'exarchos_workflow',
      ),
    ).toThrow(/outputSchema/);
  });

  it('ValidateAction_MissingAnnotations_ThrowsWithActionName', async () => {
    const validateAction = await importValidateAction();
    expect(() =>
      validateAction(
        { name: 'noAnnotations', outputSchema: z.object({}) },
        'exarchos_view',
      ),
    ).toThrow(/exarchos_view\.noAnnotations/);
  });

  it('ValidateAction_ValidAction_DoesNotThrow', async () => {
    const validateAction = await importValidateAction();
    const reasonedNone = none('registration fixture has no additional obligations');
    expect(() =>
      validateAction(
        {
          name: 'ok',
          outputSchema: z.object({ success: z.boolean() }),
          annotations: validAnnotations,
          actionContract: {
            requires: reasonedNone,
            ensures: reasonedNone,
            needs: reasonedNone,
            touches: { frame: 'single-machine', resources: reasonedNone },
            executionAuthority: { kind: 'local' },
            replay: { kind: 'claim-required', scope: 'stream-subject-request' },
            emissions: reasonedNone,
          },
        },
        'exarchos_event',
      ),
    ).not.toThrow();
  });

  const reasonedNone = none('registration fixture has no additional obligations');
  const completeContract = (overrides: Partial<ActionContract> = {}): ActionContract => ({
    requires: reasonedNone,
    ensures: reasonedNone,
    needs: reasonedNone,
    touches: { frame: 'single-machine', resources: reasonedNone },
    executionAuthority: { kind: 'local' },
    replay: { kind: 'claim-required', scope: 'stream-subject-request' },
    emissions: reasonedNone,
    ...overrides,
  });

  it('ValidateAction_MissingContract_FailsAtLoad', () => {
    expect(() =>
      validateAction(
        {
          name: 'probe',
          outputSchema: z.object({ success: z.boolean() }),
          annotations: validAnnotations,
        },
        'exarchos_workflow',
        'load',
      ),
    ).toThrow(ActionContractError);
  });

  it('ValidateAction_MissingContract_FailsAtRegistration', () => {
    expect(() =>
      validateAction(
        {
          name: 'probe',
          outputSchema: z.object({ success: z.boolean() }),
          annotations: validAnnotations,
        },
        'exarchos_custom',
        'registration',
      ),
    ).toThrow(ActionContractError);
    try {
      validateAction(
        {
          name: 'probe',
          outputSchema: z.object({ success: z.boolean() }),
          annotations: validAnnotations,
        },
        'exarchos_custom',
        'registration',
      );
      expect.fail('expected missing actionContract to fail registration');
    } catch (error) {
      expect(error).toBeInstanceOf(ActionContractError);
      expect((error as ActionContractError).code).toBe('MISSING_DIMENSION');
      expect((error as Error).message).toMatch(/exarchos_custom\.probe/);
      expect((error as Error).message).toMatch(/actionContract/);
    }
  });

  it('ReplayPolicy_AnnotationDisagreement_IsRejected', () => {
    const readOnlyIdempotent: ActionAnnotations = {
      safety: 'read-only',
      readOnly: true,
      destructive: false,
      idempotent: true,
      openWorld: false,
    };
    expect(() =>
      validateAction(
        {
          name: 'probe',
          outputSchema: z.object({ success: z.boolean() }),
          annotations: readOnlyIdempotent,
          actionContract: completeContract({
            replay: { kind: 'claim-required', scope: 'stream-subject-request' },
          }),
        },
        'exarchos_custom',
        'registration',
      ),
    ).toThrow(ActionContractError);
    try {
      validateAction(
        {
          name: 'probe',
          outputSchema: z.object({ success: z.boolean() }),
          annotations: validAnnotations,
          actionContract: completeContract({ replay: { kind: 'safe-repeat' } }),
        },
        'exarchos_custom',
        'registration',
      );
      expect.fail('expected safe-repeat without idempotent to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(ActionContractError);
      expect((error as ActionContractError).code).toBe('REPLAY_ANNOTATION_DISAGREEMENT');
    }
  });

  it('DescribeFactory_EmitsCompleteContract', () => {
    const factories = [
      makeDescribeAction('exarchos_view.describe'),
      makeDescribeAction('exarchos_orchestrate.describe'),
      makeWorkflowDescribeAction('exarchos_workflow.describe'),
      makeEventDescribeAction('exarchos_event.describe'),
    ];
    for (const action of factories) {
      expect('actionContract' in action).toBe(true);
      const contract = (action as typeof action & { actionContract: ActionContract }).actionContract;
      expect(normalizeActionContract(contract, { annotations: action.annotations })).toEqual(contract);
      expect(contract.requires.kind).toBe('none');
      expect(contract.ensures.kind).toBe('none');
      expect(contract.needs.kind).toBe('none');
      expect(contract.touches.frame).toBe('single-machine');
      expect(contract.touches.resources.kind).toBe('none');
      expect(contract.executionAuthority).toEqual({ kind: 'local' });
      expect(contract.replay).toEqual({ kind: 'safe-repeat' });
      expect(contract.emissions.kind).toBe('none');
    }
  });
});

/**
 * `dispatch` is an optional, advisory block on the action descriptor, beside `cli` and `gate`.
 * It is not under `cli`, because the CLI and MCP adapters share the dispatch core.
 * Each test builds a `ToolAction` literal and reads it back.
 * No typecheck program includes `tests/unit`, so these tests do not prove the declared type of the field.
 */
describe('ToolAction.dispatch - DispatchHints shape', () => {
  it('ToolAction_DispatchHintsShape_OptionalTaskSuitableField', () => {
    const action: ToolAction = {
      name: 'longRunningExample',
      description: 'Example long-running action for shape assertion.',
      schema: z.object({ featureId: z.string() }),
      phases: new Set(['plan']),
      roles: new Set(['lead']),
      outputSchema: z.object({ success: z.boolean() }),
      annotations: {
        safety: 'local-mutation',
        readOnly: false,
        destructive: false,
        idempotent: false,
        openWorld: false,
      },
      dispatch: {
        taskSuitable: true,
        taskTtlSuggestionMs: 60_000,
      },
    };

    expect(action.dispatch).toBeDefined();
    expect(action.dispatch?.taskSuitable).toBe(true);
    expect(action.dispatch?.taskTtlSuggestionMs).toBe(60_000);
  });

  it('ToolAction_DispatchHintsShape_FieldIsOptional', () => {
    const actionNoDispatch: ToolAction = {
      name: 'readOnlyExample',
      description: 'Example read-only action without DispatchHints.',
      schema: z.object({}),
      phases: new Set(['ideate']),
      roles: new Set(['any']),
      outputSchema: z.object({ success: z.boolean() }),
      annotations: {
        safety: 'read-only',
        readOnly: true,
        destructive: false,
        idempotent: true,
        openWorld: false,
      },
    };

    expect(actionNoDispatch.dispatch).toBeUndefined();
  });
});

/**
 * Four long-running actions must declare `dispatch: { taskSuitable: true, taskTtlSuggestionMs: 60_000 }`.
 * The actions are `merge_orchestrate`, `request_synthesize`, `cleanup` and `rehydrate`.
 * The block is advisory, so the test pins only the registry declaration and not the dispatch behavior.
 */
describe('Registry — taskSuitable annotations (T9, #1440 Op 2)', () => {
  it('Registry_TaskSuitableAnnotations_FourActionsMarked', () => {
    const orchestrateTool = TOOL_REGISTRY.find(t => t.name === 'exarchos_orchestrate');
    const workflowTool = TOOL_REGISTRY.find(t => t.name === 'exarchos_workflow');
    expect(orchestrateTool, 'exarchos_orchestrate tool must exist').toBeDefined();
    expect(workflowTool, 'exarchos_workflow tool must exist').toBeDefined();

    const targets: Array<{ tool: 'exarchos_orchestrate' | 'exarchos_workflow'; action: string }> = [
      { tool: 'exarchos_orchestrate', action: 'merge_orchestrate' },
      { tool: 'exarchos_orchestrate', action: 'request_synthesize' },
      { tool: 'exarchos_workflow', action: 'cleanup' },
      { tool: 'exarchos_workflow', action: 'rehydrate' },
    ];

    for (const { tool, action } of targets) {
      const composite = tool === 'exarchos_orchestrate' ? orchestrateTool! : workflowTool!;
      const found = composite.actions.find(a => a.name === action);
      expect(found, `${tool}.${action} must be registered`).toBeDefined();
      expect(
        found!.dispatch,
        `${tool}.${action} must carry a DispatchHints block`,
      ).toBeDefined();
      expect(
        found!.dispatch?.taskSuitable,
        `${tool}.${action} must declare taskSuitable: true`,
      ).toBe(true);
      expect(
        found!.dispatch?.taskTtlSuggestionMs,
        `${tool}.${action} must declare taskTtlSuggestionMs: 60_000`,
      ).toBe(60_000);
    }
  });
});

/**
 * `get` and `workflow_status` accept an optional `asOf` bound, and its two fields are mutually exclusive.
 * `asOf` selects the point that the projection reads and does not change the result shape.
 * Thus the output schema of each action stays a generic envelope that accepts any `data`.
 */
describe('asOf registry schema (T6, #1555)', () => {
  it('registry_getAction_asOfUntilSequence_parses', () => {
    const action = findAction('exarchos_workflow', 'get');
    expect(action).toBeDefined();
    const parsed = action!.schema.safeParse({
      featureId: 'my-feature',
      asOf: { untilSequence: 4 },
    });
    expect(parsed.success).toBe(true);
  });

  it('registry_getAction_asOfBothBounds_rejects', () => {
    const action = findAction('exarchos_workflow', 'get');
    const parsed = action!.schema.safeParse({
      featureId: 'my-feature',
      asOf: { untilSequence: 4, untilTimestamp: '2026-06-20T00:00:00.000Z' },
    });
    expect(parsed.success).toBe(false);
  });

  it('registry_workflowStatusAction_asOfUntilSequence_parses', () => {
    const action = findAction('exarchos_view', 'workflow_status');
    expect(action).toBeDefined();
    const parsed = action!.schema.safeParse({
      workflowId: 'my-feature',
      asOf: { untilSequence: 4 },
    });
    expect(parsed.success).toBe(true);
  });

  it('registry_getAction_outputSchemaUnchanged', () => {
    const action = findAction('exarchos_workflow', 'get');
    expect(action!.outputSchema).toBeDefined();
    const envelope = wrap({ phase: 'ideate' }, {}, { ms: 1 }, []);
    expect(action!.outputSchema!.safeParse(envelope).success).toBe(true);
  });

  it('registry_workflowStatusAction_outputSchemaUnchanged', () => {
    const action = findAction('exarchos_view', 'workflow_status');
    expect(action!.outputSchema).toBeDefined();
    const envelope = wrap({ phase: 'ideate', tasksTotal: 0 }, {}, { ms: 1 }, []);
    expect(action!.outputSchema!.safeParse(envelope).success).toBe(true);
  });
});

/**
 * The `exarchos <harness>` launcher is a CLI-only verb, because the stdio MCP surface cannot own the lifecycle of a child process.
 * Thus its schema constraints and its when-not-to-use clauses are on the verb module and not in `TOOL_REGISTRY`.
 * The verb must add no visible MCP tool. A named Windows CI lane must run its tests that are fragile on win32.
 */
describe('harness-launcher verb conformance + Windows CI lane (task 015, DR-1/DR-8)', () => {
  /**
   * The constraints must name the schema fields `harness`, `feature` and `dryRun`, and each Tier-1 harness.
   * Thus the documented `harness` constraint cannot drift from the enum.
   * They must also name `validTargets`, which the error for an unknown harness carries.
   */
  it('Verb_SchemaConstraints_Present', () => {
    const { schemaConstraints } = LAUNCHER_VERB_CONFORMANCE;
    expect(Array.isArray(schemaConstraints)).toBe(true);
    expect(schemaConstraints.length).toBeGreaterThan(0);

    for (const constraint of schemaConstraints) {
      expect(typeof constraint).toBe('string');
      expect(constraint.trim().length).toBeGreaterThan(0);
    }

    const joined = schemaConstraints.join('\n');
    expect(joined).toContain('harness');
    expect(joined).toContain('feature');
    expect(joined).toContain('dryRun');

    for (const harness of TIER1_HARNESSES) {
      expect(joined).toContain(harness);
    }
    expect(joined).toContain('validTargets');
  });

  /**
   * Each clause must hold the words "do not use".
   * The clauses must name `serialize_merge` for integration merges, and `adopt` for the nested worktrees that a harness creates.
   * They must also name the `generic` runtime, which has no process to start.
   */
  it('Verb_WhenNotToUse_Present', () => {
    const { whenNotToUse } = LAUNCHER_VERB_CONFORMANCE;
    expect(Array.isArray(whenNotToUse)).toBe(true);
    expect(whenNotToUse.length).toBeGreaterThan(0);

    for (const clause of whenNotToUse) {
      expect(typeof clause).toBe('string');
      expect(clause.toLowerCase()).toContain('do not use');
    }

    const joined = whenNotToUse.join('\n');
    expect(joined).toContain('serialize_merge');
    expect(joined).toContain('adopt');
    expect(joined.toLowerCase()).toContain('generic');
  });

  /**
   * The registry must still hold four visible tools.
   * It must hold no tool and no action named `launch`, `launcher`, the launcher verb or a Tier-1 harness.
   */
  it('VisibleToolCount_Unchanged', () => {
    const visibleTools = TOOL_REGISTRY.filter((t) => !t.hidden);
    expect(visibleTools.length).toBe(4);
    expect(visibleTools.map((t) => t.name).sort()).toEqual([
      'exarchos_event',
      'exarchos_orchestrate',
      'exarchos_view',
      'exarchos_workflow',
    ]);
    expect(TOOL_REGISTRY).toHaveLength(5);

    const allNames = TOOL_REGISTRY.flatMap((t) => [
      t.name,
      ...t.actions.map((a) => a.name),
    ]);
    const forbidden = [
      'launch',
      'launcher',
      LAUNCHER_VERB_CONFORMANCE.verb,
      ...TIER1_HARNESSES,
    ];
    for (const name of forbidden) {
      expect(allNames).not.toContain(name);
    }
  });

  /**
   * Parses `.github/workflows/ci.yml` and asserts that one Windows job names the two test files that are fragile on win32.
   * A job that only runs the full suite does not count, so a path filter that drops one file fails here.
   * The path to `ci.yml` resolves from this file, so the working directory of the runner does not matter.
   * Branch protection decides if the lane is required. That setting is outside the repository, and this test cannot assert it.
   */
  it('WindowsLane_RunsNamedSpawnAndPathTests_Required', () => {
    const SPAWN_TEST = 'tests/unit/utils/process.spawn.test.ts';
    const PATH_TEST = 'tests/unit/runtime/launcher/topology.test.ts';

    const here = dirname(fileURLToPath(import.meta.url));
    const ciPath = resolve(here, '../../.github/workflows/ci.yml');
    const raw = readFileSync(ciPath, 'utf8');

    const parsed: unknown = parseYaml(raw);
    expect(parsed !== null && typeof parsed === 'object').toBe(true);
    const doc = parsed as Record<string, unknown>;
    const jobs = doc.jobs;
    expect(jobs !== null && typeof jobs === 'object').toBe(true);
    const jobsMap = jobs as Record<string, unknown>;

    const windowsJobs = Object.entries(jobsMap).filter(([, job]) => {
      if (job === null || typeof job !== 'object') return false;
      const runsOn = (job as Record<string, unknown>)['runs-on'];
      return typeof runsOn === 'string' && runsOn.includes('windows');
    });
    expect(
      windowsJobs.length,
      'ci.yml must wire at least one windows-latest lane',
    ).toBeGreaterThan(0);

    const jobNamesBothTests = windowsJobs.filter(([, job]) => {
      const steps = (job as Record<string, unknown>).steps;
      const serialized = JSON.stringify(steps ?? job);
      return serialized.includes(SPAWN_TEST) && serialized.includes(PATH_TEST);
    });
    expect(
      jobNamesBothTests.length,
      `a windows-latest lane must reference BOTH ${SPAWN_TEST} and ${PATH_TEST} by name`,
    ).toBeGreaterThan(0);
  });
});

/**
 * The effective response budget of each action, in tokens.
 * The key is `<tool>.<action>`, because an action name such as `describe` repeats across tools.
 * A new action, a removed action or a changed budget shows as a diff against this table.
 * Before you update the table, make sure that the change is intended.
 */
const EXPECTED_EFFECTIVE_BUDGETS: Readonly<Record<string, number>> = {
  'exarchos_workflow.init': 2000,
  'exarchos_workflow.get': 2000,
  'exarchos_workflow.transition': 2000,
  'exarchos_workflow.update': 2000,
  'exarchos_workflow.cancel': 2000,
  'exarchos_workflow.cleanup': 2000,
  'exarchos_workflow.reconcile': 2000,
  'exarchos_workflow.rehydrate': 2000,
  'exarchos_workflow.checkpoint': 2000,
  'exarchos_workflow.feedback': 2000,
  'exarchos_workflow.describe': 8000,
  'exarchos_event.append': 2000,
  'exarchos_event.query': 2000,
  'exarchos_event.batch_append': 2000,
  'exarchos_event.describe': 12000,
  'exarchos_orchestrate.task_claim': 2000,
  'exarchos_orchestrate.task_complete': 2000,
  'exarchos_orchestrate.task_fail': 2000,
  'exarchos_orchestrate.review_triage': 2000,
  'exarchos_orchestrate.prepare_delegation': 2000,
  'exarchos_orchestrate.prepare_synthesis': 2000,
  'exarchos_orchestrate.assess_stack': 2000,
  'exarchos_orchestrate.check_static_analysis': 2000,
  'exarchos_orchestrate.check_integration_suite': 2000,
  'exarchos_orchestrate.check_security_scan': 2000,
  'exarchos_orchestrate.check_context_economy': 2000,
  'exarchos_orchestrate.check_operational_resilience': 2000,
  'exarchos_orchestrate.check_workflow_determinism': 2000,
  'exarchos_orchestrate.check_review_verdict': 2000,
  'exarchos_orchestrate.check_convergence': 2000,
  'exarchos_orchestrate.check_provenance_chain': 2000,
  'exarchos_orchestrate.check_design_completeness': 2000,
  'exarchos_orchestrate.check_plan_coverage': 2000,
  'exarchos_orchestrate.check_exploration_depth': 2000,
  'exarchos_orchestrate.check_test_adequacy': 2000,
  'exarchos_orchestrate.check_contract_drift': 2000,
  'exarchos_orchestrate.check_mock_boundary': 2000,
  'exarchos_orchestrate.mutation-adequacy': 2000,
  'exarchos_orchestrate.check_post_merge': 2000,
  'exarchos_orchestrate.merge_orchestrate': 2000,
  'exarchos_orchestrate.check_task_decomposition': 2000,
  'exarchos_orchestrate.check_event_emissions': 2000,
  'exarchos_orchestrate.extract_task': 2000,
  'exarchos_orchestrate.review_diff': 2000,
  'exarchos_orchestrate.verify_worktree': 2000,
  'exarchos_orchestrate.select_debug_track': 2000,
  'exarchos_orchestrate.investigation_timer': 2000,
  'exarchos_orchestrate.check_coverage_thresholds': 2000,
  'exarchos_orchestrate.assess_refactor_scope': 2000,
  'exarchos_orchestrate.check_pr_comments': 2000,
  'exarchos_orchestrate.validate_pr_body': 2000,
  'exarchos_orchestrate.validate_pr_stack': 2000,
  'exarchos_orchestrate.debug_review_gate': 2000,
  'exarchos_orchestrate.extract_fix_tasks': 2000,
  'exarchos_orchestrate.classify_review_items': 2000,
  'exarchos_orchestrate.generate_traceability': 2000,
  'exarchos_orchestrate.spec_coverage_check': 2000,
  'exarchos_orchestrate.verify_worktree_baseline': 2000,
  'exarchos_orchestrate.setup_worktree': 2000,
  'exarchos_orchestrate.verify_delegation_saga': 2000,
  'exarchos_orchestrate.post_delegation_check': 2000,
  'exarchos_orchestrate.reconcile_state': 2000,
  'exarchos_orchestrate.reconcile_worktrees': 2000,
  'exarchos_orchestrate.stack_place': 2000,
  'exarchos_orchestrate.reconcile_worktrees': 2000,
  'exarchos_orchestrate.stack_place': 2000,
  'exarchos_orchestrate.pre_synthesis_check': 2000,
  'exarchos_orchestrate.check_coderabbit': 2000,
  'exarchos_orchestrate.check_polish_scope': 2000,
  'exarchos_orchestrate.needs_schema_sync': 2000,
  'exarchos_orchestrate.verify_doc_links': 2000,
  'exarchos_orchestrate.verify_review_triage': 2000,
  'exarchos_orchestrate.check_invariant_conformance': 2000,
  'exarchos_orchestrate.prepare_review': 2000,
  'exarchos_orchestrate.discover_bridge': 2000,
  'exarchos_orchestrate.prune_stale_workflows': 2000,
  'exarchos_orchestrate.request_synthesize': 2000,
  'exarchos_orchestrate.finalize_oneshot': 2000,
  'exarchos_orchestrate.runbook': 4000,
  'exarchos_orchestrate.agent_spec': 2000,
  'exarchos_orchestrate.doctor': 2000,
  'exarchos_orchestrate.create_pr': 2000,
  'exarchos_orchestrate.merge_pr': 2000,
  'exarchos_orchestrate.check_ci': 2000,
  'exarchos_orchestrate.list_prs': 2000,
  'exarchos_orchestrate.get_pr_comments': 2000,
  'exarchos_orchestrate.add_pr_comment': 2000,
  'exarchos_orchestrate.create_issue': 2000,
  'exarchos_orchestrate.onboard': 2000,
  'exarchos_orchestrate.invariants_scaffold': 2000,
  'exarchos_orchestrate.invariants_add': 2000,
  'exarchos_orchestrate.invariants_amend': 2000,
  'exarchos_orchestrate.acquire_worktree': 2000,
  'exarchos_orchestrate.release_worktree': 2000,
  'exarchos_orchestrate.prune_worktrees': 2000,
  'exarchos_orchestrate.serialize_merge': 2000,
  'exarchos_orchestrate.cutover_readiness': 2000,
  'exarchos_orchestrate.cutover_decide': 2000,
  'exarchos_orchestrate.execute_intent': 1000,
  'exarchos_orchestrate.prepare': 8000,
  'exarchos_orchestrate.settle': 1000,
  'exarchos_orchestrate.describe': 8000,
  'exarchos_view.pipeline': 2000,
  'exarchos_view.tasks': 2000,
  'exarchos_view.workflow_status': 2000,
  'exarchos_view.stack_status': 2000,
  'exarchos_view.telemetry': 2000,
  'exarchos_view.team_performance': 2000,
  'exarchos_view.delegation_timeline': 2000,
  'exarchos_view.code_quality': 2000,
  'exarchos_view.eval_results': 2000,
  'exarchos_view.quality_correlation': 2000,
  'exarchos_view.quality_attribution': 2000,
  'exarchos_view.delegation_readiness': 2000,
  'exarchos_view.session_provenance': 2000,
  'exarchos_view.provenance': 2000,
  'exarchos_view.synthesis_readiness': 2000,
  'exarchos_view.shepherd_status': 2000,
  'exarchos_view.convergence': 2000,
  'exarchos_view.gate_reliability': 2000,
  'exarchos_view.quality_hints': 2000,
  'exarchos_view.invariants_effective': 2000,
  'exarchos_view.worktrees': 2000,
  'exarchos_view.ps': 2000,
  'exarchos_view.wait': 2000,
  'exarchos_view.inspect': 2000,
  'exarchos_view.export': 2000,
  'exarchos_view.describe': 8000,
  'exarchos_sync.now': 2000,
};

/** Builds the effective-budget map from the live registry, keyed by `<tool>.<action>`. */
function buildEffectiveBudgetMap(): Record<string, number> {
  const map: Record<string, number> = {};
  for (const tool of TOOL_REGISTRY) {
    for (const action of tool.actions) {
      map[`${tool.name}.${action.name}`] = resolveEconomyBudget(action);
    }
  }
  return map;
}

/**
 * Each action resolves a concrete response budget: its declared `economy.budgetTokens` or the registry default.
 * These tests do not cover the enforcement of the budget at dispatch.
 */
describe('registry economy budgets (DR-1)', () => {
  /**
   * Each budget must also be a finite, positive number.
   * The dispatch seam fails open on a budget that is not, so the registry must not hold one.
   */
  it('registryEconomy_BudgetSnapshot_PinsEffectiveBudgetPerAction', () => {
    const actual = buildEffectiveBudgetMap();

    expect(actual).toEqual(EXPECTED_EFFECTIVE_BUDGETS);

    for (const [key, budget] of Object.entries(actual)) {
      expect(
        Number.isFinite(budget) && budget > 0,
        `${key} resolved a non-finite / non-positive budget: ${budget}`,
      ).toBe(true);
    }
  });

  /**
   * Each `describe` action and `runbook` must declare an explicit budget above the default.
   * The event `describe` budget must exceed the base `describe` budget, because its `emissionGuide` parameter returns the full event catalog.
   * The last assertion pins the full list of actions that declare an economy block, so a new declaration fails here.
   */
  it('registryEconomy_VerboseByDesignAllowlist_DeclaresExplicitHigherBudget', () => {
    const findAction = (tool: string, action: string): ToolAction => {
      const found = TOOL_REGISTRY.find((t) => t.name === tool)?.actions.find(
        (a) => a.name === action,
      );
      expect(found, `${tool}.${action} must exist`).toBeDefined();
      return found as ToolAction;
    };

    const verbose: ReadonlyArray<{ tool: string; action: string; expected: number }> = [
      { tool: 'exarchos_workflow', action: 'describe', expected: DESCRIBE_ECONOMY_BUDGET_TOKENS },
      { tool: 'exarchos_orchestrate', action: 'describe', expected: DESCRIBE_ECONOMY_BUDGET_TOKENS },
      { tool: 'exarchos_view', action: 'describe', expected: DESCRIBE_ECONOMY_BUDGET_TOKENS },
      { tool: 'exarchos_event', action: 'describe', expected: EVENT_DESCRIBE_ECONOMY_BUDGET_TOKENS },
      { tool: 'exarchos_orchestrate', action: 'runbook', expected: RUNBOOK_ECONOMY_BUDGET_TOKENS },
    ];

    for (const { tool, action, expected } of verbose) {
      const a = findAction(tool, action);
      expect(
        a.economy?.budgetTokens,
        `${tool}.${action} must declare an explicit economy.budgetTokens`,
      ).toBe(expected);
      expect(
        resolveEconomyBudget(a),
        `${tool}.${action} must resolve above the default`,
      ).toBeGreaterThan(DEFAULT_ECONOMY_BUDGET_TOKENS);
    }

    expect(EVENT_DESCRIBE_ECONOMY_BUDGET_TOKENS).toBeGreaterThan(DESCRIBE_ECONOMY_BUDGET_TOKENS);

    const declared = TOOL_REGISTRY.flatMap((t) =>
      t.actions
        .filter((a) => a.economy !== undefined)
        .map((a) => `${t.name}.${a.name}`),
    ).sort();
    expect(declared).toEqual(
      [
        'exarchos_event.describe',
        'exarchos_orchestrate.describe',
        'exarchos_orchestrate.execute_intent',
        'exarchos_orchestrate.prepare',
        'exarchos_orchestrate.runbook',
        'exarchos_orchestrate.settle',
        'exarchos_view.describe',
        'exarchos_workflow.describe',
      ].sort(),
    );
  });

  /**
   * These two actions declare a budget below the default, as a ceiling measured on a real response.
   * Each one also declares a `summarize` function and does not use the generic capped fallback.
   * The names are literals, because no predicate on a declaration can tell that a budget was measured.
   */
  it.each(['execute_intent', 'settle'])(
    'registryEconomy_%s_DeclaresAMeasuredBudgetAndARealSummarizer',
    (name) => {
      const action = TOOL_REGISTRY.find((t) => t.name === 'exarchos_orchestrate')?.actions.find(
        (a) => a.name === name,
      );
      expect(action).toBeDefined();
      expect(action?.economy?.budgetTokens).toBeLessThan(DEFAULT_ECONOMY_BUDGET_TOKENS);
      expect(resolveEconomyBudget(action as ToolAction)).toBe(action?.economy?.budgetTokens);
      expect(typeof action?.economy?.summarize).toBe('function');
    },
  );

  /** `describe` shows the declared budget of a verbose action and the registry default of any other action. */
  it('describeAction_WithBudget_SurfacesBudgetTokens', async () => {
    const orchestrate = TOOL_REGISTRY.find((t) => t.name === 'exarchos_orchestrate')!;
    const result = await handleDescribe(
      { actions: ['describe', 'runbook', 'task_claim'] },
      orchestrate.actions,
    );

    expect(result.success).toBe(true);
    if (!result.success) return;
    const data = result.data as Record<string, { economyBudgetTokens?: unknown }>;

    expect(data.describe.economyBudgetTokens).toBe(DESCRIBE_ECONOMY_BUDGET_TOKENS);
    expect(data.runbook.economyBudgetTokens).toBe(RUNBOOK_ECONOMY_BUDGET_TOKENS);
    expect(data.task_claim.economyBudgetTokens).toBe(DEFAULT_ECONOMY_BUDGET_TOKENS);

    const taskClaim = orchestrate.actions.find((a) => a.name === 'task_claim')!;
    expect(data.task_claim.economyBudgetTokens).toBe(resolveEconomyBudget(taskClaim));
  });
});

/**
 * Covers the input parameters of the response-economy work and the capped output shape.
 * The schemas declare the parameters, so the CLI builds a flag for each one.
 * Each action with a typed `data` output schema must accept its baseline shape and the capped shape `{summary, counts, firstPage}`.
 *
 * `typedOutputActions` lists the actions whose success `data` is typed.
 * `cappedData` and the cutover fixtures are literals, because a fixture that derives from the schema under test cannot disagree with it.
 * Each disagreement tally holds all five classes, because the contract declares them exhaustively.
 * `baselineDataByAction` holds, for each typed action, the smallest `data` that the action really emits.
 */
describe('Task 022 — registry schema batch (DR-1/DR-3/DR-8)', () => {
  function findAction(toolName: string, actionName: string): ToolAction {
    const tool = TOOL_REGISTRY.find((t) => t.name === toolName);
    const action = tool?.actions.find((a) => a.name === actionName);
    if (action === undefined) throw new Error(`action '${toolName}.${actionName}' not registered`);
    return action;
  }

  function typedOutputActions(): Array<{ tool: string; action: ToolAction }> {
    const out: Array<{ tool: string; action: ToolAction }> = [];
    for (const tool of TOOL_REGISTRY) {
      for (const action of tool.actions) {
        if (envelopeDataSchemaIsTyped(action.outputSchema)) {
          out.push({ tool: tool.name, action });
        }
      }
    }
    return out;
  }

  const cappedData = {
    summary: 'Response exceeded budget — showing counts + first page.',
    counts: { pending: 12, done: 3 },
    firstPage: [{ id: 'a' }, { id: 'b' }],
  };
  function cappedEnvelope(): Record<string, unknown> {
    return {
      success: true,
      data: { ...cappedData },
      next_actions: [],
      _meta: { truncated: true },
      _perf: { ms: 0, bytes: 0, tokens: 0 },
    };
  }

  const emptyDisagreementTally = {
    'agree': 0,
    'legacy-allow-admission-deny': 0,
    'legacy-deny-admission-allow': 0,
    'admission-indeterminate': 0,
    'shadow-error': 0,
  };
  const cutoverGateReport = {
    satisfied: false,
    conditions: [
      { id: 'live-observer-health', met: false, detail: 'no attempts observed' },
    ],
    unmet: ['live-observer-health'],
    unexplainedDisagreements: 0,
    liveAttemptCount: 0,
    comparableLiveAttemptCount: 0,
    nonComparableLiveAttemptCount: 0,
    liveDisagreementClasses: { ...emptyDisagreementTally },
    durableAttemptCount: 0,
    nonComparableDurableAttemptCount: 0,
    durableDisagreementClasses: { ...emptyDisagreementTally },
    observerStatus: 'unobserved',
    coveredPhaseKinds: [],
    missingPhaseKinds: ['IMPLEMENT'],
    hasAllowOutcome: false,
    hasDenyOutcome: false,
  };
  const cutoverDurableEvidence = {
    featureIds: [],
    attemptCount: 0,
    dispositionTally: {},
  };

  const baselineDataByAction: Record<string, Record<string, unknown>> = {
    'exarchos_orchestrate.acquire_worktree': {
      worktreeId: 'wt', path: '/tmp/wt', featureId: null, reserved: true, adopted: true,
    },
    'exarchos_orchestrate.release_worktree': { worktreeId: 'wt', released: true },
    'exarchos_orchestrate.prune_worktrees': {
      dryRun: true, candidates: [], deleted: [], reclaimableBytes: 0, skipsByReason: {},
    },
    'exarchos_orchestrate.serialize_merge': {
      dryRun: true, integrationRef: 'main', sourceBranch: 'feat/x', strategy: 'squash',
      featureId: 'f', integrationHead: null,
    },
    'exarchos_view.telemetry': {
      session: { start: '2026-01-01T00:00:00Z', totalInvocations: 0, totalTokens: 0 },
      tools: [], hints: [],
    },
    'exarchos_view.worktrees': { worktrees: [], count: 0 },
    'exarchos_view.ps': {
      inFlight: [], count: 0, launches: [], launchCount: 0, prunes: [], pruneCount: 0,
    },
    'exarchos_view.wait': { resolved: true, waitedMs: 5 },
    'exarchos_orchestrate.reconcile_worktrees': {
      probe: {}, reconcile: {}, mergeReconcile: {},
      inFlight: [], count: 0, launches: [], launchCount: 0, prunes: [], pruneCount: 0,
    },
    'exarchos_orchestrate.stack_place': {
      streamId: 'f', sequence: 1, type: 'stack.position-filled',
    },
    'exarchos_view.inspect': {
      featureId: 'f', workflowExists: false, recentEvents: [], eventCount: 0,
    },
    'exarchos_view.export': {
      featureId: 'f', workflowExists: false, exported: false,
    },
    'exarchos_orchestrate.invariants_amend': {
      committed: false, id: 'INV-17', tier: 'dev',
      catalog: '.exarchos/invariants.md', patchedFields: ['summary'],
      next_actions: [],
    },
    'exarchos_orchestrate.check_invariant_conformance': {
      verdict: 'APPROVED', high: 0, medium: 0, low: 0, findings: [],
      auditPrompt: '', auditInvariantIds: [], auditProjection: 'no-audit-entries',
      applicableCount: 0, report: 'PASS',
    },
    'exarchos_orchestrate.cutover_readiness': {
      report: cutoverGateReport,
      durableEvidence: cutoverDurableEvidence,
    },
    'exarchos_orchestrate.cutover_decide': {
      outcome: 'continue-shadow',
      rolloutDecisionId: 'rollout-decision:abc',
      enablementId: 'enforcement-enabled:abc',
      report: cutoverGateReport,
      durableEvidence: cutoverDurableEvidence,
    },
    'exarchos_orchestrate.execute_intent': {
      operationId: 'op-1', intent: 'task-completion', outcome: 'committed',
      leaves: [], tailSequence: 0, requestDigest: `sha256:${'a'.repeat(64)}`,
      interaction: { leavesExecuted: 0, eventsAppended: 0, requests: 1, deferred: [] },
    },
    'exarchos_orchestrate.settle': {
      operationId: 'op-1', streamId: 'feat-x',
      capsule: {
        workflowId: 'wf-1', definitionVersion: 'a'.repeat(64), designVersion: 'design-1',
        capsuleVersion: 1, batchId: 'batch-0001',
      },
      outcome: 'settled', acceptedTasks: [], findings: [],
      adjudicated: { claims: 0, requiredResults: 0, fields: 0, evidence: 0, deviations: 0 },
      requestDigest: `sha256:${'a'.repeat(64)}`, tailSequence: 0,
    },
    'exarchos_orchestrate.prepare': {
      operationId: `prepare:${'a'.repeat(64)}`, streamId: 'feat-x', workflowId: 'feat-x',
      capsuleVersion: 1, capsuleDigest: 'a'.repeat(64), definitionVersion: 'a'.repeat(64),
      capsule: {}, tailSequence: 0,
    },
  };
  function baselineEnvelope(data: Record<string, unknown>): Record<string, unknown> {
    return {
      success: true,
      data,
      next_actions: [],
      _meta: {},
      _perf: { ms: 0, bytes: 0, tokens: 0 },
    };
  }

  describe('registrySchemas_EconomyParams_ValidateAndCoerce', () => {
    /** `limit` and `offset` arrive as numeric strings, and `fields` arrives as a JSON array string. */
    it('get_pr_comments declares and coerces limit/offset/fields', () => {
      const schema = findAction('exarchos_orchestrate', 'get_pr_comments').schema;
      const parsed = schema.safeParse({
        prId: '42',
        limit: '20',
        offset: '5',
        fields: '["body","author"]',
      });
      expect(parsed.success).toBe(true);
      if (!parsed.success) return;
      const data = parsed.data as Record<string, unknown>;
      expect(data.limit).toBe(20);
      expect(data.offset).toBe(5);
      expect(data.fields).toEqual(['body', 'author']);
    });

    /**
     * `prNumbers` must coerce from a JSON array string, from an array of numeric strings and from a bare CSV string.
     * `coerceFlags` gives the CSV form for an array flag, and a direct MCP caller can also send it.
     */
    it('assess_stack declares comment paging and coerces prNumbers as an int array', () => {
      const schema = findAction('exarchos_orchestrate', 'assess_stack').schema;
      const fromJsonString = schema.safeParse({
        featureId: 'feat-x',
        prNumbers: '[1660,1671]',
        limit: '10',
        offset: '2',
      });
      expect(fromJsonString.success).toBe(true);
      if (fromJsonString.success) {
        const data = fromJsonString.data as Record<string, unknown>;
        expect(data.prNumbers).toEqual([1660, 1671]);
        expect(data.limit).toBe(10);
        expect(data.offset).toBe(2);
      }
      const fromStringElements = schema.safeParse({
        featureId: 'feat-x',
        prNumbers: ['1', '2', '3'],
      });
      expect(fromStringElements.success).toBe(true);
      if (fromStringElements.success) {
        expect((fromStringElements.data as Record<string, unknown>).prNumbers).toEqual([1, 2, 3]);
      }
      const fromCsv = schema.safeParse({ featureId: 'feat-x', prNumbers: '1660,1671,1659' });
      expect(fromCsv.success).toBe(true);
      if (fromCsv.success) {
        expect((fromCsv.data as Record<string, unknown>).prNumbers).toEqual([1660, 1671, 1659]);
      }
    });

    it('check_coderabbit prNumbers routes through the same coerced int-array', () => {
      const schema = findAction('exarchos_orchestrate', 'check_coderabbit').schema;
      const parsed = schema.safeParse({ owner: 'acme', repo: 'app', prNumbers: ['1', '2'] });
      expect(parsed.success).toBe(true);
      if (parsed.success) {
        expect((parsed.data as Record<string, unknown>).prNumbers).toEqual([1, 2]);
      }
      const fromCsv = schema.safeParse({ owner: 'acme', repo: 'app', prNumbers: '1,2' });
      expect(fromCsv.success).toBe(true);
      if (fromCsv.success) {
        expect((fromCsv.data as Record<string, unknown>).prNumbers).toEqual([1, 2]);
      }
    });

    /**
     * The handler reads `detail` and `outputFormat`, so the schema must declare both.
     * Zod strips an undeclared field on the MCP path, and the CLI builds no flag for it.
     * An omitted `outputFormat` takes the schema default `full`.
     */
    it('prepare_delegation declares the DR-4 detail/outputFormat escape hatch', () => {
      const schema = findAction('exarchos_orchestrate', 'prepare_delegation').schema;

      const withDetail = schema.safeParse({ featureId: 'feat-x', detail: true });
      expect(withDetail.success, 'detail:true must survive schema parse').toBe(true);
      if (withDetail.success) {
        expect((withDetail.data as Record<string, unknown>).detail).toBe(true);
      }

      const withPromptOnly = schema.safeParse({ featureId: 'feat-x', outputFormat: 'prompt-only' });
      expect(withPromptOnly.success, "outputFormat:'prompt-only' must survive schema parse").toBe(true);
      if (withPromptOnly.success) {
        expect((withPromptOnly.data as Record<string, unknown>).outputFormat).toBe('prompt-only');
      }

      const omitted = schema.safeParse({ featureId: 'feat-x' });
      expect(omitted.success).toBe(true);
      if (omitted.success) {
        expect((omitted.data as Record<string, unknown>).outputFormat).toBe('full');
      }

      const invalid = schema.safeParse({ featureId: 'feat-x', outputFormat: 'verbose' });
      expect(invalid.success).toBe(false);
    });

    /** Each listed view action must keep `detail` and its paging fields after the parse. Zod drops a field that the schema does not declare. */
    it('DR-8 view batch declares detail + paging inputs', () => {
      const cases: Array<[string, Record<string, unknown>, string[]]> = [
        ['tasks', { detail: true, limit: '5', offset: '1' }, ['detail', 'limit', 'offset']],
        ['workflow_status', { detail: true, limit: '5', offset: '1' }, ['detail', 'limit', 'offset']],
        ['stack_status', { detail: true }, ['detail']],
        ['team_performance', { detail: true, limit: '5', offset: '1' }, ['detail', 'limit', 'offset']],
        ['delegation_timeline', { detail: true, limit: '5', offset: '1' }, ['detail', 'limit', 'offset']],
        ['telemetry', { detail: true, offset: '1' }, ['detail', 'offset']],
        ['code_quality', { detail: true, offset: '1' }, ['detail', 'offset']],
        ['eval_results', { detail: true, offset: '1' }, ['detail', 'offset']],
        ['quality_correlation', { detail: true, limit: '5', offset: '1' }, ['detail', 'limit', 'offset']],
        ['quality_attribution', { detail: true, limit: '5', offset: '1' }, ['detail', 'limit', 'offset']],
        ['convergence', { detail: true, limit: '5', offset: '1' }, ['detail', 'limit', 'offset']],
      ];
      for (const [name, input, expectedKeys] of cases) {
        const schema = findAction('exarchos_view', name).schema;
        const parsed = schema.safeParse(input);
        expect(parsed.success, `${name} must accept detail + paging`).toBe(true);
        if (!parsed.success) continue;
        const data = parsed.data as Record<string, unknown>;
        for (const key of expectedKeys) {
          expect(data[key], `${name}.${key} must be declared (retained after parse)`).toBeDefined();
        }
        expect(data.detail).toBe(true);
      }
    });
  });

  describe('registrySchemas_TypedOutputActions_AcceptCappedShape', () => {
    /**
     * Pins the count of typed-output actions, so a new typed action or a lost one fails here.
     * A schema whose `data` is `z.unknown()`, such as the workflow output schemas, does not count as typed.
     * The count grows when a new action declares its `data`, or when an action leaves the vacuity allowlist.
     */
    it('every typed-output action validates a {summary,counts,firstPage} capped envelope', () => {
      const actions = typedOutputActions();
      expect(actions.length).toBe(19);
      for (const { tool, action } of actions) {
        const parsed = action.outputSchema.safeParse(cappedEnvelope());
        expect(
          parsed.success,
          `${tool}.${action.name} must accept the capped shape: ${
            parsed.success ? '' : JSON.stringify(parsed.error.issues)
          }`,
        ).toBe(true);
      }
    });
  });

  describe('registrySchemas_TypedOutputActions_SchemaTotalOverEmittableShapes', () => {
    /** Each typed action needs a fixture in `baselineDataByAction`. Its schema must accept the baseline envelope and the capped envelope. */
    it('every typed-output action admits BOTH its baseline and the capped shape', () => {
      const actions = typedOutputActions();
      for (const { tool, action } of actions) {
        const key = `${tool}.${action.name}`;
        const baseline = baselineDataByAction[key];
        expect(baseline, `missing baseline fixture for ${key}`).toBeDefined();

        const baselineParsed = action.outputSchema.safeParse(baselineEnvelope(baseline));
        expect(
          baselineParsed.success,
          `${key} must admit its baseline shape: ${
            baselineParsed.success ? '' : JSON.stringify(baselineParsed.error.issues)
          }`,
        ).toBe(true);

        const cappedParsed = action.outputSchema.safeParse(cappedEnvelope());
        expect(
          cappedParsed.success,
          `${key} must admit the capped shape: ${
            cappedParsed.success ? '' : JSON.stringify(cappedParsed.error.issues)
          }`,
        ).toBe(true);
      }
    });
  });

  /**
   * The first two tests use fixtures. The other tests read each emission that `TOOL_REGISTRY` declares, through `liveEmissionEdges`.
   * Thus a new action or a new declaration file is in scope with no list to update.
   *
   * The `owner` of an edge is the declaration area of its action under `src/registry/actions/`.
   * `actions/workflow.ts` is the `workflow` area. The modules under `actions/orchestrate/` and `actions/view/` are the `orchestrate` and `view` areas.
   * The area tells which module group declares the action, not which event the action emits.
   */
  describe('AutoEmission role, owner, and recovery expiry', () => {
    /**
     * The role of an edge is its declared value and does not depend on the position of the edge in a list.
     * The primary edge and the edge with no role are not recovery edges, so `validateAutoEmission` passes them.
     * The recovery edge passes because its `recoveryExpiresAt` is in the future.
     */
    it('AutoEmission_DeclaredRole_IsNotInferred', () => {
      const farFuture = '2999-01-01T00:00:00.000Z';

      const primary: AutoEmission = {
        event: 'workflow.updated',
        condition: 'always',
        role: 'primary',
        owner: 'workflow-core',
      };
      const recovery: AutoEmission = {
        event: 'workflow.updated',
        condition: 'conditional',
        role: 'recovery',
        owner: 'workflow-core',
        recoveryExpiresAt: farFuture,
      };
      const undeclared: AutoEmission = {
        event: 'workflow.updated',
        condition: 'always',
      };

      expect(primary.role).toBe('primary');
      expect(recovery.role).toBe('recovery');
      expect(undeclared.role).toBeUndefined();

      const forward = [primary, recovery, undeclared];
      const reversed = [...forward].reverse();
      expect(reversed.map((edge) => edge.role)).toEqual(
        [...forward.map((edge) => edge.role)].reverse(),
      );

      for (const edge of forward) {
        expect(validateAutoEmission(edge).ok).toBe(true);
      }
      for (const edge of reversed) {
        expect(validateAutoEmission(edge).ok).toBe(true);
      }
    });

    /** The same recovery edge with a future expiry must pass. Thus the failure comes from the expiry time and not from the recovery role. */
    it('AutoEmission_RecoveryEdgeWithExpiredOwner_Fails', () => {
      const expiredAt = '2000-01-01T00:00:00.000Z';
      const recovery: AutoEmission = {
        event: 'gate.executed',
        condition: 'conditional',
        role: 'recovery',
        owner: 'gate-provider-registry',
        recoveryExpiresAt: expiredAt,
      };

      const verdict = validateAutoEmission(recovery, new Date('2026-01-01T00:00:00.000Z'));

      expect(verdict.ok).toBe(false);
      expect(verdict.reason).toContain('gate.executed');
      expect(verdict.reason).toContain('gate-provider-registry');
      expect(verdict.reason).toContain(expiredAt);

      const notYetExpired: AutoEmission = {
        ...recovery,
        recoveryExpiresAt: '2999-01-01T00:00:00.000Z',
      };
      expect(validateAutoEmission(notYetExpired, new Date('2026-01-01T00:00:00.000Z')).ok).toBe(
        true,
      );
    });

    function liveEmissionEdges(): readonly {
      tool: string;
      action: string;
      emission: AutoEmission;
    }[] {
      const edges: { tool: string; action: string; emission: AutoEmission }[] = [];
      for (const tool of TOOL_REGISTRY) {
        for (const action of tool.actions) {
          for (const emission of contractEmissionsOf(action)) {
            edges.push({ tool: tool.name, action: action.name, emission });
          }
        }
      }
      return edges;
    }

    /**
     * The test first asserts a floor on the edge count, because a property over an empty edge set always passes.
     * The floor is a ratchet on the denominator and not a pin on the exact count.
     * The owner values must be exactly the declaration areas that hold emissions.
     * The shipped `validateAutoEmission` runs on each edge, so a recovery edge fails here after its declared expiry.
     */
    it('EmissionRoles_EveryLiveEdge_CarriesRoleAndOwner', () => {
      const edges = liveEmissionEdges();

      expect(
        edges.length,
        'the live emission-edge denominator collapsed — totality below would be vacuous',
      ).toBeGreaterThanOrEqual(70);
      expect(new Set(edges.map((e) => e.tool)).size).toBeGreaterThanOrEqual(2);

      const unannotated = edges
        .filter((e) => e.emission.role === undefined || e.emission.owner === undefined)
        .map(
          (e) =>
            `${e.tool}.${e.action} -> ${e.emission.event} (role=${String(
              e.emission.role,
            )}, owner=${String(e.emission.owner)})`,
        );
      expect(
        unannotated,
        `every live emission edge must declare both a role and an owner:\n${unannotated.join('\n')}`,
      ).toEqual([]);

      for (const { tool, action, emission } of edges) {
        expect(['primary', 'recovery'], `${tool}.${action} -> ${emission.event}`).toContain(
          emission.role,
        );
        expect((emission.owner ?? '').trim().length, `${tool}.${action} -> ${emission.event}`)
          .toBeGreaterThan(0);
      }

      expect([...new Set(edges.map((e) => e.emission.owner))].sort()).toEqual([
        'orchestrate',
        'view',
        'workflow',
      ]);

      const lapsed = edges
        .map((e) => ({ e, verdict: validateAutoEmission(e.emission) }))
        .filter(({ verdict }) => !verdict.ok)
        .map(({ e, verdict }) => `${e.tool}.${e.action}: ${verdict.reason ?? 'unknown'}`);
      expect(lapsed, `expired recovery edges:\n${lapsed.join('\n')}`).toEqual([]);
    });

    /**
     * More than one action can declare one event, and that is conforming.
     * The test names that set of events, so the property has a denominator.
     * An event with two routes to one meaning, such as `worktree.released`, has a declaration for each route.
     * `task.completed` is not in the set: `settle` runs `task_complete` as a leaf and does not declare the events of its leaves.
     *
     * The declarers of one event must all name one owner, or each name a different owner with at most one `primary`.
     * `gate.executed` shows many declarers in one area. `state.patched` shows two areas, where `update` is the primary edge.
     */
    it('EmissionRoles_MultiDeclarerEvent_IsConforming', () => {
      const byEvent = new Map<string, { tool: string; action: string; emission: AutoEmission }[]>();
      for (const edge of liveEmissionEdges()) {
        const bucket = byEvent.get(edge.emission.event) ?? [];
        bucket.push(edge);
        byEvent.set(edge.emission.event, bucket);
      }
      const multiDeclarer = [...byEvent].filter(([, edges]) => edges.length > 1);

      expect(multiDeclarer.map(([event]) => event).sort()).toEqual([
        'admission.evidence-recorded',
        'gate.executed',
        'onboard.executed',
        'onboard.requested',
        'state.patched',
        'task.assigned',
        'worktree.merge_executed',
        'worktree.released',
      ]);

      const violations: string[] = [];
      for (const [event, edges] of multiDeclarer) {
        const owners = edges.map((e) => e.emission.owner);
        const distinct = new Set(owners);
        if (distinct.size === 1) continue;
        if (distinct.size !== owners.length) {
          violations.push(
            `${event}: ${owners.length} edges over ${distinct.size} owners [${[...distinct].join(
              ', ',
            )}] — owners must be all-identical or all-distinct`,
          );
          continue;
        }
        const primaries = edges.filter((e) => e.emission.role === 'primary');
        if (primaries.length > 1) {
          violations.push(
            `${event}: ${primaries.length} primary edges across distinct owners [${primaries
              .map((e) => `${e.tool}.${e.action}`)
              .join(', ')}] — at most one may be primary`,
          );
        }
      }
      expect(violations, `owner-set inconsistency:\n${violations.join('\n')}`).toEqual([]);

      const gateExecuted = byEvent.get('gate.executed') ?? [];
      expect(gateExecuted).toHaveLength(23);
      expect([...new Set(gateExecuted.map((e) => e.emission.owner))]).toEqual(['orchestrate']);

      const statePatched = byEvent.get('state.patched') ?? [];
      expect(statePatched).toHaveLength(2);
      expect([...new Set(statePatched.map((e) => e.emission.owner))].sort()).toEqual([
        'orchestrate',
        'workflow',
      ]);
      expect(statePatched.filter((e) => e.emission.role === 'primary')).toHaveLength(1);
      expect(
        statePatched.find((e) => e.emission.role === 'primary')?.action,
        'the canonical state-mutation surface must be the primary edge',
      ).toBe('update');
    });
  });
});
