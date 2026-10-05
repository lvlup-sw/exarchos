/**
 * Registration guard for the shared lifecycle field shapes in `projections/views/lifecycle/schema-fields.ts`.
 *
 * `buildRegistrationSchema` throws when two actions give one field name a different base kind,
 * enum value set or default. Each test adds a probe action with the shared shapes to the real
 * `exarchos_view` actions, then builds the registration schema.
 * The subjects are the real `buildRegistrationSchema` and the real `TOOL_REGISTRY`, with no mocks.
 */

import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { buildRegistrationSchema, TOOL_REGISTRY } from '../../src/registry.js';
import type { ToolAction, CompositeTool } from '../../src/registry.js';
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
} from '../../src/projections/views/lifecycle/schema-fields.js';

/** Returns the `exarchos_view` tool from `TOOL_REGISTRY`. */
function viewTool(): CompositeTool {
  const tool = TOOL_REGISTRY.find((t) => t.name === 'exarchos_view');
  if (!tool) throw new Error('exarchos_view tool missing from TOOL_REGISTRY');
  return tool;
}

/**
 * Builds a probe `ToolAction` from the metadata of the real `pipeline` action, with its own `name` and `schema`.
 * `buildRegistrationSchema` reads only `name` and `schema.shape`.
 * The lookup is by name, so a reorder of the view actions cannot change the template.
 */
function probeAction(name: string, shape: z.ZodRawShape): ToolAction {
  const template = viewTool().actions.find((a) => a.name === 'pipeline');
  if (!template) throw new Error('exarchos_view.pipeline action missing — probe template invalid');
  return { ...template, name, surface: undefined, schema: z.object(shape) };
}

/** The shared field names that a shipped `exarchos_view` action also declares. */
const COLLIDING_NAMES: readonly LifecycleFieldName[] = ['scope', 'phase', 'workflowType', 'limit'];

describe('DR-8 shared lifecycle field shapes — registration construction', () => {
  /** The composed schema must also hold each shared field name. */
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

    const schema = buildRegistrationSchema([...actions, probe]);
    for (const name of Object.keys(LIFECYCLE_FIELD_SHAPES)) {
      expect(name in schema.shape).toBe(true);
    }
  });

  /**
   * First, a shipped view action must declare each colliding name, or the comparison proves nothing.
   * Then each shared shape must compose with the real actions without a throw.
   * The negative controls prove that the guard rejects a wrong base kind and a wrong enum value set.
   * The shared `scope` is the union `['repo','all','workflow','worktree']`, so a probe with three members collides.
   */
  it('SchemaFields_BaseTypes_MatchExistingViewFieldsWhereNamesCollide', () => {
    const actions = viewTool().actions;

    for (const name of COLLIDING_NAMES) {
      const declaredBy = actions.filter((a) => name in a.schema.shape);
      expect(
        declaredBy.length,
        `expected an existing exarchos_view action to declare '${name}'`,
      ).toBeGreaterThan(0);
    }

    for (const name of COLLIDING_NAMES) {
      const probe = probeAction(`__probe_${name}__`, {
        [name]: LIFECYCLE_FIELD_SHAPES[name].optional(),
      });
      expect(
        () => buildRegistrationSchema([...actions, probe]),
        `shared '${name}' shape must match the existing exarchos_view base type`,
      ).not.toThrow();
    }

    expect(
      () => buildRegistrationSchema([...actions, probeAction('__wrong_scope_kind__', { scope: z.string().optional() })]),
      'scope as z.string() must collide with pipeline.scope (enum vs string)',
    ).toThrow();
    expect(
      () => buildRegistrationSchema([...actions, probeAction('__wrong_limit_kind__', { limit: z.string().optional() })]),
      'limit as z.string() must collide with the shared numeric limit',
    ).toThrow();
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

  /**
   * Pins the base type of each shared shape directly, for the colliding names and the others.
   * `scope` accepts each member of the `pipeline` subset and of the `ps` subset, and rejects other values.
   * `limit` coerces a numeric string. It rejects zero, a negative number and a string that is not numeric.
   */
  it('SchemaFields_BaseTypes_ArePinnedStructurally', () => {
    expect(scopeField.safeParse('repo').success).toBe(true);
    expect(scopeField.safeParse('all').success).toBe(true);
    expect(scopeField.safeParse('workflow').success).toBe(true);
    expect(scopeField.safeParse('worktree').success).toBe(true);
    expect(scopeField.safeParse('bogus-scope').success).toBe(false);

    for (const s of [statusField, phaseField, workflowTypeField, outputField, operationField]) {
      expect(s).toBeInstanceOf(z.ZodString);
    }

    for (const b of [allField, followField]) {
      expect(b).toBeInstanceOf(z.ZodBoolean);
    }

    expect(limitField.parse('5')).toBe(5);
    expect(limitField.parse(10)).toBe(10);
    expect(limitField.safeParse('-1').success).toBe(false);
    expect(limitField.safeParse('0').success).toBe(false);
    expect(limitField.safeParse('abc').success).toBe(false);
  });
});
