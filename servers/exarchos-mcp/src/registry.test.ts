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
  WorkflowSetOutputSchema,
  WorkflowTransitionOutputSchema,
  WorkflowUpdateOutputSchema,
} from './registry.js';
import type { ToolAction, CompositeTool, ActionAnnotations } from './registry.js';
import { wrap, wrapError } from './format.js';
import { zodToJsonSchema } from './adapters/json-schema.js';
import { ConcurrencyError } from './event-store/concurrency-error.js';

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
    it('should have 10 actions: init, get, transition, update, cancel, cleanup, reconcile, rehydrate, checkpoint, describe', () => {
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
      expect(actionNames).toEqual(['init', 'get', 'transition', 'update', 'cancel', 'cleanup', 'reconcile', 'rehydrate', 'checkpoint', 'describe']);
    });
  });

  describe('exarchos_orchestrate', () => {
    it('should have 69 actions for task management, review triage, gate checks, validation handlers, runbooks, agent spec, oneshot/pruning, doctor, init, VCS, classify_review_items (#1159), merge_orchestrate (DR-MO-1), check_integration_suite (#1329), check_invariant_conformance (DR-3), invariants_scaffold/invariants_add (invariants-catalog-wizard P2), and composite actions', () => {
      const composite = findComposite('exarchos_orchestrate');
      expect(composite).toBeDefined();
      expect(composite!.actions).toHaveLength(69);

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
        ]),
      );
    });
  });

  it('OrchestrateActions_MatchCompositeHandlers_InSync', async () => {
    const composite = findComposite('exarchos_orchestrate');
    expect(composite).toBeDefined();
    const registryNames = new Set(composite!.actions.map((a) => a.name));

    const { ACTION_HANDLER_KEYS } = await import('./orchestrate/composite.js');

    // Actions that are handled specially in the composite router (not via ACTION_HANDLERS).
    // invariants_scaffold / invariants_add use explicit dispatch branches (like
    // init/doctor) because they need injected fs hooks + DispatchContext.
    const SPECIAL_ACTIONS = new Set([
      'describe',
      'runbook',
      'doctor',
      'init',
      'invariants_scaffold',
      'invariants_add',
    ]);

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

    // T1 (#1446 residue) — register the three view actions that are
    // dispatched through `views/composite.ts` today but were never added to
    // `TOOL_REGISTRY.viewActions`. Without the registry entry, per-action
    // Zod validation at `core/dispatch.ts:801` is silently skipped and
    // `exarchos_view describe` under-lists the dispatched surface.
    it('TOOL_REGISTRY_viewActions_IncludesSessionProvenanceProvenanceAndIdeateReadiness', () => {
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

      // ── ideate_readiness ──────────────────────────────────────────────
      // Handler: `handleViewIdeateReadiness(args, stateDir, eventStore)` —
      // queries the event store; same DR-5 correlation-tuple contract.
      const ideateReadiness = viewComposite!.actions.find(
        (a) => a.name === 'ideate_readiness',
      );
      expect(
        ideateReadiness,
        'ideate_readiness must be registered',
      ).toBeDefined();
      expect(
        ideateReadiness!.schema instanceof z.ZodObject,
        'ideate_readiness.schema must be a ZodObject',
      ).toBe(true);
      const ideateReadinessShape = (
        ideateReadiness!.schema as z.ZodObject
      ).shape;
      expect(ideateReadinessShape).toHaveProperty('operationId');
      expect(ideateReadinessShape).toHaveProperty('correlationId');
      expect(ideateReadinessShape).toHaveProperty('causationId');
      expect(
        ideateReadiness!.schema.safeParse({ workflowId: 'wf-1' }).success,
      ).toBe(true);
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

// ─── DR-11 (#1259): outputSchema registers _meta.deprecation ─────────────────
//
// T5a.1/DR-4 (v2.11): `set` action removed. Per INV-5b the
// `_meta.deprecation` schema slot is retained on `transition` for one
// more release as a historical marker (v2.12 drops the slot itself), so
// this test is narrowed to cover only the canonical action.
describe('Registry_OutputSchema (T40, DR-11)', () => {
  function findAction(toolName: string, actionName: string) {
    const tool = TOOL_REGISTRY.find((t) => t.name === toolName);
    return tool?.actions.find((a) => a.name === actionName);
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
// factory from `schemas/envelope.ts`. The constants remain as deprecated
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
    const mod = await import('./registry.js');
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
// `core/dispatch.ts:927-954`; this marker is advisory.
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
    // servers/exarchos-mcp/tsconfig.json's `**/*.test.ts` exclude).
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
// opt-in gate stays at `core/dispatch.ts:927-954` — so this test only
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
