/**
 * Tests for the parameter-acceptance rule of a composite tool: the action that receives a parameter
 * honors it, or dispatch refuses it.
 *
 * The unit suites cover the rule. `selectForwardedParameters` forwards declared keys, exempts
 * transport keys, and drops an SDK-injected default by value. `findIgnoredParameters` reports a key
 * that the schema discarded. The census walks each action of `getFullRegistry()` against each key
 * that only a sibling declares.
 */

import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import {
  selectForwardedParameters,
  findIgnoredParameters,
  buildIgnoredParameterError,
} from '../../../src/dispatch/undeclared-parameters.js';
import { getFullRegistry, type ToolAction } from '../../../src/registry.js';
import { unregisteredActionOutputSchema } from '../../../src/output-schema-declaration.js';

/**
 * Builds a fixture `ToolAction`. A fixture is outside the built-in registry and has no census id,
 * so its output schema comes from `unregisteredActionOutputSchema()`.
 */
function action(name: string, schema: z.ZodObject<z.ZodRawShape>): ToolAction {
  return {
    name,
    description: `${name} test action`,
    schema,
    phases: new Set<string>(['plan']),
    roles: new Set<string>(['lead']),
    outputSchema: unregisteredActionOutputSchema(),
    annotations: {
      safety: 'read-only',
      readOnly: true,
      destructive: false,
      idempotent: true,
      openWorld: false,
    },
  };
}

describe('selectForwardedParameters — carrier and SDK noise vs the caller (DR-7)', () => {
  const cancel = action('cancel', z.object({ featureId: z.string(), dryRun: z.boolean().optional() }));
  const transition = action('transition', z.object({ featureId: z.string(), target: z.string() }));
  const prepare = action('prepare', z.object({
    featureId: z.string(),
    nativeIsolation: z.boolean().default(false),
  }));
  const actions = [cancel, transition, prepare];

  it('ForwardedParameters_DeclaredKeys_AreForwardedAndShaped', () => {
    const { forwarded, unshaped } = selectForwardedParameters(
      { featureId: 'f', target: 'plan-review' },
      transition,
      actions,
    );
    expect(unshaped).toEqual([]);
    expect(forwarded).toEqual({ featureId: 'f', target: 'plan-review' });
  });

  /**
   * A key that only a sibling declares must reach the parse, where the receiving schema decides.
   * If the selection drops `dryRun`, `transition` runs for real.
   */
  it('ForwardedParameters_SiblingDeclaredDryRun_SurvivesToTheParseAsUnshaped', () => {
    const { forwarded, unshaped } = selectForwardedParameters(
      { featureId: 'f', target: 'plan-review', dryRun: true },
      transition,
      actions,
    );
    expect(unshaped).toEqual(['dryRun']);
    expect(forwarded.dryRun).toBe(true);
  });

  /**
   * `_meta` carries the MCP correlation ids on every call and belongs to no action. Without the
   * exemption, the rule refuses the transport envelope.
   */
  it('ForwardedParameters_TransportMeta_IsExempt', () => {
    const { forwarded, unshaped } = selectForwardedParameters(
      { featureId: 'f', target: 'plan-review', _meta: { correlationId: 'c' } },
      transition,
      actions,
    );
    expect(unshaped).toEqual([]);
    expect(Object.hasOwn(forwarded, '_meta')).toBe(false);
  });

  /**
   * The SDK validates against the flattened tool schema. It injects `nativeIsolation: false`, the
   * declared default, into a payload that never held that key.
   */
  it('ForwardedParameters_SdkInjectedDefault_IsDroppedByValue', () => {
    const { forwarded, unshaped } = selectForwardedParameters(
      { featureId: 'f', target: 'plan-review', nativeIsolation: false },
      transition,
      actions,
    );
    expect(unshaped).toEqual([]);
    expect(Object.hasOwn(forwarded, 'nativeIsolation')).toBe(false);
  });

  /**
   * The exemption compares values. `false` is the injected default, and `true` comes from the
   * caller. If the exemption also drops `true`, a caller value for any defaulted field is lost with
   * no report.
   */
  it('ForwardedParameters_SiblingDefaultFieldWithNonDefaultValue_IsNotDropped', () => {
    const { unshaped } = selectForwardedParameters(
      { featureId: 'f', target: 'plan-review', nativeIsolation: true },
      transition,
      actions,
    );
    expect(unshaped).toEqual(['nativeIsolation']);
  });

  /**
   * An `.optional()` field parses `undefined` to `undefined`. That result is not a default, so the
   * key stays unshaped.
   */
  it('ForwardedParameters_OptionalSiblingFieldProbedWithUndefined_IsNotTreatedAsADefault', () => {
    const { unshaped } = selectForwardedParameters(
      { featureId: 'f', target: 'plan-review', dryRun: undefined },
      transition,
      actions,
    );
    expect(unshaped).toEqual(['dryRun']);
  });
});

