// ─── Verification Policy Table Tests (vls1-b1, task 006) ────────────────────
//
// The verification policy is a frozen const table mapping (riskTier,
// boundaryTouching) → an ordered list of gate names. It is the single source
// of truth for which gates run, in what order, for a given task profile.
//
// R2 BOUNDARY (#1517): this module reads NO config. Config-resolved overrides
// are out of scope here; these tests guard that the module's source imports
// neither the config loader nor `fs`.

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  resolveVerificationSequence,
  VERIFICATION_GATE_NAMES,
} from './verification-policy.js';
import type { GateName } from './verification-policy.js';

const TIERS = ['low', 'medium', 'high'] as const;
const BOUNDARY = [false, true] as const;

describe('verification-policy', () => {
  it('VerificationPolicy_EveryTierBoundaryCombination_ReturnsOrderedGateNames', () => {
    for (const tier of TIERS) {
      for (const boundary of BOUNDARY) {
        const seq = resolveVerificationSequence(tier, boundary);
        // Defined, non-empty, array of strings.
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
      // Boundary sequence starts with the base sequence (appended-after).
      expect(withBoundary.slice(0, base.length)).toEqual([...base]);
      // check_contract_drift is added for every tier.
      expect(withBoundary).toContain('check_contract_drift');
    }
  });

  it('VerificationPolicy_BoundaryTouching_AppendsMockBoundaryMediumHighOnly', () => {
    // low + boundary: contract_drift but NOT mock_boundary.
    expect(resolveVerificationSequence('low', true)).toEqual([
      'check_static_analysis',
      'check_contract_drift',
    ]);
    // medium + boundary: base + contract_drift + mock_boundary, in that order.
    expect(resolveVerificationSequence('medium', true)).toEqual([
      'check_static_analysis',
      'check_test_adequacy',
      'check_contract_drift',
      'check_mock_boundary',
    ]);
    // high + boundary: base + contract_drift + mock_boundary.
    expect(resolveVerificationSequence('high', true)).toEqual([
      'check_static_analysis',
      'check_test_adequacy',
      'check_integration_suite',
      'check_contract_drift',
      'check_mock_boundary',
    ]);
  });

  it('VerificationPolicy_GateNames_MemberOfDeclaredUnion', () => {
    // Every gate name produced by any combination must be a member of the
    // declared union surface (VERIFICATION_GATE_NAMES).
    const declared = new Set<string>(VERIFICATION_GATE_NAMES);
    for (const tier of TIERS) {
      for (const boundary of BOUNDARY) {
        for (const gate of resolveVerificationSequence(tier, boundary)) {
          expect(declared.has(gate)).toBe(true);
        }
      }
    }
    // And the declared union is exactly the gates that appear in the table —
    // no orphan names.
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
    // R2 boundary guard (#1517): the policy module must be a pure table with
    // NO config reads. Assert the source imports neither the config loader nor
    // `fs`/`node:fs` — config-resolved overrides are a separate (R2) concern.
    const here = path.dirname(fileURLToPath(import.meta.url));
    const src = fs.readFileSync(path.join(here, 'verification-policy.ts'), 'utf-8');
    expect(src).not.toMatch(/exarchos-config/);
    expect(src).not.toMatch(/config\/resolve/);
    expect(src).not.toMatch(/from ['"]node:fs['"]/);
    expect(src).not.toMatch(/from ['"]fs['"]/);
    expect(src).not.toMatch(/\.exarchos\.yml/);
  });
});
