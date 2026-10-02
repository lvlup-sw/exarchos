/**
 * Tests the plan-depth policy table. It maps each `designDepth` to an ordered list of plan-structure gates.
 * It is the depth twin of `verification-policy.ts`, which keys on the risk tier.
 * The resolver takes an optional config argument, and it reads no config file.
 * Keep the names of the first two tests, because the plan cites them by name.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  resolvePlanDepthPolicy,
  PLAN_DEPTH_GATE_NAMES,
  type DesignDepth,
  type PlanDepthGateName,
} from '../../../src/workflow/plan-depth-policy.js';
import { DEFAULTS } from '../../../src/config/resolve.js';

const DEPTHS = ['thin', 'standard', 'deep'] as const satisfies readonly DesignDepth[];

/** The five gates that the registry binds to the plan phases, in plan-validation order. The `standard` rung must equal this list. */
const STATIC_PLAN_PHASES_BINDING: readonly PlanDepthGateName[] = [
  'check_task_decomposition',
  'check_plan_coverage',
  'spec_coverage_check',
  'check_provenance_chain',
  'generate_traceability',
];

describe('plan-depth-policy', () => {
  /**
   * Each lower rung must be a strict prefix of the next rung, so the test checks order and membership.
   * The `standard` rung equals the registry binding, and `deep` adds `check_exploration_depth`.
   */
  it('ResolvePlanDepthPolicy_ThinSubsetOfStandardSubsetOfDeep_Holds', () => {
    const thin = resolvePlanDepthPolicy('thin').sequence;
    const standard = resolvePlanDepthPolicy('standard').sequence;
    const deep = resolvePlanDepthPolicy('deep').sequence;

    expect(standard.slice(0, thin.length)).toEqual([...thin]);
    expect(deep.slice(0, standard.length)).toEqual([...standard]);

    expect(standard.length).toBeGreaterThan(thin.length);
    expect(deep.length).toBeGreaterThan(standard.length);

    const thinSet = new Set<string>(thin);
    const standardSet = new Set<string>(standard);
    const deepSet = new Set<string>(deep);
    for (const g of thinSet) expect(standardSet.has(g)).toBe(true);
    for (const g of standardSet) expect(deepSet.has(g)).toBe(true);

    expect(standard).toEqual(STATIC_PLAN_PHASES_BINDING);

    expect(deep).toEqual([...STATIC_PLAN_PHASES_BINDING, 'check_exploration_depth']);
  });

  /**
   * The sequence is the same with the defaults, with no config, and with a malformed config.
   * The source imports only the config type, and no filesystem module or config loader.
   * So the resolver reads no config file.
   */
  it('ResolvePlanDepthPolicy_NoConfigIO_ReadsThreadedConfig', () => {
    for (const depth of DEPTHS) {
      const withConfig = resolvePlanDepthPolicy(depth, DEFAULTS).sequence;
      const withoutConfig = resolvePlanDepthPolicy(depth).sequence;
      const sabotaged = { verification: null, storage: undefined } as unknown as Parameters<
        typeof resolvePlanDepthPolicy
      >[1];
      const withSabotage = resolvePlanDepthPolicy(depth, sabotaged).sequence;

      expect(withoutConfig).toEqual([...withConfig]);
      expect(withSabotage).toEqual([...withConfig]);
    }

    const here = path.dirname(fileURLToPath(import.meta.url));
    const src = fs.readFileSync(path.join(here, '../../../src/workflow/plan-depth-policy.ts'), 'utf-8');
    expect(src).not.toMatch(/from ['"]node:fs['"]/);
    expect(src).not.toMatch(/from ['"]fs['"]/);
    expect(src).not.toMatch(/exarchos-config/);
    expect(src).not.toMatch(/loadConfig|resolveConfig/);
    expect(src).not.toMatch(/\.exarchos\.yml/);
    expect(src).toMatch(/import type \{ ResolvedProjectConfig \}/);
  });

  it('ResolvePlanDepthPolicy_EveryDepth_ReturnsOrderedGateNamesInUnion', () => {
    const declared = new Set<string>(PLAN_DEPTH_GATE_NAMES);
    for (const depth of DEPTHS) {
      const { sequence } = resolvePlanDepthPolicy(depth);
      expect(Array.isArray(sequence)).toBe(true);
      expect(sequence.length).toBeGreaterThan(0);
      for (const gate of sequence) {
        expect(typeof gate).toBe('string');
        expect(declared.has(gate)).toBe(true);
      }
      expect(new Set(sequence).size).toBe(sequence.length);
    }

    const appearing = new Set<string>();
    for (const depth of DEPTHS) {
      for (const gate of resolvePlanDepthPolicy(depth).sequence) appearing.add(gate);
    }
    expect(new Set(PLAN_DEPTH_GATE_NAMES)).toEqual(appearing);
  });

  /** Two calls return the same frozen base array, not a copy. */
  it('ResolvePlanDepthPolicy_ReturnedSequence_IsFrozenAndNotAliased', () => {
    const a = resolvePlanDepthPolicy('standard').sequence;
    expect(Object.isFrozen(a)).toBe(true);
    const b = resolvePlanDepthPolicy('standard').sequence;
    expect(a).toBe(b);
  });
});
