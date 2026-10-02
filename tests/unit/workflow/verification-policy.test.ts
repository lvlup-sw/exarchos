// Tests for the verification policy table. The table maps a risk tier and a
// `boundaryTouching` flag to an ordered list of gate names. The module reads no
// config: one test checks that its source imports neither the config loader nor `fs`.

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  resolveVerificationSequence,
  deriveWorkflowRiskTier,
  VERIFICATION_GATE_NAMES,
} from '../../../src/workflow/verification-policy.js';
import type { GateName, RiskTier } from '../../../src/workflow/verification-policy.js';

const TIERS = ['low', 'medium', 'high'] as const;
const BOUNDARY = [false, true] as const;

describe('verification-policy', () => {
  it('VerificationPolicy_EveryTierBoundaryCombination_ReturnsOrderedGateNames', () => {
    for (const tier of TIERS) {
      for (const boundary of BOUNDARY) {
        const seq = resolveVerificationSequence(tier, boundary);
        expect(Array.isArray(seq)).toBe(true);
        expect(seq.length).toBeGreaterThan(0);
        for (const gate of seq) {
          expect(typeof gate).toBe('string');
        }
      }
    }
  });

  it('VerificationPolicy_BaseSequences_MatchTierPolicy', () => {
    expect(resolveVerificationSequence('low', false)).toEqual(['check_static_analysis']);
    expect(resolveVerificationSequence('medium', false)).toEqual([
      'check_static_analysis',
      'check_test_adequacy',
    ]);
    expect(resolveVerificationSequence('high', false)).toEqual([
      'check_static_analysis',
      'check_test_adequacy',
      'check_integration_suite',
    ]);
  });

  it('VerificationPolicy_BoundaryTouching_AppendsContractDriftEveryTier', () => {
    for (const tier of TIERS) {
      const base = resolveVerificationSequence(tier, false);
      const withBoundary = resolveVerificationSequence(tier, true);
      expect(withBoundary.slice(0, base.length)).toEqual([...base]);
      expect(withBoundary).toContain('check_contract_drift');
    }
  });

  it('VerificationPolicy_BoundaryTouching_AppendsMockBoundaryMediumHighOnly', () => {
    expect(resolveVerificationSequence('low', true)).toEqual([
      'check_static_analysis',
      'check_contract_drift',
    ]);
    expect(resolveVerificationSequence('medium', true)).toEqual([
      'check_static_analysis',
      'check_test_adequacy',
      'check_contract_drift',
      'check_mock_boundary',
    ]);
    expect(resolveVerificationSequence('high', true)).toEqual([
      'check_static_analysis',
      'check_test_adequacy',
      'check_integration_suite',
      'check_contract_drift',
      'check_mock_boundary',
    ]);
  });

  it('VerificationPolicy_GateNames_MemberOfDeclaredUnion', () => {
    const declared = new Set<string>(VERIFICATION_GATE_NAMES);
    for (const tier of TIERS) {
      for (const boundary of BOUNDARY) {
        for (const gate of resolveVerificationSequence(tier, boundary)) {
          expect(declared.has(gate)).toBe(true);
        }
      }
    }
    const appearing = new Set<string>();
    for (const tier of TIERS) {
      for (const boundary of BOUNDARY) {
        for (const gate of resolveVerificationSequence(tier, boundary)) {
          appearing.add(gate);
        }
      }
    }
    expect(new Set(VERIFICATION_GATE_NAMES)).toEqual(appearing);
  });

  it('VerificationPolicy_AllCombinations_DuplicateFree', () => {
    for (const tier of TIERS) {
      for (const boundary of BOUNDARY) {
        const seq = resolveVerificationSequence(tier, boundary);
        expect(new Set(seq).size).toBe(seq.length);
      }
    }
  });

  it('VerificationPolicy_Module_ReadsNoConfig', () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const src = fs.readFileSync(path.join(here, '../../../src/workflow/verification-policy.ts'), 'utf-8');
    expect(src).not.toMatch(/exarchos-config/);
    expect(src).not.toMatch(/config\/resolve/);
    expect(src).not.toMatch(/from ['"]node:fs['"]/);
    expect(src).not.toMatch(/from ['"]fs['"]/);
    expect(src).not.toMatch(/\.exarchos\.yml/);
  });
});

/**
 * `deriveWorkflowRiskTier` gives the highest task tier, in the order `low < medium < high`. A `high` workflow
 * tier adds the `mutation-adequacy` review, so one high task must make the workflow high.
 */
describe('deriveWorkflowRiskTier', () => {
  it('WorkflowRiskTier_MixedTiers_ReturnsMaximum', () => {
    expect(
      deriveWorkflowRiskTier([
        { riskTier: 'low' },
        { riskTier: 'high' },
        { riskTier: 'medium' },
      ]),
    ).toBe('high');

    expect(
      deriveWorkflowRiskTier([{ riskTier: 'low' }, { riskTier: 'medium' }]),
    ).toBe('medium');

    expect(
      deriveWorkflowRiskTier([{ riskTier: 'high' }, { riskTier: 'low' }]),
    ).toBe('high');
  });

  it('WorkflowRiskTier_NoTierTask_TreatedAsLow_DoesNotRaiseMax', () => {
    expect(
      deriveWorkflowRiskTier([{}, { riskTier: 'medium' }, {}]),
    ).toBe('medium');

    expect(deriveWorkflowRiskTier([{ riskTier: 'high' }, {}])).toBe('high');
  });

  it('WorkflowRiskTier_AllUntieredOrEmpty_ReturnsLowFloor', () => {
    expect(deriveWorkflowRiskTier([])).toBe('low');
    expect(deriveWorkflowRiskTier([{}, {}, {}])).toBe('low');
    expect(deriveWorkflowRiskTier([{ riskTier: 'low' }, {}])).toBe('low');
  });

  it('WorkflowRiskTier_SingleHighTask_YieldsHigh', () => {
    const tasks: ReadonlyArray<{ riskTier?: RiskTier }> = [
      { riskTier: 'low' },
      { riskTier: 'low' },
      { riskTier: 'high' },
    ];
    expect(deriveWorkflowRiskTier(tasks)).toBe('high');
  });
});
