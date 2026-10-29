/**
 * The verification profile schema refuses each term that leaves its bound.
 * Each case starts from the shared Node fake, which parses, and breaks one property of it.
 * Each refusal names the path of the broken property, so a refusal for another reason fails the case.
 */

import { describe, it, expect } from 'vitest';

import {
  PROFILE_UNRESOLVED,
  VerificationProfileSchema,
  type VerificationProfile,
} from '../../../src/workflow/verification/profile.js';
import { nodeTestProfile, pinnedTestProfile } from '../../helpers/verification-profile.js';

/** The path of each issue of a refused document, joined with dots. An accepted document gives no path. */
function refusedPaths(document: unknown): string[] {
  const result = VerificationProfileSchema.safeParse(document);
  return result.success ? [] : result.error.issues.map((issue) => issue.path.join('.'));
}

/** The unknown keys that the schema names for a refused document. */
function unknownKeys(document: unknown): string[] {
  const result = VerificationProfileSchema.safeParse(document);
  if (result.success) return [];
  return result.error.issues.flatMap((issue) => (issue.code === 'unrecognized_keys' ? issue.keys : []));
}

/** The Node fake with the red exit codes of its probe replaced. */
function withProbeCodes(profile: VerificationProfile, codes: number[]): VerificationProfile {
  const { probe } = profile.tests;
  return {
    ...profile,
    tests: { ...profile.tests, probe: { ...probe, failureExitCodes: { ...probe.failureExitCodes, codes } } },
  };
}

/** The Node fake with the argv of its probe replaced. */
function withProbeArgv(profile: VerificationProfile, argv: string[]): VerificationProfile {
  return {
    ...profile,
    tests: {
      ...profile.tests,
      probe: { ...profile.tests.probe, command: { state: 'resolved', argv, source: 'detection' } },
    },
  };
}

/** The Node fake with its test globs replaced by one resolved term. */
function withTestGlobs(profile: VerificationProfile, globs: string[], replacedSeeds?: string[]): VerificationProfile {
  return {
    ...profile,
    tests: {
      ...profile.tests,
      globs: {
        state: 'resolved',
        globs,
        source: 'config',
        ...(replacedSeeds !== undefined ? { replacedSeeds } : {}),
      },
    },
  };
}

/** The Node fake with its first-party globs replaced by one resolved term. */
function withFirstParty(profile: VerificationProfile, globs: string[]): VerificationProfile {
  return { ...profile, firstParty: { state: 'resolved', globs, source: 'config' } };
}

/** The Node fake with one boundary check whose config file is `config`. */
function withBoundaryConfig(profile: VerificationProfile, config: string): VerificationProfile {
  return {
    ...profile,
    boundaryChecks: [
      {
        adapter: 'dependency-cruiser',
        command: { state: 'resolved', argv: ['depcruise', '--validate', '.dependency-cruiser.cjs'], source: 'detection' },
        config,
      },
    ],
  };
}