describe('findIgnoredParameters — the schema answers for its own keys (DR-7)', () => {
  it('IgnoredParameters_StripModeObject_ReportsTheDiscardedKey', () => {
    const strip = z.object({ featureId: z.string(), target: z.string() });
    const parsed = strip.parse({ featureId: 'f', target: 't', dryRun: true });
    expect(findIgnoredParameters(['dryRun'], parsed)).toEqual(['dryRun']);
  });

  /**
   * A `.passthrough()` action keeps the key in the parse output, so the rule reports nothing. The
   * action itself accepts or rejects the key. `exarchos_orchestrate.prune_stale_workflows` has this
   * shape.
   */
  it('IgnoredParameters_PassthroughObject_ReportsNothing', () => {
    const loose = z.object({ featureId: z.string() }).passthrough();
    const parsed = loose.parse({ featureId: 'f', now: 'not-a-date' });
    expect(findIgnoredParameters(['now'], parsed)).toEqual([]);
  });

  /** A declared optional that the caller sets to `undefined` keeps its key in the parse output. */
  it('IgnoredParameters_DeclaredOptionalGivenExplicitUndefined_IsNotReportedIgnored', () => {
    const strip = z.object({ featureId: z.string(), dryRun: z.boolean().optional() });
    const parsed = strip.parse({ featureId: 'f', dryRun: undefined });
    expect(findIgnoredParameters([], parsed)).toEqual([]);
    expect(Object.hasOwn(parsed, 'dryRun')).toBe(true);
  });

  it('IgnoredParameterError_NamesTheDeclaringSiblingAndTheRealParameterList', () => {
    const cancel = action('cancel', z.object({ featureId: z.string(), dryRun: z.boolean().optional() }));
    const transition = action('transition', z.object({ featureId: z.string(), target: z.string() }));
    const err = buildIgnoredParameterError(
      'exarchos_workflow',
      transition,
      [cancel, transition],
      ['dryRun'],
    );
    expect(err.code).toBe('INVALID_INPUT');
    expect(err.message).toContain('dryRun');
    expect(err.message).toContain('exarchos_workflow.cancel');
    expect(err.message).toContain('featureId, target');
  });
});

/**
 * The scan root is every tool of `getFullRegistry()` that declares actions. It includes the hidden
 * tools, because the CLI still reaches them.
 */
