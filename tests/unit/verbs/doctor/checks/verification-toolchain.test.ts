/**
 * Tests for the verification-toolchain doctor check.
 *
 * - Pass: `test`, `typecheck`, and `mutation` resolve. The message also reports `lint`.
 * - Warning: one of these three fields is unresolved. `fix` names `exarchos doctor --fix` and a declaration in `.exarchos.yml` or `toolchains:`.
 * - Skipped: detection finds no toolchain. `reason` names what detection looked for.
 *
 * The result carries the source of each of the six policy cells.
 * The tests stub `probes.verificationToolchain.resolve()`, which is the only probe that the check calls.
 */

import { describe, it, expect } from 'vitest';
import { makeStubProbes } from '../../../../../src/verbs/doctor/checks/__shared__/make-stub-probes.js';
import { verificationToolchain } from '../../../../../src/verbs/doctor/checks/verification-toolchain.js';
import type { VerificationToolchainResolution } from '../../../../../src/verbs/doctor/probes.js';

const controller = () => new AbortController().signal;

/** The six policy cells, always reported with a `builtin`/`config` source. */
const ALL_SIX_CELLS: VerificationToolchainResolution['policyCells'] = [
  { riskTier: 'low', boundaryTouching: false, source: 'builtin' },
  { riskTier: 'low', boundaryTouching: true, source: 'builtin' },
  { riskTier: 'medium', boundaryTouching: false, source: 'builtin' },
  { riskTier: 'medium', boundaryTouching: true, source: 'builtin' },
  { riskTier: 'high', boundaryTouching: false, source: 'builtin' },
  { riskTier: 'high', boundaryTouching: true, source: 'builtin' },
];

/** A resolution where the full Pass triple resolves. */
function fullyResolved(): VerificationToolchainResolution {
  return {
    detected: true,
    runtime: {
      test: 'npm run test:run',
      typecheck: 'tsc --noEmit',
      install: 'npm install',
      mutation: 'npx stryker run',
      lint: 'eslint .',
    },
    policyCells: ALL_SIX_CELLS,
  };
}

describe('verificationToolchain', () => {
  /** The Pass message also reports the `lint` command. */
  it('VerificationToolchain_AllTripleResolves_Pass', async () => {
    const probes = makeStubProbes({
      verificationToolchain: { resolve: async () => fullyResolved() },
    });

    const result = await verificationToolchain(probes, controller());

    expect(result.category).toBe('verification');
    expect(result.name).toBe('verification-toolchain');
    expect(result.status).toBe('Pass');
    expect(result.fix).toBeUndefined();
    expect(result.message).toContain('eslint .');
  });

  /** The message names the unresolved field, so the operator knows which field to declare. */
  it('VerificationToolchain_MutationUnresolved_WarningWithBothRemedies', async () => {
    const probes = makeStubProbes({
      verificationToolchain: {
        resolve: async () => ({
          detected: true,
          runtime: {
            test: 'npm run test:run',
            typecheck: 'tsc --noEmit',
            install: 'npm install',
            mutation: null,
            lint: 'eslint .',
          },
          policyCells: ALL_SIX_CELLS,
        }),
      },
    });

    const result = await verificationToolchain(probes, controller());

    expect(result.status).toBe('Warning');
    expect(result.fix).toBeDefined();
    expect(result.fix).toContain('exarchos doctor --fix');
    expect(result.fix).toContain('.exarchos.yml');
    expect(result.fix).toContain('toolchains:');
    expect(result.message).toContain('mutation');
  });

  it('VerificationToolchain_NoToolchainDetected_SkippedWithReason', async () => {
    const probes = makeStubProbes({
      verificationToolchain: {
        resolve: async () => ({
          detected: false,
          runtime: {
            test: null,
            typecheck: null,
            install: null,
            mutation: null,
            lint: null,
          },
          policyCells: ALL_SIX_CELLS,
        }),
      },
    });

    const result = await verificationToolchain(probes, controller());

    expect(result.status).toBe('Skipped');
    expect(result.reason).toBeDefined();
    expect(result.reason!.length).toBeGreaterThan(0);
    expect(result.reason).toMatch(/marker|\.exarchos\.yml|toolchain/i);
    expect(result.fix).toBeUndefined();
  });

  /** The message also reports the mix of sources, so the message alone shows the provenance. */
  it('VerificationToolchain_DetailPayload_CarriesPolicySourcePerCell', async () => {
    const mixedCells: VerificationToolchainResolution['policyCells'] = [
      { riskTier: 'low', boundaryTouching: false, source: 'builtin' },
      { riskTier: 'low', boundaryTouching: true, source: 'config' },
      { riskTier: 'medium', boundaryTouching: false, source: 'builtin' },
      { riskTier: 'medium', boundaryTouching: true, source: 'config' },
      { riskTier: 'high', boundaryTouching: false, source: 'builtin' },
      { riskTier: 'high', boundaryTouching: true, source: 'config' },
    ];
    const probes = makeStubProbes({
      verificationToolchain: {
        resolve: async () => ({
          ...fullyResolved(),
          policyCells: mixedCells,
        }),
      },
    });

    const result = await verificationToolchain(probes, controller());

    expect(result.policyCells).toHaveLength(6);
    expect(result.policyCells).toEqual(mixedCells);
    expect(result.message).toMatch(/builtin/i);
    expect(result.message).toMatch(/config/i);
  });
});
