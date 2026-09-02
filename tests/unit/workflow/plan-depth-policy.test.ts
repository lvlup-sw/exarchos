// ─── Planning-Depth Policy Table Tests (epic #1581, task 001, DR-2) ─────────
//
// The plan-depth policy is a frozen const table mapping `designDepth` → an
// ordered list of plan-structure gate names. It is the depth-axis twin of
// `verification-policy.ts` (the risk-tier axis) and the single source of truth
// for which plan-structure gates run at a given design depth.
//
// Two test names are CONTRACTUAL (the plan pins them by name):
//   - ResolvePlanDepthPolicy_ThinSubsetOfStandardSubsetOfDeep_Holds
//   - ResolvePlanDepthPolicy_NoConfigIO_ReadsThreadedConfig
//
// The base rungs are config-blind (no plan-depth overlay seam exists on
// `ResolvedProjectConfig` yet); the threaded `config` is the ONLY config source
// and is read by optional-chain, never the filesystem. The `'standard'` rung is
// pinned == today's static `'plan-structure'` binding (the registry `PLAN_PHASES`
// set) so graduating the resolver (task 003) is behavior-neutral at the default.

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

// The five gates of today's static `'plan-structure'` binding, in
// plan-validation order (registry `PLAN_PHASES`). The `'standard'` rung MUST
// equal this list (behavior-neutral default — load-bearing for task 003).
const STATIC_PLAN_PHASES_BINDING: readonly PlanDepthGateName[] = [
  'check_task_decomposition',
  'check_plan_coverage',
  'spec_coverage_check',
  'check_provenance_chain',
  'generate_traceability',
];

describe('plan-depth-policy', () => {
  it('ResolvePlanDepthPolicy_ThinSubsetOfStandardSubsetOfDeep_Holds', () => {
    const thin = resolvePlanDepthPolicy('thin').sequence;
    const standard = resolvePlanDepthPolicy('standard').sequence;
    const deep = resolvePlanDepthPolicy('deep').sequence;

    // Strict-superset rungs: each lower sequence is a strict PREFIX of the next
    // (mirror of the verification-policy `withBoundary.slice(0, base.length)`
    // superset idiom). A prefix-equality pin proves both subset membership AND
    // order-preservation cell-by-cell.
    expect(standard.slice(0, thin.length)).toEqual([...thin]);
    expect(deep.slice(0, standard.length)).toEqual([...standard]);

    // STRICT superset: each higher rung adds at least one gate.
    expect(standard.length).toBeGreaterThan(thin.length);
    expect(deep.length).toBeGreaterThan(standard.length);

    // Set-level subset (defends against accidental reordering passing the
    // prefix check while dropping a member): thin ⊆ standard ⊆ deep.
    const thinSet = new Set<string>(thin);
    const standardSet = new Set<string>(standard);
    const deepSet = new Set<string>(deep);
    for (const g of thinSet) expect(standardSet.has(g)).toBe(true);
    for (const g of standardSet) expect(deepSet.has(g)).toBe(true);

    // Behavior-neutral default: `standard` == today's static binding.
    expect(standard).toEqual(STATIC_PLAN_PHASES_BINDING);

    // Deep is exactly standard + the exploration obligation (DR-7).
    expect(deep).toEqual([...STATIC_PLAN_PHASES_BINDING, 'check_exploration_depth']);
  });

  it('ResolvePlanDepthPolicy_NoConfigIO_ReadsThreadedConfig', () => {
    // (1) Reads ONLY the threaded config — never an ambient/filesystem source.
    // Proof: the resolved sequence is invariant under config presence/absence
    // AND under a deliberately-sabotaged config. If the function reached past
    // its argument to a real config source, sabotaging the argument could not
    // be the sole determinant — and the base rungs would not be config-blind.
    for (const depth of DEPTHS) {
      const withConfig = resolvePlanDepthPolicy(depth, DEFAULTS).sequence;
      const withoutConfig = resolvePlanDepthPolicy(depth).sequence;
      // Sabotaged config: a structurally-bogus object cast through `unknown`.
      // The function tolerates it (optional-chain read) and still resolves the
      // base rung — it neither throws nor consults the filesystem to recover.
      const sabotaged = { verification: null, storage: undefined } as unknown as Parameters<
        typeof resolvePlanDepthPolicy
      >[1];
      const withSabotage = resolvePlanDepthPolicy(depth, sabotaged).sequence;

      expect(withoutConfig).toEqual([...withConfig]);
      expect(withSabotage).toEqual([...withConfig]);
    }

    // (2) Source-level guard (no-I/O proof): the module imports the config TYPE
    // only — never `node:fs`/`fs`, never a config loader, never `.exarchos.yml`.
    // A type-only import of `config/resolve` reads nothing at runtime, so the
    // ONLY config the function can consult is its threaded argument.
    const here = path.dirname(fileURLToPath(import.meta.url));
    const src = fs.readFileSync(path.join(here, '../../../src/workflow/plan-depth-policy.ts'), 'utf-8');
    expect(src).not.toMatch(/from ['"]node:fs['"]/);
    expect(src).not.toMatch(/from ['"]fs['"]/);
    expect(src).not.toMatch(/exarchos-config/);
    expect(src).not.toMatch(/loadConfig|resolveConfig/);
    expect(src).not.toMatch(/\.exarchos\.yml/);
    // The config import is type-only (no runtime binding pulled in).
    expect(src).toMatch(/import type \{ ResolvedProjectConfig \}/);
  });

  it('ResolvePlanDepthPolicy_EveryDepth_ReturnsOrderedGateNamesInUnion', () => {
    const declared = new Set<string>(PLAN_DEPTH_GATE_NAMES);
    for (const depth of DEPTHS) {
      const { sequence } = resolvePlanDepthPolicy(depth);
      expect(Array.isArray(sequence)).toBe(true);
      expect(sequence.length).toBeGreaterThan(0);
      // Every emitted gate is a member of the declared union surface.
      for (const gate of sequence) {
        expect(typeof gate).toBe('string');
        expect(declared.has(gate)).toBe(true);
      }
      // Duplicate-free.
      expect(new Set(sequence).size).toBe(sequence.length);
    }

    // No orphan names: the declared union is exactly the gates that appear.
    const appearing = new Set<string>();
    for (const depth of DEPTHS) {
      for (const gate of resolvePlanDepthPolicy(depth).sequence) appearing.add(gate);
    }
    expect(new Set(PLAN_DEPTH_GATE_NAMES)).toEqual(appearing);
  });

  it('ResolvePlanDepthPolicy_ReturnedSequence_IsFrozenAndNotAliased', () => {
    // The returned sequence is frozen (cannot be mutated by a consumer) and
    // two calls return the same frozen base array (no per-call copy needed —
    // the base table is already frozen, never caller-mutable).
    const a = resolvePlanDepthPolicy('standard').sequence;
    expect(Object.isFrozen(a)).toBe(true);
    const b = resolvePlanDepthPolicy('standard').sequence;
    // Same frozen base-table reference, not a per-call copy (the test's stated
    // intent) — assert reference identity, not just structural equality.
    expect(a).toBe(b);
  });
});
