/**
 * verification-toolchain check — RED tests (design §4.6).
 *
 * The 13th doctor check reports whether the verification ladder's commands
 * resolve at all, so unresolved toolchains stop degrading gates silently.
 *
 * Status contract under test:
 *   - Pass    — test + typecheck + mutation all resolve (lint reported
 *               informationally either way).
 *   - Warning — any of that triple unresolved; `fix` MUST name BOTH remedies
 *               (`exarchos doctor --fix` AND declaring the field in
 *               `.exarchos.yml` / a `toolchains:` entry).
 *   - Skipped — nothing detectable at all (empty repo); `reason` names what
 *               detection looked for.
 *
 * The detail payload always carries the resolved-policy source per cell for
 * all six (riskTier × boundaryTouching) cells — read-only visibility, the
 * check NEVER writes anything.
 *
 * The probe is the disk seam: the check itself reaches for nothing but
 * `probes.verificationToolchain.resolve()`. Tests stub that probe.
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
  it('VerificationToolchain_AllTripleResolves_Pass', async () => {
    const probes = makeStubProbes({
      verificationToolchain: { resolve: async () => fullyResolved() },
    });

    const result = await verificationToolchain(probes, controller());

    expect(result.category).toBe('verification');
    expect(result.name).toBe('verification-toolchain');
    expect(result.status).toBe('Pass');
    expect(result.fix).toBeUndefined();
    // lint is reported informationally in the Pass message.
    expect(result.message).toContain('eslint .');
  });

  it('VerificationToolchain_MutationUnresolved_WarningWithBothRemedies', async () => {
    const probes = makeStubProbes({
      verificationToolchain: {
        resolve: async () => ({
          detected: true,
          runtime: {
            test: 'npm run test:run',
            typecheck: 'tsc --noEmit',
            install: 'npm install',
            mutation: null, // the triple is incomplete
            lint: 'eslint .',
          },
          policyCells: ALL_SIX_CELLS,
        }),
      },
    });

    const result = await verificationToolchain(probes, controller());

    expect(result.status).toBe('Warning');
    expect(result.fix).toBeDefined();
    // BOTH remedies must be named: the reconciler fix path AND declaring the
    // field where detection can't see it.
    expect(result.fix).toContain('exarchos doctor --fix');
    expect(result.fix).toContain('.exarchos.yml');
    expect(result.fix).toContain('toolchains:');
    // The unresolved field is named so the operator knows what to declare.
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
    // The reason names what detection looked for (project markers / config).
    expect(result.reason).toMatch(/marker|\.exarchos\.yml|toolchain/i);
    // No fix on a Skipped result.
    expect(result.fix).toBeUndefined();
  });

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

    // All six cells are reported, each with its builtin/config provenance.
    expect(result.policyCells).toHaveLength(6);
    expect(result.policyCells).toEqual(mixedCells);
    // The message surfaces the mixed provenance so the payload is self-describing.
    expect(result.message).toMatch(/builtin/i);
    expect(result.message).toMatch(/config/i);
  });
});
