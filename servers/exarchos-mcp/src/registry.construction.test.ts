// ─── DR-8: registration-construction guard for the shared lifecycle field shapes ──
//
// `buildRegistrationSchema` flattens every action of a composite tool into one
// strict object and THROWS when two actions declare the same field name with a
// divergent contract (base kind / enum value set / default). The lifecycle
// verbs (`ps`/`wait`/`inspect`/`export`) all source their shared field names
// from `views/lifecycle/schema-fields.ts`; this contract test composes the REAL
// `exarchos_view` registration PLUS a probe action carrying every shared shape
// and asserts registration constructs without throwing — and that the shapes
// whose names ALSO exist on shipped view actions match the existing base type
// exactly (with negative controls proving the guard is live, not vacuous).
//
// No mocks: the real `buildRegistrationSchema` and the real `TOOL_REGISTRY`
// view actions are the subjects under test.

import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { buildRegistrationSchema, TOOL_REGISTRY } from './registry.js';
import type { ToolAction, CompositeTool } from './registry.js';
import {
  LIFECYCLE_FIELD_SHAPES,
  scopeField,
  statusField,
  phaseField,
  workflowTypeField,
  allField,
  followField,
  limitField,
  outputField,
  operationField,
  type LifecycleFieldName,
} from './projections/views/lifecycle/schema-fields.js';

/** The real, un-mocked `exarchos_view` composite tool. */
function viewTool(): CompositeTool {
  const tool = TOOL_REGISTRY.find((t) => t.name === 'exarchos_view');
  if (!tool) throw new Error('exarchos_view tool missing from TOOL_REGISTRY');
  return tool;
}

/**
 * A structurally valid probe `ToolAction` reusing a real view action's
 * non-schema metadata (phases/roles/outputSchema/annotations) and overriding
 * only `name` + `schema` — so `buildRegistrationSchema` (which reads only
 * `name` + `schema.shape`) sees the probe's fields against the real registry.
 */
function probeAction(name: string, shape: z.ZodRawShape): ToolAction {
  // Look the template up BY NAME: `actions[0]` assumed `pipeline` sits first, so
  // a reordering would silently swap in another action's metadata instead of
  // failing loudly.
  const template = viewTool().actions.find((a) => a.name === 'pipeline');
  if (!template) throw new Error('exarchos_view.pipeline action missing — probe template invalid');
  return { ...template, name, surface: undefined, schema: z.object(shape) };
}

/** Field names the shared module defines that ALSO exist on a shipped view action. */
const COLLIDING_NAMES: readonly LifecycleFieldName[] = ['scope', 'phase', 'workflowType', 'limit'];

describe('DR-8 shared lifecycle field shapes — registration construction', () => {
  it('RegistryConstruction_WithAllLifecycleFieldShapes_DoesNotThrow', () => {
    const actions = viewTool().actions;
    const probe = probeAction('__lifecycle_field_probe__', {
      scope: scopeField.optional(),
      status: statusField.optional(),
      phase: phaseField.optional(),
      workflowType: workflowTypeField.optional(),
      all: allField.optional(),
      follow: followField.optional(),
      limit: limitField.optional(),
      output: outputField.optional(),
      operation: operationField.optional(),
    });

    expect(() => buildRegistrationSchema([...actions, probe])).not.toThrow();

    // Sanity: the composed schema is real and carries the probe's fields.
    const schema = buildRegistrationSchema([...actions, probe]);
    for (const name of Object.keys(LIFECYCLE_FIELD_SHAPES)) {
      expect(name in schema.shape).toBe(true);
    }
  });

  it('SchemaFields_BaseTypes_MatchExistingViewFieldsWhereNamesCollide', () => {
    const actions = viewTool().actions;

    // Premise guard: each colliding name is genuinely declared by ≥1 shipped
    // view action, so the alignment below is meaningful (not vacuously green if
    // an upstream action drops the field).
    for (const name of COLLIDING_NAMES) {
      const declaredBy = actions.filter((a) => name in a.schema.shape);
      expect(
        declaredBy.length,
        `expected an existing exarchos_view action to declare '${name}'`,
      ).toBeGreaterThan(0);
    }

    // Each shared shape composes with the real registration without throwing —
    // proving its base type matches the existing inline declaration exactly.
    for (const name of COLLIDING_NAMES) {
      const probe = probeAction(`__probe_${name}__`, {
        [name]: LIFECYCLE_FIELD_SHAPES[name].optional(),
      });
      expect(
        () => buildRegistrationSchema([...actions, probe]),
        `shared '${name}' shape must match the existing exarchos_view base type`,
      ).not.toThrow();
    }

    // Negative controls — a WRONG base type for a colliding name DOES throw,
    // proving the guard discriminates and the alignment is load-bearing.
    expect(
      () => buildRegistrationSchema([...actions, probeAction('__wrong_scope_kind__', { scope: z.string().optional() })]),
      'scope as z.string() must collide with pipeline.scope (enum vs string)',
    ).toThrow();
    expect(
      () => buildRegistrationSchema([...actions, probeAction('__wrong_limit_kind__', { limit: z.string().optional() })]),
      'limit as z.string() must collide with the shared numeric limit',
    ).toThrow();
    // The DR-3 hazard specifically: a scope enum with the wrong VALUE SET (base
    // kind matches, values diverge) still throws — proving the guard discriminates
    // on the value set, not just the base kind. Task 007 widened the shared scope
    // to the UNION ['repo','all','workflow','worktree'] (4 members); a probe
    // declaring only a 3-member subset diverges from that union and collides.
    expect(
      () =>
        buildRegistrationSchema([
          ...actions,
          probeAction('__wrong_scope_values__', {
            scope: z.enum(['workflow', 'worktree', 'all']).optional(),
          }),
        ]),
      "scope value set ['workflow','worktree','all'] must collide with the widened union scope ['repo','all','workflow','worktree']",
    ).toThrow();
  });

  it('SchemaFields_BaseTypes_ArePinnedStructurally', () => {
    // Direct base-type assertions on every shared shape — a mutation to any
    // field's base type (colliding or not) flips one of these red, so the
    // adequacy guard has teeth beyond the collision oracle above.

    // enum ['repo','all','workflow','worktree'] (the task-007 widened union) —
    // accepts every member of BOTH the pipeline (`repo`/`all`) and ps
    // (`workflow`/`worktree`/`all`) subsets, and rejects a non-member.
    expect(scopeField.safeParse('repo').success).toBe(true);
    expect(scopeField.safeParse('all').success).toBe(true);
    expect(scopeField.safeParse('workflow').success).toBe(true);
    expect(scopeField.safeParse('worktree').success).toBe(true);
    expect(scopeField.safeParse('bogus-scope').success).toBe(false);

    // string base type.
    for (const s of [statusField, phaseField, workflowTypeField, outputField, operationField]) {
      expect(s).toBeInstanceOf(z.ZodString);
    }

    // boolean base type.
    for (const b of [allField, followField]) {
      expect(b).toBeInstanceOf(z.ZodBoolean);
    }

    // coerced positive integer — coerces numeric strings, rejects non-positive
    // and non-numeric (matches the shared `coercedPositiveInt()` `limit`).
    expect(limitField.parse('5')).toBe(5);
    expect(limitField.parse(10)).toBe(10);
    expect(limitField.safeParse('-1').success).toBe(false);
    expect(limitField.safeParse('0').success).toBe(false);
    expect(limitField.safeParse('abc').success).toBe(false);
  });
});
