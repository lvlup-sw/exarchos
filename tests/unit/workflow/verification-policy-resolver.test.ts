import { describe, it, expect } from 'vitest';
import {
  resolveVerificationSequence,
  type GateName,
  type RiskTier,
} from '../../../src/workflow/verification-policy.js';
import { resolveConfig } from '../../../src/config/resolve.js';
import type { ResolvedProjectConfig } from '../../../src/config/resolve.js';
import type { VerificationPolicyOverlay } from '../../../src/config/yaml-schema.js';
import { resolveVerificationPolicy } from '../../../src/workflow/verification-policy-resolver.js';

/**
 * Builds a `ResolvedProjectConfig` with the given policy overlay through the production `resolveConfig` path,
 * not a hand-built stub.
 */
function configWith(policy: VerificationPolicyOverlay): ResolvedProjectConfig {
  return resolveConfig({ verification: { policy } });
}

const ALL_TIERS: readonly RiskTier[] = ['low', 'medium', 'high'];
const ALL_BOUNDARY: readonly boolean[] = [false, true];

describe('resolveVerificationPolicy', () => {
  it('ResolveVerificationPolicy_NoConfig_DelegatesToBuiltinTable', () => {
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

    for (const tier of ALL_TIERS) {
      const boundary = resolveVerificationPolicy(tier, true, config);
      expect(boundary.source).toBe('builtin');
      expect(boundary.sequence).toEqual(resolveVerificationSequence(tier, true));
    }
  });

  /** An empty cell is a valid override that runs no gate. */
  it('ResolveVerificationPolicy_EmptyCell_ResolvesToEmptySequence', () => {
    const overlay: VerificationPolicyOverlay = { medium: [] };
    const result = resolveVerificationPolicy('medium', false, configWith(overlay));
    expect(result.sequence).toEqual([]);
    expect(result.source).toBe('config');

    expect(result.sequence).not.toEqual(resolveVerificationSequence('medium', false));
  });

  it('ResolveVerificationPolicy_BoundaryCell_ResolvesIndependentlyOfBase', () => {
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
    const builtin = resolveVerificationPolicy('high', true);
    expect(Object.isFrozen(builtin.sequence)).toBe(true);
    expect(() => {
      (builtin.sequence as GateName[]).push('check_mock_boundary');
    }).toThrow();

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

  /**
   * A config without a `verification` block must resolve like no config. `resolveConfig` always adds a
   * `verification` block, so the test builds the partial object by hand.
   */
  it('ResolveVerificationPolicy_PartialConfigWithoutVerification_BehavesAsNoConfig', () => {
    const partial = { agents: {} } as unknown as ResolvedProjectConfig;

    for (const tier of ALL_TIERS) {
      for (const boundary of ALL_BOUNDARY) {
        let result!: ReturnType<typeof resolveVerificationPolicy>;
        expect(() => {
          result = resolveVerificationPolicy(tier, boundary, partial);
        }).not.toThrow();
        expect(result.source).toBe('builtin');
        expect(result.sequence).toEqual(resolveVerificationSequence(tier, boundary));
      }
    }
  });

  /** With no config, each of the six cells equals the builtin table, so the overlay changes no default. */
  it('ResolveVerificationPolicy_NoConfigSweep_ExtensionallyEqualsSlice1Table', () => {
    for (const tier of ALL_TIERS) {
      for (const boundary of ALL_BOUNDARY) {
        const result = resolveVerificationPolicy(tier, boundary);
        expect(result.source).toBe('builtin');
        expect(result.sequence).toEqual(resolveVerificationSequence(tier, boundary));
      }
    }
  });
});
