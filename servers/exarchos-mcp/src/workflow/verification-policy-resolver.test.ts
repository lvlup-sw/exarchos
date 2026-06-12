import { describe, it, expect } from 'vitest';
import {
  resolveVerificationSequence,
  type GateName,
  type RiskTier,
} from './verification-policy.js';
import { resolveConfig } from '../config/resolve.js';
import type { ResolvedProjectConfig } from '../config/resolve.js';
import type { VerificationPolicyOverlay } from '../config/yaml-schema.js';
import { resolveVerificationPolicy } from './verification-policy-resolver.js';

// Build a real ResolvedProjectConfig threaded with the given overlay, going
// through the production `resolveConfig` path so the fixture matches what a
// caller actually passes (deep-cloned + frozen overlay), not a hand-rolled stub.
function configWith(policy: VerificationPolicyOverlay): ResolvedProjectConfig {
  return resolveConfig({ verification: { policy } });
}

const ALL_TIERS: readonly RiskTier[] = ['low', 'medium', 'high'];
const ALL_BOUNDARY: readonly boolean[] = [false, true];

describe('resolveVerificationPolicy', () => {
  it('ResolveVerificationPolicy_NoConfig_DelegatesToBuiltinTable', () => {
    // No config at all → builtin table verbatim, source: 'builtin'.
    const result = resolveVerificationPolicy('medium', false);
    expect(result.sequence).toEqual(resolveVerificationSequence('medium', false));
    expect(result.source).toBe('builtin');
  });

  it('ResolveVerificationPolicy_ConfiguredCell_WinsVerbatim', () => {
    const overlay: VerificationPolicyOverlay = {
      medium: ['check_static_analysis', 'check_integration_suite'],
    };
    const result = resolveVerificationPolicy('medium', false, configWith(overlay));
    expect(result.sequence).toEqual(['check_static_analysis', 'check_integration_suite']);
    expect(result.source).toBe('config');
  });

  it('ResolveVerificationPolicy_AbsentCell_FallsBackPerCell', () => {
    // Config sets ONLY medium (base). low / high / all boundary cells unset →
    // each independently resolves to the builtin table.
    const overlay: VerificationPolicyOverlay = {
      medium: ['check_mock_boundary'],
    };
    const config = configWith(overlay);

    const medium = resolveVerificationPolicy('medium', false, config);
    expect(medium.source).toBe('config');
    expect(medium.sequence).toEqual(['check_mock_boundary']);

    const low = resolveVerificationPolicy('low', false, config);
    expect(low.source).toBe('builtin');
    expect(low.sequence).toEqual(resolveVerificationSequence('low', false));

    const high = resolveVerificationPolicy('high', false, config);
    expect(high.source).toBe('builtin');
    expect(high.sequence).toEqual(resolveVerificationSequence('high', false));

    // Boundary cells untouched by a base-tier override.
    for (const tier of ALL_TIERS) {
      const boundary = resolveVerificationPolicy(tier, true, config);
      expect(boundary.source).toBe('builtin');
      expect(boundary.sequence).toEqual(resolveVerificationSequence(tier, true));
    }
  });

  it('ResolveVerificationPolicy_EmptyCell_ResolvesToEmptySequence', () => {
    // Explicit empty array is the legitimate "run nothing" override — it wins
    // over the builtin table with source: 'config'.
    const overlay: VerificationPolicyOverlay = { medium: [] };
    const result = resolveVerificationPolicy('medium', false, configWith(overlay));
    expect(result.sequence).toEqual([]);
    expect(result.source).toBe('config');

    // And it does NOT collapse to the (non-empty) builtin sequence.
    expect(result.sequence).not.toEqual(resolveVerificationSequence('medium', false));
  });

  it('ResolveVerificationPolicy_BoundaryCell_ResolvesIndependentlyOfBase', () => {
    // boundary.medium configured, base medium NOT: boundary uses config, base
    // resolution still uses the builtin table.
    const overlay: VerificationPolicyOverlay = {
      boundary: { medium: ['check_contract_drift'] },
    };
    const config = configWith(overlay);

    const boundary = resolveVerificationPolicy('medium', true, config);
    expect(boundary.source).toBe('config');
    expect(boundary.sequence).toEqual(['check_contract_drift']);

    const base = resolveVerificationPolicy('medium', false, config);
    expect(base.source).toBe('builtin');
    expect(base.sequence).toEqual(resolveVerificationSequence('medium', false));
  });

  it('ResolveVerificationPolicy_Output_IsFrozen', () => {
    // Builtin-sourced output is frozen.
    const builtin = resolveVerificationPolicy('high', true);
    expect(Object.isFrozen(builtin.sequence)).toBe(true);
    expect(() => {
      (builtin.sequence as GateName[]).push('check_mock_boundary');
    }).toThrow();

    // Config-sourced output is frozen and not aliased to a caller-mutable array.
    const overlay: VerificationPolicyOverlay = {
      low: ['check_static_analysis'],
    };
    const config = configWith(overlay);
    const configured = resolveVerificationPolicy('low', false, config);
    expect(Object.isFrozen(configured.sequence)).toBe(true);
    expect(() => {
      (configured.sequence as GateName[]).push('check_test_adequacy');
    }).toThrow();
  });

  it('ResolveVerificationPolicy_NoConfigSweep_ExtensionallyEqualsSlice1Table', () => {
    // Acceptance line: with no config, resolution is deep-equal to the slice-1
    // table for ALL six cells (3 tiers x 2 boundary values) — additive change,
    // no default behavior shift.
    for (const tier of ALL_TIERS) {
      for (const boundary of ALL_BOUNDARY) {
        const result = resolveVerificationPolicy(tier, boundary);
        expect(result.source).toBe('builtin');
        expect(result.sequence).toEqual(resolveVerificationSequence(tier, boundary));
      }
    }
  });
});