describe('the verification profile schema', () => {
  /** Exit 0 is the green end of each run. A red code of 0 makes a passing run read as red. */
  it('VerificationProfileSchema_AnExitCodeOfZero_IsRefused', () => {
    const profile = nodeTestProfile();
    expect(refusedPaths(profile)).toEqual([]);
    expect(refusedPaths(withProbeCodes(profile, [1, 101, 255]))).toEqual([]);

    expect(refusedPaths(withProbeCodes(profile, [0]))).toEqual(['tests.probe.failureExitCodes.codes.0']);
    expect(refusedPaths(withProbeCodes(profile, [2, 0]))).toEqual(['tests.probe.failureExitCodes.codes.1']);
    expect(refusedPaths(withProbeCodes(profile, [256]))).toEqual(['tests.probe.failureExitCodes.codes.0']);
    expect(refusedPaths(withProbeCodes(profile, []))).toEqual(['tests.probe.failureExitCodes.codes']);

    const integration = profile.integration;
    expect(
      refusedPaths({
        ...profile,
        integration: { ...integration, failureExitCodes: { ...integration.failureExitCodes, codes: [0] } },
      }),
    ).toEqual(['integration.failureExitCodes.codes.0']);
  });

  /** The capsule pins an argv and not a command string, so no token can carry a shell metacharacter. */
  it('VerificationProfileSchema_AnArgvTokenWithAShellMetacharacter_IsRefused', () => {
    const profile = nodeTestProfile();
    expect(refusedPaths(withProbeArgv(profile, ['npm', 'run', 'test:files', '--reporter=dot']))).toEqual([]);

    const newline = String.fromCharCode(10);
    const tab = String.fromCharCode(9);
    for (const token of [';', 'a;b', '|', '&&', '$(id)', '`id`', '>out', '<in', `a${newline}b`, `a${tab}b`, '*', '~', '#', '{a,b}']) {
      expect(refusedPaths(withProbeArgv(profile, ['npm', 'run', token])), `token ${JSON.stringify(token)}`).toEqual([
        'tests.probe.command.argv.2',
      ]);
    }

    const checks = [{ name: 'lint', command: { state: 'resolved', argv: ['npm', 'run', 'lint|tee'], source: 'detection' } }];
    expect(refusedPaths({ ...profile, staticAnalysis: { state: 'resolved', checks, source: 'config' } })).toEqual([
      'staticAnalysis.checks.0.command.argv.2',
    ]);
  });

  /** A configured empty glob set is an unresolved term with a reason, never a resolved term with no glob. */
  it('VerificationProfileSchema_AResolvedGlobTermWithNoGlob_IsRefused', () => {
    const profile = nodeTestProfile();

    expect(refusedPaths(withTestGlobs(profile, []))).toEqual(['tests.globs.globs']);
    expect(refusedPaths(withTestGlobs(profile, ['**/*.test.*'], []))).toEqual(['tests.globs.replacedSeeds']);
    expect(
      refusedPaths({ ...profile, tests: { ...profile.tests, probe: { ...profile.tests.probe, globs: [] } } }),
    ).toEqual(['tests.probe.globs']);
    expect(refusedPaths(withTestGlobs(profile, Array.from({ length: 65 }, (_, i) => `t${i}/**`)))).toEqual([
      'tests.globs.globs',
    ]);

    expect(
      refusedPaths({
        ...profile,
        tests: { ...profile.tests, globs: { state: 'unresolved', reason: 'verification.tests.globs is an empty list' } },
      }),
    ).toEqual([]);
    expect(refusedPaths(withFirstParty(profile, []))).toEqual([]);
  });

  /** A glob or a config path that leaves the root names files outside the checkout that the capsule pins. */
  it('VerificationProfileSchema_AGlobThatLeavesTheRoot_IsRefused', () => {
    const profile = nodeTestProfile();
    for (const glob of ['**/*.test.*', 'a..b/**', '.github/**', 'servers/*/src/**']) {
      expect(refusedPaths(withTestGlobs(profile, [glob])), glob).toEqual([]);
    }

    for (const glob of ['../x/**', '/abs/**', 'a/../../b/**', '..', 'src/..', 'C:/x/**', '\\\\server\\share', 'src\\..\\x']) {
      expect(refusedPaths(withTestGlobs(profile, [glob])), glob).toEqual(['tests.globs.globs.0']);
      expect(refusedPaths(withTestGlobs(profile, ['**/*.test.*'], [glob])), glob).toEqual([
        'tests.globs.replacedSeeds.0',
      ]);
      expect(refusedPaths(withFirstParty(profile, ['src/**', glob])), glob).toEqual(['firstParty.globs.1']);
      expect(refusedPaths(withBoundaryConfig(profile, glob)), glob).toEqual(['boundaryChecks.0.config']);
    }
  });

  /** Each object of the profile is closed, so a key that no reader knows cannot ride in the capsule. */
  it('VerificationProfileSchema_AnUnknownKey_IsRefused', () => {
    const profile = nodeTestProfile();
    const { probe } = profile.tests;

    expect(unknownKeys({ ...profile, notes: 'smuggled' })).toEqual(['notes']);
    expect(unknownKeys({ ...profile, tests: { ...profile.tests, timeoutMs: 1 } })).toEqual(['timeoutMs']);
    expect(
      unknownKeys({ ...profile, tests: { ...profile.tests, probe: { ...probe, command: { ...probe.command, shell: true } } } }),
    ).toEqual(['shell']);
    expect(
      unknownKeys({
        ...profile,
        contract: { ...profile.contract, codegen: { state: 'unresolved', reason: 'no codegen', fallback: 'tsc' } },
      }),
    ).toEqual(['fallback']);
    expect(refusedPaths({ ...profile, tests: { ...profile.tests, globs: { state: 'pending' } } })).toEqual([
      'tests.globs.state',
    ]);
  });

  /** The shared fake is the profile that the gate tests pin. A fake that the schema refuses fails each such test for a wrong reason. */
  it('VerificationProfile_TheSharedPinnedFake_Parses', () => {
    const pinned = pinnedTestProfile(3);
    expect(pinned.capsuleVersion).toBe(3);
    expect(refusedPaths(pinned.profile)).toEqual([]);
  });

  /** Each gate names an unresolved term with one discriminant, so a reader matches one wire value. */
  it('VerificationProfile_TheUnresolvedDiscriminant_IsProfileUnresolved', () => {
    expect(PROFILE_UNRESOLVED).toBe('profile-unresolved');
  });
});
