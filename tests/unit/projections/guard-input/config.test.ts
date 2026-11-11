/**
 * These tests check the guard config that a phase transition injects into the guard input.
 * `injectGuardConfig` reads the workflow type, the risk tier and the boundary status of a state, and the handler options.
 * Each case writes its states and its expected fields as literals. The review cases also compare with the REVIEW gate set.
 * The module case reads the source of `handleSet`, which must inject the config through `injectGuardConfig`.
 *
 * @oracle-sources: ../../../../src/workflow/phase-kind.ts, the states and expected fields written in this file
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { type GuardConfigOptions, injectGuardConfig } from '../../../../src/projections/guard-input/config.js';
import { resolveGateSet } from '../../../../src/workflow/phase-kind.js';
import { resolveBoundaryTouching, resolveRiskTier } from '../../../../src/workflow/verification-policy-resolver.js';

/** The source of the transition handler, which the module case reads. */
const SET_HANDLER_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../../src/workflow/handlers/set.ts',
);

/** The relative import of the guard config in the transition handler. */
const CONFIG_IMPORT = '../../projections/guard-input/config.js';

/** The five fields that the guard config injects. The handler deletes each one before its write. */
const INJECTED_KEYS: readonly string[] = [
  '_requiredReviews',
  '_maxPlanRevisions',
  '_mutationEnforcement',
  '_mutationThreshold',
  '_maxNoCoverage',
];

/** The three mutation fields. Only the high tier gets them. */
const MUTATION_KEYS: readonly string[] = ['_mutationEnforcement', '_mutationThreshold', '_maxNoCoverage'];

/** Options that set each mutation field to a valid value. */
const MUTATION_OPTIONS: GuardConfigOptions = {
  mutationEnforcement: 'block',
  mutationThreshold: 80,
  maxNoCoverage: 2,
};

/** Returns a new state with the given fields, so that each case changes its own copy. */
function stateOf(fields: Record<string, unknown>): Record<string, unknown> {
  return { featureId: 'guard-config', phase: 'review', ...fields };
}

/** Injects the config into a new copy of the state and returns the copy. */
function inject(fields: Record<string, unknown>, options?: GuardConfigOptions): Record<string, unknown> {
  const state = stateOf(fields);
  injectGuardConfig(state, options);
  return state;
}

/** Returns the review dimensions of the REVIEW gate set for a state, as the gate set gives them. */
function reviewGatesOf(state: Record<string, unknown>): readonly string[] {
  const workflowType = state.workflowType;
  return resolveGateSet('REVIEW', {
    riskTier: resolveRiskTier(state.riskTier),
    boundaryTouching: resolveBoundaryTouching(state.boundaryTouching),
    ...(typeof workflowType === 'string' ? { workflowType } : {}),
  }).flatMap((gate) => (gate.family === 'review' ? [gate.gate] : []));
}

/** Returns the import specifiers of a module source. */
function importSpecifiers(source: string): readonly string[] {
  const specs: string[] = [];
  const re = /(?:from|import)\s*['"]([^'"]+)['"]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    const spec = m[1];
    if (spec !== undefined) specs.push(spec);
  }
  return specs;
}