describe('Registry-wide parameter-acceptance census (DR-7 sweep, DR-8 denominator)', () => {
  const registry = getFullRegistry().filter((t) => t.actions.length > 0);

  /**
   * The denominator guard for the census. It requires more than one tool and more than one action.
   * A scan root that is narrowed to one tool or one action thus fails here.
   */
  it('ParameterCensus_ScanRoot_CoversEveryRegisteredCompositeAction', () => {
    const declaredActions = registry.reduce((n, t) => n + t.actions.length, 0);
    let visited = 0;
    for (const tool of registry) for (const _action of tool.actions) visited++;
    expect(visited).toBe(declaredActions);
    expect(registry.length).toBeGreaterThan(1);
    expect(declaredActions).toBeGreaterThan(1);
  });

  /**
   * For each action and each key that only a sibling declares, the key must reach the parse as
   * unshaped. The probe value is never the injectable default of the field, so the default
   * exemption cannot hide a drop. A symbol never equals a scalar default.
   *
   * A parse failure counts as a refusal by the schema. After a successful parse, the action must
   * keep the key, or `findIgnoredParameters` must report it. The sweep must check more than 100
   * pairs, so a registry with no sibling-only key cannot pass with zero pairs.
   */
  it('ParameterCensus_EverySiblingDeclaredKey_IsHonouredOrRefusedByEveryActionThatOmitsIt', () => {
    const survivors: string[] = [];
    let pairsChecked = 0;

    for (const tool of registry) {
      for (const receiving of tool.actions) {
        const own = receiving.schema.shape;
        for (const sibling of tool.actions) {
          if (sibling.name === receiving.name) continue;
          for (const [key, field] of Object.entries(sibling.schema.shape)) {
            if (Object.prototype.hasOwnProperty.call(own, key)) continue;
            pairsChecked++;

            const probeValue: unknown =
              z.safeParse(field, undefined).data === undefined ? true : Symbol('non-default');

            const { forwarded, unshaped } = selectForwardedParameters(
              { [key]: probeValue },
              receiving,
              tool.actions,
            );
            if (!unshaped.includes(key)) {
              survivors.push(`${tool.name}.${receiving.name} drops "${key}" before validation`);
              continue;
            }

            const parsed = receiving.schema.safeParse(forwarded);
            if (!parsed.success) continue;
            const ignored = findIgnoredParameters(unshaped, parsed.data);
            const keptByAction = Object.prototype.hasOwnProperty.call(parsed.data, key);
            if (!ignored.includes(key) && !keptByAction) {
              survivors.push(`${tool.name}.${receiving.name} silently ignores "${key}"`);
            }
          }
        }
      }
    }

    expect(pairsChecked).toBeGreaterThan(100);
    expect(survivors).toEqual([]);
  });

  /**
   * `transition` does not declare `dryRun` and `cancel` does, so this pair is in the swept set. If
   * a refactor moves either one out of the set, this test fails.
   */
  it('ParameterCensus_TheOriginalInstance_IsInsideTheSweptPopulation', () => {
    const workflow = registry.find((t) => t.name === 'exarchos_workflow');
    expect(workflow).toBeDefined();
    const transition = workflow!.actions.find((a) => a.name === 'transition');
    expect(transition).toBeDefined();
    expect(Object.hasOwn(transition!.schema.shape, 'dryRun')).toBe(false);

    const declaresDryRun = workflow!.actions
      .filter((a) => Object.hasOwn(a.schema.shape, 'dryRun'))
      .map((a) => a.name);
    expect(declaresDryRun).toContain('cancel');

    const { forwarded, unshaped } = selectForwardedParameters(
      { featureId: 'f', target: 'synthesize', dryRun: true },
      transition!,
      workflow!.actions,
    );
    const parsed = transition!.schema.parse(forwarded);
    expect(findIgnoredParameters(unshaped, parsed)).toEqual(['dryRun']);
  });

  /**
   * `handleCancel` reads `input.reason` and records it on the cancel event. The `cancel` action
   * schema must declare `reason`. If it does not, dispatch refuses a parameter that the handler
   * supports.
   */
  it('ParameterCensus_CancelReason_IsDeclaredNotMerelyConsumed', () => {
    const workflow = registry.find((t) => t.name === 'exarchos_workflow');
    const cancel = workflow!.actions.find((a) => a.name === 'cancel');
    expect(cancel).toBeDefined();
    expect(Object.hasOwn(cancel!.schema.shape, 'reason')).toBe(true);

    const parsed = cancel!.schema.parse({ featureId: 'f', reason: 'why' });
    expect(parsed.reason).toBe('why');
  });
});
