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

  // ─── Joint-schema collision guard (DR-1, #1581 task 004, rule 1) ───────────
  // `riskTier` (#1515) and `designDepth` (#1581) are siblings on the SHARED
  // ResolveGateSetCtx, surfaced as action input fields alongside the #1592
  // obligation fields. The JOINT-REVIEW constraint requires they compose into
  // ONE coordinated registration schema with NO field shadowing — adding
  // `designDepth` next to `riskTier` (and any concurrent obligation field) must
  // not make `buildRegistrationSchema` throw at startup. These canonical base
  // types mirror the registry declarations (`riskTier: z.enum(['low','medium',
  // 'high']).optional()`, `designDepth: z.enum(['thin','standard','deep'])`).
  it('RegistrationSchema_RiskTierPlusDesignDepth_NoFieldCollision', () => {
    const riskTier = z.enum(['low', 'medium', 'high']).optional();
    const designDepth = z.enum(['thin', 'standard', 'deep']).optional();
    const boundaryTouching = z.boolean().optional(); // representative #1592 obligation field

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

    // Guard liveness: a divergent `designDepth` value set across actions MUST
    // still be caught — so a future #1515/#1592 ctx mutation that shadows
    // `designDepth` with a different enum fails loud at startup, not silently.
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

  it('should accept doctor format values against the real orchestrate registration schema', () => {
    const orchestrate = TOOL_REGISTRY.find((t) => t.name === 'exarchos_orchestrate')!;
    const schema = buildRegistrationSchema(orchestrate.actions);

    // Regression for #1127: before the fix, agent_spec.format (full|prompt-only)
    // shadowed doctor/onboard.format (table|json), making these payloads fail
    // validation at the registered-tool boundary. (init was swapped out for
    // onboard in task 011 — design line 322 — so the regression is now exercised
    // through the onboard action's `format` field.)
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

// ─── merge_orchestrate description guidance (#1310 T16) ──────────────────────

describe('merge_orchestrate description', () => {
  it('MergeOrchestrateDescription_StatesDoNotUseFor_WithPointers', () => {
    const action = findActionInRegistry('exarchos_orchestrate', 'merge_orchestrate');
    expect(action).toBeDefined();
    const description = action!.description;

    // Negative-space guidance must be explicit.
    expect(description).toContain('Do NOT use for');

    // Each misuse must point at the right alternative action.
    expect(description).toContain('merge_pr');
    expect(description).toContain('verify_worktree');
    expect(description).toContain('request_synthesize');
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
  // The build emits a discriminated union; each variant lives under
  // `anyOf` (v4 native draft-2020-12) rather than the v3 library's
  // top-level `properties`. We pick the variant that actually carries
  // the field we want to assert on.
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

  it('should emit type:object for coercedRecord fields', () => {
    // T5a.1/DR-4 (#1259, v2.11): the prior assertion targeted the workflow
    // tool's `updates` field on the now-removed `set` action. Re-pointed to
    // the event tool's `event` field, which is also a `coercedRecord()`.
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

// ─── A2: TOOL_REGISTRY Tests ─────────────────────────────────────────────────

const ALL_FEATURE_PHASES = new Set([
  // #1581 (DR-4): `ideate` removed — feature workflows start at `plan`.
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

  // DR-7 (phase-kind binding, epic #1546): the phase-kind work — the closed
  // PhaseKind union, the KIND_OBLIGATIONS grant-table, the gate-set resolver,
  // and the fail-closed boundary that appends `phase.blocked` — is an internal
  // verification-routing change. It MUST NOT grow the visible MCP tool surface
  // (INV-5d) nor introduce a new top-level CLI verb (composite). This is a
  // regression fence: the visible composite count and the exact visible-tool
  // name set stay exactly what they were before phase-kind landed.
  it('Registry_VisibleToolCount_UnchangedByPhaseKind', () => {
    // exarchos_sync is the sole hidden composite; the four user-facing
    // composites are the top-level CLI verbs / visible MCP tools.
    const visibleTools = TOOL_REGISTRY.filter((t) => !t.hidden);
    expect(visibleTools.length).toBe(4);
    expect(visibleTools.length).toBeLessThanOrEqual(15);
    expect(visibleTools.map((t) => t.name).sort()).toEqual([
      'exarchos_event',
      'exarchos_orchestrate',
      'exarchos_view',
      'exarchos_workflow',
    ]);
    // Phase-kind added no hidden composite either — the total stays at 5.
    expect(TOOL_REGISTRY).toHaveLength(5);
  });

  // INV-5a / INV-5d (DR-16, phase-kind binding COMPLETION — S4, epic #1546):
  // the resolve-then-freeze machinery added in S4 — the phase.entered/phase.exited
  // events, the gate-set resolver, the POLA capability bundle
  // (mintCapabilitiesForKind), and resolvePhaseMode — stays INTERNAL to the four
  // composite tools. It MUST NOT surface as a new visible MCP tool (INV-5d), a
  // new top-level CLI verb, or a new composite ACTION (INV-5a). This shield
  // passes by construction; it turns red the moment any of that internal
  // machinery is accidentally promoted onto the callable surface.
  it('toolRegistry_PhaseKindWork_AddsNoVisibleToolOrVerb', () => {
    const visibleTools = TOOL_REGISTRY.filter((t) => !t.hidden);
    expect(visibleTools.map((t) => t.name).sort()).toEqual([
      'exarchos_event',
      'exarchos_orchestrate',
      'exarchos_view',
      'exarchos_workflow',
    ]);
    expect(TOOL_REGISTRY).toHaveLength(5);

    // No composite action leaks the internal kind/resolver/capability registry
    // as a callable verb.
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
    it('should have 11 actions: init, get, transition, update, cancel, cleanup, reconcile, rehydrate, checkpoint, feedback, describe', () => {
      // T5a.1/DR-4 (#1259, v2.11): `set` action removed (hard-cut from the
      // v2.10 one-release deprecation rerouting surface). Callers receive a
      // structured `UNKNOWN_ACTION` error with `validActions: ['transition',
      // 'update', ...]` instructing them to migrate to the canonical
      // surfaces — `transition` for phase changes, `update` for non-phase
      // state mutation.
      //
      // Wave 0 (#1340, v2.10.0-preview.2): `update` restored as the
      // canonical state-mutation surface. The v2.11 substrate cut removed
      // `set` without a replacement; the runbook's "emit state.patched
      // directly via event.append" guidance bypassed input validation,
      // output enveloping, idempotency, and `next_actions`. `update`
      // closes that gap.
      const composite = findComposite('exarchos_workflow');
      expect(composite).toBeDefined();
      const actionNames = composite!.actions.map((a) => a.name);
      expect(actionNames).toEqual(['init', 'get', 'transition', 'update', 'cancel', 'cleanup', 'reconcile', 'rehydrate', 'checkpoint', 'feedback', 'describe']);
    });
  });

  describe('exarchos_orchestrate', () => {
    it('should have 71 actions for task management, review triage, gate checks, validation handlers, runbooks, agent spec, oneshot/pruning, onboard (DR-2 task 011), doctor, VCS, classify_review_items (#1159), merge_orchestrate (DR-MO-1), check_integration_suite (#1329), check_invariant_conformance (DR-3), invariants_scaffold/invariants_add (invariants-catalog-wizard P2), check_test_adequacy + check_contract_drift + check_mock_boundary (verification-ladder slice 1), and composite actions', () => {
      const composite = findComposite('exarchos_orchestrate');
      expect(composite).toBeDefined();
      // 71 = 70 prior + `check_mock_boundary` (verification-ladder slice 1
      // SIV-4 #1530 — the per-task mock-boundary gate: scans new test hunks for
      // unowned-dependency mocks and steers toward hermetic fixtures; advisory by
      // default). The 70 baseline = 69 prior + `check_contract_drift`
      // (verification-ladder slice 1 Bundle B3 — the per-task contract-drift gate:
      // codegen → typecheck → breaking-diff against the merge-base, degrading to
      // advisory when no contract tool resolves). The 69 baseline = 68 prior +
      // `check_test_adequacy` (the kill-probe gate that supersedes commit-order
      // TDD as the load-bearing per-task verification). The 68 baseline = 69
      // prior − `new_project` (retired in DR-3 task 017; the greenfield path is
      // now `onboard --new` from task 016, and `applyLanguageCustomizations`'
      // INV-6-violating npm→dotnet string-rewrite is deleted — closes #1508).
      // The `init`/`install-skills` CLI verbs are rename stubs; the init action,
      // handler, and `init.executed` event were fully removed in DR-5 (task 018).
      // The 72 baseline = 71 prior + `mutation-adequacy` (verification-ladder
      // slice 3 R5 — the diff-scoped mutation backstop review-dimension action).
      // #1587 retired `check_tdd_compliance` (the test-FIRST ordering gate): 72 → 71.
      // The keeper is `check_test_adequacy` (outcome-based adequacy, test-after).
      // #1581 task 018 added `discover_bridge` (the deep-rung discover escalation): 71 → 72.
      // WLM foundation (task 008) added the three worktree-lifecycle ACTIONS
      // (`acquire_worktree`, `release_worktree`, `prune_worktrees`) onto
      // exarchos_orchestrate — INV-5d, no new visible tool: 72 → 75.
      // WLM operational core (DR-7) added `serialize_merge` (the optimistic
      // integration-branch merge lease) onto exarchos_orchestrate: 75 → 76.
      // DR-4 (Gap B, #1630) added `check_exploration_depth` (deep-only
      // Exploration-citation planning gate): 76 → 77.
      // #1739 (cutover promotion path) added `cutover_readiness` (read-only
      // six-condition gate report) and `cutover_decide` (operator-gated
      // event-sourced rollout decision) onto exarchos_orchestrate — INV-5d,
      // no new visible tool: 77 → 79.
      // Task 068 (DR-23) added `invariants_amend` — the id-targeted,
      // field-scoped amend path the invariant catalog previously lacked
      // entirely (invariants_add is append-only, so entries were effectively
      // immutable once committed). INV-5d, no new visible tool: 79 → 80.
      expect(composite!.actions).toHaveLength(80);

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
          // DR-2/DR-5 (task 011): explicit assertion so the consolidated
          // first-run verb cannot be silently dropped. `onboard` SWAPS OUT the
          // legacy `init` action (design line 322) — `init` is intentionally no
          // longer in this list; its CLI verb is now a rename stub.
          'onboard',
          // DR-MO-1 / DR-MO-2: explicit assertion so a future registry edit
          // cannot quietly drop the autonomous merge orchestrator action.
          'merge_orchestrate',
          // #1329: explicit name assertion — the length check alone can pass
          // even if a different action replaces check_integration_suite.
          'check_integration_suite',
          // DR-3: invariant-conformance review-dimension gate.
          'check_invariant_conformance',
          // invariants-catalog-wizard P2: authoring verbs (ACTIONS, not a 5th tool).
          'invariants_scaffold',
          'invariants_add',
          // verification-ladder slice 3 R5 (#1520): explicit name assertion so
          // the length bump cannot be satisfied by a different action.
          'mutation-adequacy',
          // WLM foundation (task 008): explicit name assertions so the length
          // bump cannot be satisfied by a different action.
          'acquire_worktree',
          'release_worktree',
          'prune_worktrees',
          // WLM operational core (DR-7): explicit name assertion so the length
          // bump cannot be satisfied by a different action.
          'serialize_merge',
          // DR-4 (#1630): explicit name assertion so the length bump cannot be
          // satisfied by a different action.
          'check_exploration_depth',
        ]),
      );
    });
  });

  it('OrchestrateActions_MatchCompositeHandlers_InSync', async () => {
    const composite = findComposite('exarchos_orchestrate');
    expect(composite).toBeDefined();
    const registryNames = new Set(composite!.actions.map((a) => a.name));

    const { ACTION_HANDLER_KEYS } = await import('../../src/verbs/composite.js');

    // Actions that have NO entry in the ACTION_HANDLERS table because they are
    // served by an EXPLICIT dispatch branch in the composite router (an
    // `if (action === ...)` arm) — they need something the generic adapter can't
    // provide (the full action list, injected fs hooks, or the whole
    // DispatchContext). The SPECIAL_BRANCH_DISPATCH check at the bottom proves
    // each of these branches ACTUALLY routes; this set only excuses them from the
    // "must be in ACTION_HANDLERS" loop.
    //
    // `onboard` is deliberately NOT in this skip-set. Keeping it here previously
    // SUPPRESSED the bug where `onboard` was registered but had NO composite
    // branch and NO ACTION_HANDLERS entry, so it fell through to UNKNOWN_ACTION at
    // runtime while every unit test (which called `handleOnboard` directly) stayed
    // green. With onboard out of the skip-set, the dispatch-routing assertion
    // below is the load-bearing guard for its branch.
    //
    // `init` is absent from the registry entirely: its action was removed in the
    // onboard swap (design line 322) and its handler in DR-5 (task 018). `onboard`
    // supersedes it.
    const SPECIAL_ACTIONS = new Set([
      'describe',
      'runbook',
      'doctor',
      'invariants_scaffold',
      'invariants_add',
      // Task 068 — the amend path the catalog previously lacked. Like the two
      // above it dispatches through an explicit composite branch rather than
      // ACTION_HANDLERS, so it is skipped here and ENFORCED by the routing
      // assertion below (which is what would catch a registration with no
      // branch — the UNKNOWN_ACTION hazard).
      'invariants_amend',
    ]);

    // The full set of explicit composite dispatch branches — SPECIAL_ACTIONS plus
    // `onboard` (whose branch is the regression target of this guard). Every
    // registered action MUST be either in ACTION_HANDLERS or in this set.
    const SPECIAL_BRANCH_DISPATCH = new Set([...SPECIAL_ACTIONS, 'onboard']);

    for (const handlerKey of ACTION_HANDLER_KEYS) {
      expect(
        registryNames.has(handlerKey),
        `Handler '${handlerKey}' in composite.ts is missing from registry.ts orchestrateActions`,
      ).toBe(true);
    }
    for (const registryName of registryNames) {
      if (SPECIAL_ACTIONS.has(registryName)) continue;
      // After the SPECIAL_ACTIONS skip, the only registered actions allowed to be
      // absent from ACTION_HANDLERS are the special BRANCH dispatches (today just
      // `onboard`). Anything else with no handler is a genuine drift.
      if (SPECIAL_BRANCH_DISPATCH.has(registryName)) continue;
      expect(
        ACTION_HANDLER_KEYS.includes(registryName),
        `Registry action '${registryName}' has no handler in composite.ts`,
      ).toBe(true);
    }

    // ENFORCE the special-branch dispatch (the registry↔handler guard the old
    // `SPECIAL_ACTIONS` skip could not provide): every registered action that is
    // NOT in ACTION_HANDLERS MUST be reachable through an explicit composite
    // branch. We assert routing by dispatching each through `handleOrchestrate`
    // and confirming it does NOT fall through to UNKNOWN_ACTION. `onboard` is the
    // regression target — before its branch + import were wired it failed here.
    const { handleOrchestrate } = await import('../../src/verbs/composite.js');
    const { EventStore } = await import('../../src/events/store.js');
    const { mkdtemp, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const path = await import('node:path');

    const branchOnly = [...registryNames].filter(
      (n) => !ACTION_HANDLER_KEYS.includes(n),
    );
    // Sanity: every branch-only action is one we expect to have a special arm.
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

      // `describe`/`runbook` route without side effects; doctor/onboard/invariants
      // read ctx.eventStore. We dispatch with the minimal valid args per action
      // and only assert the action ROUTED (no UNKNOWN_ACTION) — behavior is
      // covered by each handler's own suite.
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

  it('Registry_CheckInvariantConformance_RegisteredReadOnlyUnder15Tools', () => {
    // DR-3 (T-13): the invariant-conformance gate is a new ACTION on
    // exarchos_orchestrate (INV-5d) — not a new tool. It must be registered
    // with a non-destructive, local-only safety class (it reads the catalog
    // and computes a verdict — it does NOT touch source or remote state), and
    // must NOT grow the visible composite-tool surface past the 15-tool ceiling.
    const action = findAction('exarchos_orchestrate', 'check_invariant_conformance');
    expect(action, 'check_invariant_conformance must be registered on exarchos_orchestrate').toBeDefined();

    // Safety annotation (INV-5b: registered outputSchema + a non-destructive,
    // local safety class). NOTE: the gate emits `gate.executed` on every call,
    // so it cannot be `readOnly` — the `RegistryDrift_AutoEmitsImpliesNotReadOnly`
    // invariant forbids that. It mirrors the rest of the check_* family
    // (check_convergence / check_review_verdict): local-mutation, non-destructive.
    expect(action!.annotations).toBeDefined();
    expect(action!.annotations!.safety).toBe('local-mutation');
    expect(action!.annotations!.readOnly).toBe(false);
    expect(action!.annotations!.destructive).toBe(false);
    expect(action!.annotations!.openWorld).toBe(false);
    expect(action!.outputSchema).toBeDefined();

    // Still a review-phase, lead-role gate that auto-emits gate.executed.
    expect(action!.phases.has('review')).toBe(true);
    expect(action!.roles.has('lead')).toBe(true);
    expect(action!.autoEmits?.some((e) => e.event === 'gate.executed')).toBe(true);

    // Visible (non-hidden) composite tools stay within the 15-tool budget.
    const visibleTools = TOOL_REGISTRY.filter((t) => !t.hidden);
    expect(visibleTools.length).toBeLessThanOrEqual(15);
  });

  it('Registry_InvariantsScaffold_HasOutputSchemaAndAnnotations', () => {
    // P2/T7: invariants_scaffold is a new ACTION on exarchos_orchestrate
    // (INV-5d — NOT a fifth visible tool). It writes files + .exarchos.yml, so
    // it is LOCAL_MUTATION (not read-only). It must declare a registered
    // EnvelopeSchema outputSchema (INV-5b) and a when-NOT-to-use clause in its
    // description (INV-5a input ergonomics).
    const action = findAction('exarchos_orchestrate', 'invariants_scaffold');
    expect(action, 'invariants_scaffold must be registered on exarchos_orchestrate').toBeDefined();

    expect(action!.annotations).toBeDefined();
    expect(action!.annotations!.safety).toBe('local-mutation');
    expect(action!.annotations!.readOnly).toBe(false);
    expect(action!.annotations!.destructive).toBe(false);
    expect(action!.annotations!.openWorld).toBe(false);
    expect(action!.outputSchema).toBeDefined();

    // when-NOT clause (INV-5a). The description must steer the agent away from
    // misuse (e.g. don't use to add an entry — that's invariants_add).
    expect(action!.description.toLowerCase()).toContain('do not use');

    // No fifth visible tool (INV-5d): the visible-tool count is unchanged.
    const visibleTools = TOOL_REGISTRY.filter((t) => !t.hidden);
    expect(visibleTools.length).toBeLessThanOrEqual(15);
  });

  it('Registry_InvariantsAdd_DryRunDefault', () => {
    // P2/T11: invariants_add is a LOCAL_MUTATION ACTION on exarchos_orchestrate
    // (INV-5d) that declares the invariant.authored / catalog.registered
    // autoEmits (INV-1) and a when-NOT clause (INV-5a). INV-5c: the verb
    // defaults to dry-run. The default is enforced at the dispatch boundary
    // (composite.ts) rather than as a Zod `.default(true)` — the
    // MCP-registration flattener (`buildRegistrationSchema`) forbids two
    // actions declaring `dryRun` with divergent defaults, and merge_orchestrate
    // / prune_stale_workflows already declare it `.optional()`. So the schema
    // field stays optional, and dispatching invariants_add WITHOUT dryRun must
    // NOT write (the safe default).
    const action = findAction('exarchos_orchestrate', 'invariants_add');
    expect(action, 'invariants_add must be registered on exarchos_orchestrate').toBeDefined();

    expect(action!.annotations!.safety).toBe('local-mutation');
    expect(action!.annotations!.readOnly).toBe(false);
    expect(action!.outputSchema).toBeDefined();
    expect(action!.description.toLowerCase()).toContain('do not use');

    // autoEmits declares both authoring events (INV-1).
    const events = (action!.autoEmits ?? []).map((e) => e.event);
    expect(events).toContain('invariant.authored');
    expect(events).toContain('catalog.registered');

    // The schema accepts an entry with dryRun omitted (the dry-run default is
    // applied downstream at dispatch).
    const parsed = action!.schema.safeParse({
      entry: { dimension: 'd' },
      catalog: '.exarchos/invariants.md',
      tier: 'user',
    });
    expect(parsed.success).toBe(true);

    const visibleTools = TOOL_REGISTRY.filter((t) => !t.hidden);
    expect(visibleTools.length).toBeLessThanOrEqual(15);
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

    // T1 (#1446 residue) — register the view actions that are
    // dispatched through `projections/views/composite.ts` today but were never added to
    // `TOOL_REGISTRY.viewActions`. Without the registry entry, per-action
    // Zod validation at `dispatch/core/dispatch.ts:801` is silently skipped and
    // `exarchos_view describe` under-lists the dispatched surface.
    it('TOOL_REGISTRY_viewActions_IncludesSessionProvenanceAndProvenance', () => {
      const viewComposite = findComposite('exarchos_view');
      expect(viewComposite).toBeDefined();

      // ── session_provenance ────────────────────────────────────────────
      // Handler: `handleViewSessionProvenance(args, stateDir)` —
      // accepts `{ sessionId?, workflowId?, metric? }`. Does NOT receive
      // the event store, so the correlation-tuple filter shape is
      // intentionally absent here.
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
      // Accepts the args the composite handler routes today.
      const sessionProvenanceParse = sessionProvenance!.schema.safeParse({
        sessionId: 'sess-abc',
        workflowId: 'wf-1',
        metric: 'cost',
      });
      expect(sessionProvenanceParse.success).toBe(true);
      // No event-store query => no correlation-tuple slots.
      expect(sessionProvenanceShape).not.toHaveProperty('operationId');
      expect(sessionProvenanceShape).not.toHaveProperty('correlationId');
      expect(sessionProvenanceShape).not.toHaveProperty('causationId');

      // ── provenance ────────────────────────────────────────────────────
      // Handler: `handleViewProvenance(args, stateDir, eventStore)` — queries
      // the event store via `queryDeltaEvents`, so the correlation-tuple
      // filter shape MUST be present so DR-5 dispatch validation surfaces
      // those slots through `describe` (parity with the Wave 5 actions
      // registered post-#1437).
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

  // ─── WLM operational-core registration floor (DR-4 / DR-7) ────────────────
  //
  // The three new WLM operational-core actions are `serialize_merge` (the
  // optimistic integration-branch merge lease, on exarchos_orchestrate, DR-7)
  // and the liveness reads `ps` / `wait` (on exarchos_view, DR-4). The registry
  // runs `validateAction` over EVERY action in a module-load loop, so any one of
  // these missing its `outputSchema` or a malformed `annotations` block would
  // throw at IMPORT time (DIM-3 contracts fail closed at startup, not at first
  // call). These floor assertions pin that contract so a future registry edit
  // that drops a schema/annotation on one of the new actions is caught here with
  // a named failure rather than as an opaque import crash.
  describe('WLM operational-core registration floor (DR-4/DR-7)', () => {
    // [toolName, actionName] for each newly-registered operational-core action.
    const NEW_ACTIONS: ReadonlyArray<readonly [string, string]> = [
      ['exarchos_orchestrate', 'serialize_merge'],
      ['exarchos_view', 'ps'],
      ['exarchos_view', 'wait'],
    ];

    it('Registry_NewActions_DeclareOutputSchemaAndCoreAnnotations', () => {
      for (const [tool, name] of NEW_ACTIONS) {
        const action = findAction(tool, name);
        expect(action, `${tool}.${name} must be registered`).toBeDefined();

        // outputSchema: present AND a real Zod schema (has a `.parse` method —
        // the exact shape `validateAction` requires before the response
        // envelope can be type-checked).
        expect(
          action!.outputSchema,
          `${tool}.${name} must declare an outputSchema`,
        ).toBeDefined();
        expect(
          typeof (action!.outputSchema as { parse?: unknown }).parse,
          `${tool}.${name}.outputSchema must be a Zod schema (got non-parseable value)`,
        ).toBe('function');

        // annotations: present AND every core boolean field typed correctly,
        // plus a recognized `safety` class. This mirrors the per-field shape the
        // registry's `ActionAnnotationsSchema` enforces.
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

      // Annotation honesty (REV-L1): `ps probe:true` runs the DR-5 orphan
      // emitter, a conditional idempotent write path — so `ps` is annotated
      // local-mutation / idempotent (NOT readOnly), even though it rides the
      // exarchos_view tool. `wait` is genuinely read-only; serialize_merge
      // mutates shared state.
      const ps = findAction('exarchos_view', 'ps');
      const wait = findAction('exarchos_view', 'wait');
      expect(ps!.annotations!.safety).toBe('local-mutation');
      expect(ps!.annotations!.readOnly).toBe(false); // has a conditional write path.
      expect(ps!.annotations!.idempotent).toBe(true); // the heals re-converge.
      expect(ps!.annotations!.destructive).toBe(false);
      expect(wait!.annotations!.readOnly).toBe(true);
      const serializeMerge = findAction('exarchos_orchestrate', 'serialize_merge');
      expect(serializeMerge!.annotations!.readOnly).toBe(false);
    });

    it('Registry_ModuleLoad_DoesNotThrowOnNewActions', () => {
      // `TOOL_REGISTRY` was already imported at module top — its module-load
      // `validateAction` loop ran without throwing, otherwise this test file
      // could not have loaded. Re-running the SAME fail-closed gate over each
      // new action proves explicitly that none of them would crash startup.
      for (const [tool, name] of NEW_ACTIONS) {
        const action = findAction(tool, name);
        expect(action, `${tool}.${name} must be registered`).toBeDefined();
        expect(
          () => validateAction(action!, tool),
          `${tool}.${name} fails the module-load validateAction gate — it would ` +
            `throw at import time and crash MCP startup`,
        ).not.toThrow();
      }

      // The module itself imports cleanly (cached re-import — asserts the
      // load-time validation loop already succeeded for the whole registry).
      return expect(import('../../src/registry.js')).resolves.toBeDefined();
    });

    it('Registry_VisibleCompositeToolCount_StaysFour', () => {
      // INV-5d: the WLM operational-core actions are ACTIONS on existing
      // composites, NOT new visible tools. The visible (non-hidden) composite
      // count must stay at exactly 4 (the four top-level CLI verbs / MCP tools),
      // with exarchos_sync the sole hidden composite (total 5).
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

  it('TransitionAction_HasFlagAliases', () => {
    // T5a.1/DR-4 (#1259, v2.11): replaces the prior `SetAction_HasFlagAliases`
    // test. `set` is removed; `transition` is the canonical phase-mutation
    // surface and now anchors this CLI flag-alias coverage.
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

// ─── Task 24: CLI Examples on Common Actions ─────────────────────────────────

describe('CLI examples on common actions', () => {
  it('CliHints_ExamplesPresent_ForCommonActions', () => {
    const initAction = findAction('exarchos_workflow', 'init');
    expect(initAction!.cli?.examples).toBeDefined();
    expect(initAction!.cli!.examples!.length).toBeGreaterThan(0);

    const getAction = findAction('exarchos_workflow', 'get');
    expect(getAction!.cli?.examples).toBeDefined();
    expect(getAction!.cli!.examples!.length).toBeGreaterThan(0);

    // T5a.1/DR-4 (#1259, v2.11): `set` removed; `transition` carries CLI
    // example coverage as the canonical phase-mutation action.
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

    // Ensure every expected check action was actually found in the registry
    for (const expected of expectedCheckActions) {
      expect(
        visited.has(expected),
        `Expected check action '${expected}' was not found in TOOL_REGISTRY`,
      ).toBe(true);
    }
  });

  it('GateMetadata_CheckInvariantConformance_IsBlocking', () => {
    // Task 027 / DR-15: after raising INV-13/14/16 to mode:check, this gate
    // produces deterministic mechanical findings and BLOCKS on check-mode
    // (blocking-severity) violations — so its registered gate metadata declares
    // blocking:true (was false while it was purely advisory).
    const action = findAction('exarchos_orchestrate', 'check_invariant_conformance');
    expect(action, 'check_invariant_conformance must be registered').toBeDefined();
    expect(action!.gate, 'check_invariant_conformance must carry gate metadata').toBeDefined();
    expect(action!.gate!.blocking).toBe(true);
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
    const { EVENT_EMISSION_REGISTRY } = await import('../../src/events/schemas.js');

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

  it('RegistryDrift_AutoEmitsImpliesNotReadOnly', () => {
    // Capability-model invariant: any action that emits events writes to
    // the event store, so it MUST NOT advertise `readOnly: true`. A
    // mis-annotation lets read-only-capability clients mutate state and
    // bypass capability gates (sentry HIGH on PR #1369: `check_convergence`
    // and `doctor` were both `READ_ONLY_LOCAL` despite emitting
    // `gate.executed` / `diagnostic.executed`).
    const violations: string[] = [];
    for (const tool of TOOL_REGISTRY) {
      for (const action of tool.actions) {
        if (!action.autoEmits || action.autoEmits.length === 0) continue;
        if (action.annotations?.readOnly === true) {
          const events = action.autoEmits.map((e) => e.event).join(', ');
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
    // Crucially: the parsed data must RETAIN pluginFindings (not strip it)
    if (result.success) {
      const data = result.data as Record<string, unknown>;
      expect(data.pluginFindings).toBeDefined();
      expect(Array.isArray(data.pluginFindings)).toBe(true);
      const findings = data.pluginFindings as Array<Record<string, unknown>>;
      expect(findings).toHaveLength(1);
      expect(findings[0].source).toBe('impeccable');
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

// #1499 — WS2 migrated pre_synthesis_check / verify_review_triage /
// extract_fix_tasks to resolveWorkflowState (event-store fallback). featureId
// MUST stay optional so the shipped stateFile-only skill callers
// (quality-review Step 0.5, delegation fix-mode) are not rejected at the
// dispatch boundary. The "at least one source" cross-field rule lives in the
// handlers (Zod single-field `.min(1)` can't express it).
describe('#1499 state-source migration schema (regression guard)', () => {
  it.each([
    'pre_synthesis_check',
    'verify_review_triage',
    'extract_fix_tasks',
  ])('%s accepts a stateFile-only input (featureId optional)', (action) => {
    const found = findActionInRegistry('exarchos_orchestrate', action);
    expect(found, `${action} must be registered`).toBeDefined();
    expect(
      found!.schema.safeParse({ stateFile: '/tmp/wf.state.json' }).success,
      `${action} must accept stateFile-only`,
    ).toBe(true);
    // The canonical event-store path (featureId-only) must also validate.
    expect(found!.schema.safeParse({ featureId: 'wf-x' }).success).toBe(true);
  });
});

// ─── DR-11 (#1259): outputSchema registers _meta.deprecation ─────────────────
//
// T5a.1/DR-4 (v2.11): `set` action removed. Per INV-5b the
// `_meta.deprecation` schema slot is retained on `transition` for one
// more release as a historical marker (v2.12 drops the slot itself), so
// this test is narrowed to cover only the canonical action.
describe('Registry_OutputSchema (T40, DR-11)', () => {
  function findAction(toolName: string, actionName: string): ToolAction {
    const tool = TOOL_REGISTRY.find((t) => t.name === toolName);
    const action = tool?.actions.find((a) => a.name === actionName);
    if (action === undefined) throw new Error(`action '${toolName}.${actionName}' not registered`);
    return action;
  }

  it('Registry_OutputSchema_RegistersMetaDeprecationOnAffectedActions', () => {
    const transitionAction = findAction('exarchos_workflow', 'transition');

    expect(transitionAction).toBeDefined();
    expect(transitionAction!.outputSchema).toBeDefined();

    // Canonical envelope shape (EnvelopeSchema factory): success branch
    // requires next_actions[] and _perf{ms,bytes,tokens}. Wave 0 / Task G.2
    // consolidates the three standalone constants onto EnvelopeSchema so
    // the asserted shape here reflects the canonical envelope.
    const perf = { ms: 0, bytes: 0, tokens: 0 };

    // The schema accepts a deprecation envelope with all three fields.
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

    // The schema rejects deprecation envelopes missing required sub-fields
    // (each of `since`, `removeIn`, `replacement` must be present + non-empty).
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

    // The deprecation field is optional — responses without it (the
    // canonical `transition` arm never emits one) still validate.
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

// ─── Wave 0 / Task G.2 — Envelope-factory consolidation ──────────────────
//
// The three standalone `Workflow{Set,Transition,Update}OutputSchema`
// constants — declared in v2.10.0-preview.2 as the LCD-envelope prototype
// — are consolidated as thin wrappers over the `EnvelopeSchema(dataSchema)`
// factory from `contract/schemas/envelope.ts`. The constants remain as deprecated
// re-exports for one release window so any downstream typed-import
// consumer doesn't break; canonical replacement is `EnvelopeSchema` directly.
describe('Registry_OutputSchema (Wave 0 / G.2)', () => {
  it('WorkflowTransitionOutputSchema_DerivedFromEnvelopeFactory_ParsesValidSuccessEnvelope', () => {
    // Build a canonical success envelope via `wrap()`, then attach a
    // typed deprecation sub-shape on `_meta` — the consolidated factory
    // wrapper must accept both the envelope core and the deprecation slot.
    const env = wrap(
      { phase: 'plan' },
      { deprecation: { since: '2.10', removeIn: '2.12', replacement: 'transition' } },
    );
    expect(WorkflowTransitionOutputSchema.safeParse(env).success).toBe(true);

    // Symmetric coverage for the other two consolidated wrappers.
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

  // #1360 / PR 2 — RESERVED_FIELD errors emitted by handleSet carry a
  // typed `data` block (`{rejectedPath, rule, alternateWritePath}`). The
  // registered outputSchema for `exarchos_workflow.update`'s error branch
  // must validate that envelope without stripping or rejecting `data`.
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
      // The error branch's `passthrough()` must preserve `data` end-to-end.
      const env = parsed.data as { success: false; error: Record<string, unknown> };
      expect(env.error.data).toBeDefined();
      const errData = env.error.data as Record<string, unknown>;
      expect(errData.rejectedPath).toBe('phase');
      expect(errData.alternateWritePath).toMatch(/transition/i);
    }
  });
});

// ─── Wave 0 / Task A.5 — ActionAnnotations (#1289, design §2.4) ────────
//
// Server-trusted `safety` field + MCP-spec advisory *Hint flags
// (readOnly/destructive/idempotent/openWorld). Validator must throw with
// the action name surfaced for operator-friendly errors.
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

  it('ActionAnnotationsSchema_AcceptsCompleteRecord_Succeeds', () => {
    const result = ActionAnnotationsSchema.safeParse(valid);
    expect(result.success).toBe(true);

    // Each safety enum value paired with its canonical mapping (see
    // registry.ts §"Mapping rules" comment block).
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

  // ─── Mapping-rule invariants (CodeRabbit PR #1369 major) ──────────────
  //
  // The shape-only schema admitted contradictory tuples like
  // `safety: 'read-only' + readOnly: false`, which would have silently
  // labeled an event-emitting action as advisory-safe. superRefine
  // enforces the mapping rules documented in registry.ts so the same
  // class of error that produced the doctor / check_convergence Sentry
  // HIGH finding cannot reappear elsewhere — INV-5b (spec-aligned output
  // contract) fails closed at module load.

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

  it('validateAnnotations_ThrowsOnPartialObject_IncludesFieldName', () => {
    const partial = { safety: 'local-mutation', readOnly: false };

    let caught: Error | undefined;
    try {
      validateAnnotations(partial, 'composeMessage');
    } catch (err) {
      caught = err as Error;
    }

    expect(caught).toBeInstanceOf(Error);
    // The action name must be present so operators can locate the offender.
    expect(caught!.message).toContain('composeMessage');
    // At least one missing field name must surface in the message so the
    // operator does not have to re-derive what's wrong from a generic error.
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

// ─── Wave 0 / Tasks C.1 + C.2 — Registry Invariant Tests ─────────────
//
// Every action in every visible AND hidden tool must declare both
// `outputSchema` (a Zod schema) and `annotations` (a typed
// ActionAnnotations record). Failure surface includes the
// `${tool}.${action}` identifier so an operator can navigate from
// a failed CI run to the offending entry in <1 minute.
//
// Design §2.1 (outputSchema as the per-action contract surface) +
// §2.4 (annotations for safety + MCP advisory hints). Issues #1287 +
// #1289.
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
          // Re-validate the shape so a hand-edited annotations field that
          // drifts from the schema is caught here, not at first use.
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

// ─── Wave 0 / Task C.3 — validateAction (registration-time invariant) ──
//
// `validateAction` is the per-action gate the registry runs at module
// load. It surfaces missing `outputSchema` / `annotations` declarations
// with the fully-qualified `${tool}.${action}` identifier so the
// failure points the operator straight at the offender.
describe('validateAction', () => {
  // Local import: the function must be exported from `./registry.js`
  // alongside the existing `validateAnnotations` helper.
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
    expect(() =>
      validateAction(
        {
          name: 'ok',
          outputSchema: z.object({ success: z.boolean() }),
          annotations: validAnnotations,
        },
        'exarchos_event',
      ),
    ).not.toThrow();
  });
});

// ─── Preview-4 / T2 — DispatchHints on ToolAction (#1440 Op 2) ─────────
//
// Adds an optional, action-descriptor-level `dispatch: DispatchHints`
// block so future tasks (T8 describe projection, T9 annotations, T11
// retry_with_task verb) can annotate which actions are long-running and
// benefit from Tasks-augmented dispatch. Lives at the descriptor level
// (sibling to `cli`, `gate`, `autoEmits`), not under `cli.`, because the
// Tasks dispatch-core is shared between CLI and MCP facades (INV-2). See
// design §4.3.
//
// This test asserts the shape only — no annotations on existing actions
// land in T2; those are T9's job. The actual opt-in gate stays at
// `dispatch/core/dispatch.ts:927-954`; this marker is advisory.
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

    // Anchor the type-level assertion with a runtime check so the test
    // also fails loudly under vitest if the field is dropped or renamed
    // (TS-only tests get excluded from CI typecheck — see
    // tsconfig.json's `**/*.test.ts` exclude).
    expect(action.dispatch).toBeDefined();
    expect(action.dispatch?.taskSuitable).toBe(true);
    expect(action.dispatch?.taskTtlSuggestionMs).toBe(60_000);
  });

  it('ToolAction_DispatchHintsShape_FieldIsOptional', () => {
    // Omitting `dispatch` must still satisfy `ToolAction`. This guards
    // against the field being inadvertently promoted to required, which
    // would force every existing action to annotate before T9 lands.
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

// ─── T9 (#1440 Op 2, preview-4 design §4.3) — Task-suitable annotations ──
//
// The four initial task-suitable targets from design §4.3:
//   - `exarchos_orchestrate merge_orchestrate` (multi-step git merge)
//   - `exarchos_orchestrate request_synthesize` — the registry-canonical
//     name for the design's "synthesize" verb (PR creation flow flipped
//     by emitting `synthesize.requested` to the choice-state guard).
//     The design §4.3 callout lists "synthesize" as the logical verb;
//     `request_synthesize` is its registry-name realization and lives
//     under `exarchos_orchestrate` alongside the other gate verbs, NOT
//     under `exarchos_workflow` (which only carries the HSM-level
//     primitives `init`/`get`/`transition`/`update`/`cancel`/...).
//   - `exarchos_workflow cleanup` (post-merge cleanup)
//   - `exarchos_workflow rehydrate` (full state rebuild)
//
// Each must carry `dispatch: { taskSuitable: true,
// taskTtlSuggestionMs: 60_000 }`. Annotations are advisory — the binding
// opt-in gate stays at `dispatch/core/dispatch.ts:927-954` — so this test only
// pins the registry-side declaration, not behavior.
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

// ─── T6 (#1555) — `asOf` bounded-fold param on get / view actions ───────────
//
// The registered `get` (and the chosen `view` actions) accept an optional
// mutually-exclusive `asOf` bound, validated identically to
// `GetInputSchema.asOf`. INV-5b: adding `asOf` changes WHICH point is
// projected, never the result SHAPE — so each action's registered
// `outputSchema` stays byte-identical (`EnvelopeSchema(z.unknown())`).

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
    // INV-5b: the `get` action result shape is the unchanged generic
    // envelope. Adding `asOf` must NOT touch the registered outputSchema.
    const action = findAction('exarchos_workflow', 'get');
    expect(action!.outputSchema).toBeDefined();
    // A generic envelope accepts any `data` payload — the asOf addition
    // does not narrow or reshape it. Round-trip a representative envelope
    // through the registered schema to pin the shape.
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

// ─── harness-launcher verb conformance + Windows CI lane (task 015) ──────────
//
// DR-1 / DR-8. The `exarchos <harness>` launcher is a CLI-only process-supervisor
// verb (the stdio MCP surface cannot own a child's lifecycle), so:
//   - its INV-5 conformance surface (schema constraints + when-NOT-to-use) lives
//     on the verb module, not in TOOL_REGISTRY;
//   - it must NOT grow the visible MCP tool count (INV-5d);
//   - its win32-fragile tests are gated by a NAMED Windows CI lane (DR-8).
// These four tests are co-located here (registry.test.ts is the visible-tool-count
// home) per the task's lane discipline.
describe('harness-launcher verb conformance + Windows CI lane (task 015, DR-1/DR-8)', () => {
  // ─── INV-5 verb conformance (DR-1) ────────────────────────────────────────

  it('Verb_SchemaConstraints_Present', () => {
    const { schemaConstraints } = LAUNCHER_VERB_CONFORMANCE;
    expect(Array.isArray(schemaConstraints)).toBe(true);
    expect(schemaConstraints.length).toBeGreaterThan(0);

    // Every constraint statement is a non-empty string.
    for (const constraint of schemaConstraints) {
      expect(typeof constraint).toBe('string');
      expect(constraint.trim().length).toBeGreaterThan(0);
    }

    // Each of the three schema fields has its constraint spelled out.
    const joined = schemaConstraints.join('\n');
    expect(joined).toContain('harness');
    expect(joined).toContain('feature');
    expect(joined).toContain('dryRun');

    // The harness constraint enumerates the exact Tier-1 enum, so the documented
    // constraint cannot drift from the enforced LauncherVerbSchema.
    for (const harness of TIER1_HARNESSES) {
      expect(joined).toContain(harness);
    }
    // ...and names the structured-error escape hatch for an unknown value.
    expect(joined).toContain('validTargets');
  });

  it('Verb_WhenNotToUse_Present', () => {
    const { whenNotToUse } = LAUNCHER_VERB_CONFORMANCE;
    expect(Array.isArray(whenNotToUse)).toBe(true);
    expect(whenNotToUse.length).toBeGreaterThan(0);

    // Every entry is an explicit "do NOT use" negative-space clause (the same
    // convention merge_orchestrate / invariants_scaffold descriptions follow).
    for (const clause of whenNotToUse) {
      expect(typeof clause).toBe('string');
      expect(clause.toLowerCase()).toContain('do not use');
    }

    // The clause points at the right alternatives for the load-bearing misuses,
    // so an agent is steered off the wrong surface (INV-5a), not just told "no".
    const joined = whenNotToUse.join('\n');
    expect(joined).toContain('serialize_merge'); // integration merges
    expect(joined).toContain('adopt'); // harness-created nested worktrees
    expect(joined.toLowerCase()).toContain('generic'); // no process to spawn
  });

  // ─── Visible-tool-count fence (DR-1, INV-5d) ──────────────────────────────

  it('VisibleToolCount_Unchanged', () => {
    // The launcher verb is CLI-only, so importing its module MUST NOT grow the
    // visible MCP tool surface. The four user-facing composites stay exactly
    // what they were; exarchos_sync remains the sole hidden composite (total 5).
    const visibleTools = TOOL_REGISTRY.filter((t) => !t.hidden);
    expect(visibleTools.length).toBe(4);
    expect(visibleTools.map((t) => t.name).sort()).toEqual([
      'exarchos_event',
      'exarchos_orchestrate',
      'exarchos_view',
      'exarchos_workflow',
    ]);
    expect(TOOL_REGISTRY).toHaveLength(5);

    // No composite tool or action leaks the launcher verb / a harness target
    // onto the callable MCP surface.
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

  // ─── Windows CI lane (DR-8) ───────────────────────────────────────────────
  //
  // Parses .github/workflows/ci.yml and asserts a Windows lane WIRES the two
  // named win32-fragile tests OS-native: the async spawn shim resolution (task
  // 003) and the worktree path derivation/containment (task 009). Naming the
  // files (not just `npm run test:run`) means a future path-filter / matrix
  // regression that drops them fails this assertion loudly rather than passing
  // green-on-zero. The "required/blocking" gating itself is a GitHub
  // branch-protection setting (out-of-repo, not vitest-assertable) — tracked as
  // a manual repo-settings step in the merge PR checklist.
  it('WindowsLane_RunsNamedSpawnAndPathTests_Required', () => {
    const SPAWN_TEST = 'src/utils/process.spawn.test.ts'; // task 003 (DR-4/DR-8)
    const PATH_TEST = 'src/launcher/topology.test.ts'; // task 009 (DR-5/DR-8)

    // registry.test.ts lives at src — the repo root (which
    // owns .github/) is three levels up. Resolved from the source file, so the
    // walk holds regardless of the test runner's cwd. This stays INSIDE the
    // worktree (ci.yml is a worktree file), so the `..` walk never escapes it.
    const here = dirname(fileURLToPath(import.meta.url));
    const ciPath = resolve(here, '../../.github/workflows/ci.yml');
    const raw = readFileSync(ciPath, 'utf8');

    const parsed: unknown = parseYaml(raw);
    expect(parsed !== null && typeof parsed === 'object').toBe(true);
    const doc = parsed as Record<string, unknown>;
    const jobs = doc.jobs;
    expect(jobs !== null && typeof jobs === 'object').toBe(true);
    const jobsMap = jobs as Record<string, unknown>;

    // Collect every job that runs on a real Windows host.
    const windowsJobs = Object.entries(jobsMap).filter(([, job]) => {
      if (job === null || typeof job !== 'object') return false;
      const runsOn = (job as Record<string, unknown>)['runs-on'];
      return typeof runsOn === 'string' && runsOn.includes('windows');
    });
    expect(
      windowsJobs.length,
      'ci.yml must wire at least one windows-latest lane',
    ).toBeGreaterThan(0);

    // At least one Windows lane must NAME both win32-fragile test files in its
    // steps (not merely run the whole suite) — so dropping either is caught.
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

// ─── DR-1 / Task 002: economy descriptor block + default budgets ─────────────
//
// These tests pin the registry-declared response-economy contract: every
// action resolves a concrete budget (declared `economy.budgetTokens` or the
// registry-wide default), the verbose-by-design allowlist declares explicit
// higher budgets, and `describe` surfaces the effective budget. Enforcement
// (capping at the dispatch-core seam) is Task 003 and out of scope here.

/**
 * Golden table pinning EVERY action's effective response budget
 * (`tool.action` → resolved tokens). This is the DR-1 economy contract made
 * enumerable: a new action, a removed action, or any budget change surfaces
 * as a diff against this table, forcing a deliberate economy decision per
 * action. Keys are `${toolName}.${actionName}` because action names repeat
 * across tools (`describe` is on every tool). If this table diffs, do not
 * blindly update it — confirm the new/changed budget is intentional first.
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
  'exarchos_orchestrate.describe': 8000,
  'exarchos_view.pipeline': 2000,
  'exarchos_view.tasks': 2000,
  'exarchos_view.workflow_status': 2000,
  'exarchos_view.stack_status': 2000,
  'exarchos_view.stack_place': 2000,
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

/** Effective-budget map built from the live registry, keyed `tool.action`. */
function buildEffectiveBudgetMap(): Record<string, number> {
  const map: Record<string, number> = {};
  for (const tool of TOOL_REGISTRY) {
    for (const action of tool.actions) {
      map[`${tool.name}.${action.name}`] = resolveEconomyBudget(action);
    }
  }
  return map;
}

describe('registry economy budgets (DR-1)', () => {
  it('registryEconomy_BudgetSnapshot_PinsEffectiveBudgetPerAction', () => {
    const actual = buildEffectiveBudgetMap();

    // Golden pin: every action's effective budget matches the table. A new
    // action, a removed action, or a budget change fails here as a diff.
    expect(actual).toEqual(EXPECTED_EFFECTIVE_BUDGETS);

    // Every resolved budget must be a finite, positive number — a declared
    // `economy.budgetTokens` of Infinity, NaN, 0, or a negative value must
    // FAIL this test (the runtime seam fails open on such values per DR-1,
    // but the static registry must never ship one).
    for (const [key, budget] of Object.entries(actual)) {
      expect(
        Number.isFinite(budget) && budget > 0,
        `${key} resolved a non-finite / non-positive budget: ${budget}`,
      ).toBe(true);
    }
  });

  it('registryEconomy_VerboseByDesignAllowlist_DeclaresExplicitHigherBudget', () => {
    const findAction = (tool: string, action: string): ToolAction => {
      const found = TOOL_REGISTRY.find((t) => t.name === tool)?.actions.find(
        (a) => a.name === action,
      );
      expect(found, `${tool}.${action} must exist`).toBeDefined();
      return found as ToolAction;
    };

    // The verbose-by-design allowlist: every `describe` variant + `runbook`
    // declares an explicit `economy.budgetTokens` strictly above the default.
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

    // The event `describe` budget must sit strictly above the base describe
    // budget because it additionally carries the `emissionGuide` param path
    // (the full event catalog), which is a param of the one describe action,
    // not a separate action.
    expect(EVENT_DESCRIBE_ECONOMY_BUDGET_TOKENS).toBeGreaterThan(DESCRIBE_ECONOMY_BUDGET_TOKENS);

    // Nothing outside the allowlist declares an economy block — a stray
    // declaration would silently widen the budget surface.
    const declared = TOOL_REGISTRY.flatMap((t) =>
      t.actions
        .filter((a) => a.economy !== undefined)
        .map((a) => `${t.name}.${a.name}`),
    ).sort();
    expect(declared).toEqual(
      [
        'exarchos_event.describe',
        'exarchos_orchestrate.describe',
        'exarchos_orchestrate.runbook',
        'exarchos_view.describe',
        'exarchos_workflow.describe',
      ].sort(),
    );
  });

  it('describeAction_WithBudget_SurfacesBudgetTokens', async () => {
    const orchestrate = TOOL_REGISTRY.find((t) => t.name === 'exarchos_orchestrate')!;
    const result = await handleDescribe(
      { actions: ['describe', 'runbook', 'task_claim'] },
      orchestrate.actions,
    );

    expect(result.success).toBe(true);
    if (!result.success) return;
    const data = result.data as Record<string, { economyBudgetTokens?: unknown }>;

    // Verbose actions surface their declared budget; a default action
    // surfaces the registry default. The slot is present on every entry
    // (every action resolves a concrete budget), not only declared ones.
    expect(data.describe.economyBudgetTokens).toBe(DESCRIBE_ECONOMY_BUDGET_TOKENS);
    expect(data.runbook.economyBudgetTokens).toBe(RUNBOOK_ECONOMY_BUDGET_TOKENS);
    expect(data.task_claim.economyBudgetTokens).toBe(DEFAULT_ECONOMY_BUDGET_TOKENS);

    // The surfaced number is exactly what the resolver returns for the action.
    const taskClaim = orchestrate.actions.find((a) => a.name === 'task_claim')!;
    expect(data.task_claim.economyBudgetTokens).toBe(resolveEconomyBudget(taskClaim));
  });
});

// ─── Task 022 (DR-1/DR-3/DR-8) — registry schema batch ───────────────────────
//
// Task 022 is the SOLE owner of the economy-work `registry.ts` schema edits:
// (a) new INPUT params — `get_pr_comments` window/projection, `assess_stack`
// comment paging, the coerced-int-array `prNumbers` swap, and `detail`+paging on
// the DR-8 view batch — all schema-declared so they auto-emit to CLI flags via
// schema-to-flags; and (b) the `{summary, counts, firstPage}` capped-shape union
// into every action carrying a typed `data` outputSchema, so each such schema is
// TOTAL over its emittable shapes (baseline + capped) — the D.5 totality the MCP
// adapter enforces (adapters/mcp.ts:245) and the §05 output-codegen precondition.
describe('Task 022 — registry schema batch (DR-1/DR-3/DR-8)', () => {
  function findAction(toolName: string, actionName: string): ToolAction {
    const tool = TOOL_REGISTRY.find((t) => t.name === toolName);
    const action = tool?.actions.find((a) => a.name === actionName);
    if (action === undefined) throw new Error(`action '${toolName}.${actionName}' not registered`);
    return action;
  }

  /** Every action across the registry whose success-branch `data` is typed. */
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

  // The generic capped-fallback `data` the dispatch-core economy seam (Task 003)
  // emits — three sibling keys. Constructed literally (NOT imported from the
  // schema under test) so the assertion pins the CONTRACT, not the definition.
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

  // A minimal VALID baseline `data` per typed-output action, shape-derived from
  // the real handler returns (verbs/worktree/schemas.ts,
  // TelemetryViewDataSchema). Keyed `tool.action`.
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
    // The `inspect` cold-probe projection is its minimal valid baseline: the
    // exists-branch fields (state/artifacts/taskProgress/correlation) are all
    // optional, so the workflowExists:false shape is the floor.
    'exarchos_view.inspect': {
      featureId: 'f', workflowExists: false, recentEvents: [], eventCount: 0,
    },
    // The `export` cold-probe shape is its minimal valid baseline: the
    // exported-branch fields (outputPath/contentHash/eventCount/...) are all
    // optional, so the workflowExists:false / exported:false shape is the floor.
    'exarchos_view.export': {
      featureId: 'f', workflowExists: false, exported: false,
    },
    // `invariants_amend` (task 068). The dry-run branch is the minimal valid
    // baseline: `renderedEntry`/`diff` are dry-run-only and `events` is
    // commit-only, so all three are optional and the floor is the required
    // core plus a non-empty `patchedFields`.
    'exarchos_orchestrate.invariants_amend': {
      committed: false, id: 'INV-17', tier: 'dev',
      catalog: '.exarchos/invariants.md', patchedFields: ['summary'],
      next_actions: [],
    },
    // DR-4 / task 069: the invariant-conformance gate, paid down from
    // `vacuityWaiver` to a real schema. The baseline is its minimal emittable
    // shape — every declared field is required, including the audit-mode
    // delivery pair (`auditPrompt` + `auditInvariantIds`) a reader is now
    // instructed to act on. Their being required is the point: an optional field
    // is not something a reader can be told to iterate.
    'exarchos_orchestrate.check_invariant_conformance': {
      verdict: 'APPROVED', high: 0, medium: 0, low: 0, findings: [],
      auditPrompt: '', auditInvariantIds: [], auditProjection: 'no-audit-entries',
      applicableCount: 0, report: 'PASS',
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
    it('get_pr_comments declares and coerces limit/offset/fields', () => {
      const schema = findAction('exarchos_orchestrate', 'get_pr_comments').schema;
      const parsed = schema.safeParse({
        prId: '42',
        limit: '20',        // numeric string → coerced int
        offset: '5',        // numeric string → coerced int
        fields: '["body","author"]', // JSON-array string → coerced string[]
      });
      expect(parsed.success).toBe(true);
      if (!parsed.success) return;
      const data = parsed.data as Record<string, unknown>;
      expect(data.limit).toBe(20);
      expect(data.offset).toBe(5);
      expect(data.fields).toEqual(['body', 'author']);
    });

    it('assess_stack declares comment paging and coerces prNumbers as an int array', () => {
      const schema = findAction('exarchos_orchestrate', 'assess_stack').schema;
      // JSON-array string prNumbers + numeric-string paging.
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
      // Array of numeric strings → coerced element-wise to ints.
      const fromStringElements = schema.safeParse({
        featureId: 'feat-x',
        prNumbers: ['1', '2', '3'],
      });
      expect(fromStringElements.success).toBe(true);
      if (fromStringElements.success) {
        expect((fromStringElements.data as Record<string, unknown>).prNumbers).toEqual([1, 2, 3]);
      }
      // B-3 regression (review): a bare CSV string — the shape `coerceFlags`
      // produces for an array flag, AND the shape a direct-MCP caller may pass —
      // coerces to the same int array. Before the fix `prNumbers` bound a LOCAL
      // stub that was NOT CSV-tolerant, so this yielded INVALID_INPUT while the
      // tested helper (`coerce.ts`) was dead in production.
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
      // CSV form coerces identically (shared CSV-tolerant helper).
      const fromCsv = schema.safeParse({ owner: 'acme', repo: 'app', prNumbers: '1,2' });
      expect(fromCsv.success).toBe(true);
      if (fromCsv.success) {
        expect((fromCsv.data as Record<string, unknown>).prNumbers).toEqual([1, 2]);
      }
    });

    it('prepare_delegation declares the DR-4 detail/outputFormat escape hatch', () => {
      // Review regression: the handler honored `detail`/`outputFormat` but the
      // schema declared neither, so Zod `.strip()` dropped them on the MCP path
      // (and the CLI emitted no flag) — the DR-4 affordance was unreachable
      // through both facades while its two covering tests bypassed the schema.
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

      // Omitted → the schema default 'full' (dispatch injects it; the handler
      // treats 'full' as the non-detail default — same as the field being absent).
      const omitted = schema.safeParse({ featureId: 'feat-x' });
      expect(omitted.success).toBe(true);
      if (omitted.success) {
        expect((omitted.data as Record<string, unknown>).outputFormat).toBe('full');
      }

      // An out-of-enum value is rejected at the schema boundary (dispatch path).
      const invalid = schema.safeParse({ featureId: 'feat-x', outputFormat: 'verbose' });
      expect(invalid.success).toBe(false);
    });

    it('DR-8 view batch declares detail + paging inputs', () => {
      // A representative slice across the inventory (Task 013) and analytic
      // (Task 024) view batches: each must RETAIN detail + paging after parse
      // (a stripped/undeclared field would be dropped by z.object).
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
    it('every typed-output action validates a {summary,counts,firstPage} capped envelope', () => {
      const actions = typedOutputActions();
      // Enumerated from code, not assumed — the post-002 base carried 8 (the two
      // exarchos_workflow LCD schemas wrap EnvelopeSchema(z.unknown()) and are
      // NOT typed). The worktree-lifecycle `inspect` verb (DR-4) added a 9th
      // typed-output view action; the `export` verb (DR-6) adds the 10th.
      //
      // The 11th and 12th arrived by DIFFERENT routes, and the distinction is
      // the interesting part: `invariants_amend` (task 068) is a NEW action
      // declared substantively because a new action cannot acquire a shrink-only
      // vacuity waiver, while `check_invariant_conformance` (task 069) is the
      // first entry to LEAVE the allowlist rather than arrive typed. One route
      // holds the line, the other pays the debt down.
      expect(actions.length).toBe(12);
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
    it('every typed-output action admits BOTH its baseline and the capped shape', () => {
      const actions = typedOutputActions();
      for (const { tool, action } of actions) {
        const key = `${tool}.${action.name}`;
        const baseline = baselineDataByAction[key];
        expect(baseline, `missing baseline fixture for ${key}`).toBeDefined();

        // Baseline shape validates (the pre-cap emittable shape).
        const baselineParsed = action.outputSchema.safeParse(baselineEnvelope(baseline));
        expect(
          baselineParsed.success,
          `${key} must admit its baseline shape: ${
            baselineParsed.success ? '' : JSON.stringify(baselineParsed.error.issues)
          }`,
        ).toBe(true);

        // Capped shape validates (the post-cap emittable shape) — totality.
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
});