describe('the guard config of a phase transition', () => {
  /**
   * An explicit list of required reviews wins over the gate set of the type and the tier.
   * An empty list wins too, and the other fields of the state stay as they were.
   */
  it('InjectGuardConfig_ExplicitRequiredReviews_WinOverTheGateSet', () => {
    const custom = inject({ workflowType: 'feature', riskTier: 'high' }, { requiredReviews: ['custom-review'] });
    const empty = inject({ workflowType: 'feature', riskTier: 'high' }, { requiredReviews: [] });

    expect(custom._requiredReviews).toEqual(['custom-review']);
    expect(empty._requiredReviews).toEqual([]);
    expect(empty).toStrictEqual({
      featureId: 'guard-config',
      phase: 'review',
      workflowType: 'feature',
      riskTier: 'high',
      _requiredReviews: [],
    });
  });

  /**
   * With no list of required reviews, the config takes the review gates of the type and the tier.
   * The high tier adds `mutation-adequacy`, and an absent tier adds nothing. A call with no options gives the same gates.
   * A type with no review roster, a state with no type and a type that is not a string get no field.
   */
  it('InjectGuardConfig_NoRequiredReviews_TakesTheReviewGatesOfTheTierAndTheType', () => {
    const cases: readonly { readonly fields: Record<string, unknown>; readonly expected: readonly string[] | undefined }[] = [
      { fields: { workflowType: 'feature', riskTier: 'low' }, expected: ['review'] },
      { fields: { workflowType: 'feature', riskTier: 'medium' }, expected: ['review'] },
      { fields: { workflowType: 'feature', riskTier: 'high' }, expected: ['review', 'mutation-adequacy'] },
      { fields: { workflowType: 'feature', riskTier: 'high', boundaryTouching: true }, expected: ['review', 'mutation-adequacy'] },
      { fields: { workflowType: 'feature' }, expected: ['review'] },
      { fields: { workflowType: 'oneshot', riskTier: 'high' }, expected: ['mutation-adequacy'] },
      { fields: { workflowType: 'debug', riskTier: 'medium' }, expected: undefined },
      { fields: { riskTier: 'medium' }, expected: undefined },
      { fields: { workflowType: 7, riskTier: 'medium' }, expected: undefined },
    ];

    for (const { fields, expected } of cases) {
      const withEmptyOptions = inject(fields, {});
      const withNoOptions = inject(fields);

      expect(withEmptyOptions._requiredReviews).toEqual(expected);
      expect(withNoOptions).toStrictEqual(withEmptyOptions);
      const gates = reviewGatesOf(stateOf(fields));
      expect(withEmptyOptions._requiredReviews).toEqual(gates.length > 0 ? gates : undefined);
      expect(Object.hasOwn(withEmptyOptions, '_requiredReviews')).toBe(expected !== undefined);
    }
  });

  /** The high tier gets each mutation field that its options give. */
  it('InjectGuardConfig_AHighTier_AddsTheMutationFields', () => {
    const state = inject({ workflowType: 'feature', riskTier: 'high' }, MUTATION_OPTIONS);

    expect(state).toMatchObject({
      _requiredReviews: ['review', 'mutation-adequacy'],
      _mutationEnforcement: 'block',
      _mutationThreshold: 80,
      _maxNoCoverage: 2,
    });
  });

  /** Each tier other than high gets no mutation field, also when its options give each one. */
  it('InjectGuardConfig_AMediumTier_AddsNoMutationField', () => {
    const tiers: readonly Record<string, unknown>[] = [
      { workflowType: 'feature', riskTier: 'medium' },
      { workflowType: 'feature', riskTier: 'low' },
      { workflowType: 'feature' },
      { workflowType: 'feature', riskTier: 'critical' },
    ];

    for (const fields of tiers) {
      const state = inject(fields, MUTATION_OPTIONS);

      expect(state._requiredReviews).toEqual(['review']);
      for (const key of MUTATION_KEYS) expect(Object.hasOwn(state, key)).toBe(false);
    }
  });

  /**
   * The NoCoverage budget goes into the config only as a non-negative integer.
   * A negative budget and a fractional budget give no field, and a budget of 0 gives the field.
   */
  it('InjectGuardConfig_ANegativeOrFractionalNoCoverage_IsNotInjected', () => {
    const negative = inject({ workflowType: 'feature', riskTier: 'high' }, { maxNoCoverage: -1 });
    const fractional = inject({ workflowType: 'feature', riskTier: 'high' }, { maxNoCoverage: 1.5 });
    const zero = inject({ workflowType: 'feature', riskTier: 'high' }, { maxNoCoverage: 0 });

    expect(Object.hasOwn(negative, '_maxNoCoverage')).toBe(false);
    expect(Object.hasOwn(fractional, '_maxNoCoverage')).toBe(false);
    expect(zero._maxNoCoverage).toBe(0);
  });

  /**
   * A finite plan-revision cap goes into the config at each tier.
   * An infinite cap and a cap that is not a number give no field.
   */
  it('InjectGuardConfig_AFiniteMaxPlanRevisions_IsInjected', () => {
    const medium = inject({ workflowType: 'feature', riskTier: 'medium' }, { maxPlanRevisions: 3 });
    const noTier = inject({ workflowType: 'debug' }, { maxPlanRevisions: 0 });
    const infinite = inject({ workflowType: 'feature', riskTier: 'medium' }, { maxPlanRevisions: Number.POSITIVE_INFINITY });
    const notANumber = inject({ workflowType: 'feature', riskTier: 'medium' }, { maxPlanRevisions: Number.NaN });

    expect(medium._maxPlanRevisions).toBe(3);
    expect(noTier).toStrictEqual({ featureId: 'guard-config', phase: 'review', workflowType: 'debug', _maxPlanRevisions: 0 });
    expect(Object.hasOwn(infinite, '_maxPlanRevisions')).toBe(false);
    expect(Object.hasOwn(notANumber, '_maxPlanRevisions')).toBe(false);
  });

  /**
   * The transition handler imports `injectGuardConfig` and calls it on its copy of the document.
   * It assigns none of the injected fields itself. It still deletes each one before its write.
   */
  it('HandleSet_TheModule_InjectsTheConfigThroughInjectGuardConfig', () => {
    const source = fs.readFileSync(SET_HANDLER_PATH, 'utf8');
    const relative = new Set(importSpecifiers(source).filter((spec) => spec.startsWith('.')));

    expect(relative.size).toBeGreaterThan(0);
    expect(relative.has(CONFIG_IMPORT)).toBe(true);
    expect(source).toContain('injectGuardConfig(mutableState, options)');
    for (const key of INJECTED_KEYS) {
      expect(source).not.toMatch(new RegExp(`\\.${key}\\s*=(?!=)`));
      expect(source).toContain(`delete mutableState.${key};`);
    }
  });
});
