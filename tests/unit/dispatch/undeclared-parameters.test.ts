// ─── DR-7 — the composite-level parameter-acceptance sweep ──────────────────
//
// Two layers of proof:
//
//   1. Unit — the rule itself: declared keys forwarded, transport keys exempt,
//      SDK-injected defaults dropped by VALUE, and a key the receiving schema
//      throws away reported as ignored.
//   2. Census — the whole registry. `exarchos_workflow.transition` × `dryRun`
//      was the instance that surfaced; the sweep exists so the NEXT one
//      cannot ship. Every (action, sibling-declared key) pair in the registry
//      is walked, and every pair must end in "honoured or refused".
//
// DR-8: the census states its scan root (`getFullRegistry()`, every composite
// tool that declares actions) and derives its denominator from that root
// rather than asserting a hand-written floor. A narrowed root — one tool, or
// one action — fails the denominator assertion below.

import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import {
  selectForwardedParameters,
  findIgnoredParameters,
  buildIgnoredParameterError,
} from '../../../src/dispatch/undeclared-parameters.js';
import { getFullRegistry, type ToolAction } from '../../../src/registry.js';
import { unregisteredActionOutputSchema } from '../../../src/output-schema-declaration.js';

function action(name: string, schema: z.ZodObject<z.ZodRawShape>): ToolAction {
  return {
    name,
    description: `${name} test action`,
    schema,
    phases: new Set<string>(['plan']),
    roles: new Set<string>(['lead']),
    // `outputSchema` and `annotations` are REQUIRED on ToolAction, and this
    // fixture claimed the type without them — it compiled only because the MCP
    // typecheck does not cover test sources, so the declared return type was
    // never actually checked against the interface it names.
    //
    // `unregisteredActionOutputSchema()` is the sanctioned escape for an action
    // outside the built-in registry, which is exactly what a fixture is: it has
    // no census id, so it must not borrow a waiver that belongs to a real one.
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

  it('ForwardedParameters_SiblingDeclaredDryRun_SurvivesToTheParseAsUnshaped', () => {
    // The live defect at the unit boundary: the old strip deleted `dryRun`
    // here, so `transition` ran for real. It must now reach the parse, where
    // the schema's verdict on it becomes readable.
    const { forwarded, unshaped } = selectForwardedParameters(
      { featureId: 'f', target: 'plan-review', dryRun: true },
      transition,
      actions,
    );
    expect(unshaped).toEqual(['dryRun']);
    expect(forwarded.dryRun).toBe(true);
  });

  it('ForwardedParameters_TransportMeta_IsExempt', () => {
    // `_meta` carries MCP correlation continuity on every call and belongs to
    // no action. Exempting it is what keeps the rule from refusing the
    // transport envelope itself.
    const { forwarded, unshaped } = selectForwardedParameters(
      { featureId: 'f', target: 'plan-review', _meta: { correlationId: 'c' } },
      transition,
      actions,
    );
    expect(unshaped).toEqual([]);
    expect(Object.hasOwn(forwarded, '_meta')).toBe(false);
  });

  it('ForwardedParameters_SdkInjectedDefault_IsDroppedByValue', () => {
    // The one case the old strip existed for: the SDK validates against the
    // flattened parent schema and injects `nativeIsolation: false` (the
    // declared default) into payloads the caller never put it in.
    const { forwarded, unshaped } = selectForwardedParameters(
      { featureId: 'f', target: 'plan-review', nativeIsolation: false },
      transition,
      actions,
    );
    expect(unshaped).toEqual([]);
    expect(Object.hasOwn(forwarded, 'nativeIsolation')).toBe(false);
  });

  it('ForwardedParameters_SiblingDefaultFieldWithNonDefaultValue_IsNotDropped', () => {
    // Value-discrimination is the whole point of the exemption: `false` is
    // the injected default and gets dropped, `true` was typed by a human and
    // must not be. Without this the exemption would re-open the hole for
    // every defaulted field.
    const { unshaped } = selectForwardedParameters(
      { featureId: 'f', target: 'plan-review', nativeIsolation: true },
      transition,
      actions,
    );
    expect(unshaped).toEqual(['nativeIsolation']);
  });

  it('ForwardedParameters_OptionalSiblingFieldProbedWithUndefined_IsNotTreatedAsADefault', () => {
    // `dryRun` is `.optional()`, so probing it with `undefined` parses
    // successfully — but yields `undefined`, not a default. Treating that as
    // an injectable default would silently drop every optional sibling field.
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

  it('IgnoredParameters_PassthroughObject_ReportsNothing', () => {
    // `exarchos_orchestrate.prune_stale_workflows` is exactly this shape: it
    // takes keys outside its declared shape and answers for them itself
    // (a `now` clock override; an actionable error for a removed knob). The
    // rule must stay out of the way when the action already handles the key.
    const loose = z.object({ featureId: z.string() }).passthrough();
    const parsed = loose.parse({ featureId: 'f', now: 'not-a-date' });
    expect(findIgnoredParameters(['now'], parsed)).toEqual([]);
  });

  it('IgnoredParameters_DeclaredOptionalGivenExplicitUndefined_IsNotReportedIgnored', () => {
    // Guards a false positive: a declared optional supplied as `undefined`
    // keeps its key in the parse output, so it must never read as discarded.
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

describe('Registry-wide parameter-acceptance census (DR-7 sweep, DR-8 denominator)', () => {
  // Scan root: every composite tool in the FULL registry (hidden tools
  // included — they stay reachable via the CLI) that declares actions.
  const registry = getFullRegistry().filter((t) => t.actions.length > 0);

  it('ParameterCensus_ScanRoot_CoversEveryRegisteredCompositeAction', () => {
    // Denominator, derived: the census below must visit exactly the number of
    // actions the registry declares. A narrowed root (one tool, one action)
    // reddens here rather than producing a green sweep over a smaller set.
    const declaredActions = registry.reduce((n, t) => n + t.actions.length, 0);
    let visited = 0;
    for (const tool of registry) for (const _action of tool.actions) visited++;
    expect(visited).toBe(declaredActions);
    expect(registry.length).toBeGreaterThan(1);
    expect(declaredActions).toBeGreaterThan(1);
  });

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

            // Probe with a value that is deliberately NOT the field's
            // injectable default, so the default-exemption cannot mask a
            // silent drop. A symbol can never equal a scalar default.
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

            // The action's own schema now answers. Either it rejects the
            // payload outright, or it keeps the key, or the dispatch refusal
            // fires. What must NOT happen is a successful parse that quietly
            // discarded the key with nothing reported.
            const parsed = receiving.schema.safeParse(forwarded);
            if (!parsed.success) continue; // schema's own rejection — honoured
            const ignored = findIgnoredParameters(unshaped, parsed.data);
            const keptByAction = Object.prototype.hasOwnProperty.call(parsed.data, key);
            if (!ignored.includes(key) && !keptByAction) {
              survivors.push(`${tool.name}.${receiving.name} silently ignores "${key}"`);
            }
          }
        }
      }
    }

    // Non-vacuity: the sweep must actually have examined pairs. A registry
    // refactor that collapsed every shared field would otherwise make this
    // test green by looking at nothing.
    expect(pairsChecked).toBeGreaterThan(100);
    expect(survivors).toEqual([]);
  });

  it('ParameterCensus_TheOriginalInstance_IsInsideTheSweptPopulation', () => {
    // Pins that the census's population actually contains the defect it was
    // written for. If a future refactor moves `transition` or `dryRun` out of
    // the swept set, this fails rather than the sweep going quietly green.
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

  it('ParameterCensus_CancelReason_IsDeclaredNotMerelyConsumed', () => {
    // The sweep's second find. `handleCancel` reads `input.reason` and stamps
    // it onto the cancel-requested event, and `CancelInputSchema` declares
    // it — but the ACTION schema did not, so dispatch discarded the
    // operator's stated reason and reported a successful cancel. Same shape
    // as `dryRun` on `transition`, opposite repair: the capability is real,
    // so the action declares it.
    const workflow = registry.find((t) => t.name === 'exarchos_workflow');
    const cancel = workflow!.actions.find((a) => a.name === 'cancel');
    expect(cancel).toBeDefined();
    expect(Object.hasOwn(cancel!.schema.shape, 'reason')).toBe(true);

    const parsed = cancel!.schema.parse({ featureId: 'f', reason: 'why' });
    expect(parsed.reason).toBe('why');
  });
});
