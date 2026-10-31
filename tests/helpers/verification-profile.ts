/**
 * The shared verification profile fake. It is the profile of a Node fixture with the co-located test globs and `npm run test:files`.
 * It is equal to the output of the resolver for a Node root with the `test:files`, `test:run`, `lint` and `typecheck` scripts.
 * A test that calls a gate in a segment, or a gate at a root with no test command, pins this profile.
 * The other fakes each give one changed term: C# globs, polyglot globs, a probe of the `none` form, or an unresolved term.
 * The fake imports only types, so it adds no runtime edge into the source.
 */

import type {
  PinnedVerificationProfile,
  VerificationProfile,
} from '../../src/workflow/verification/profile.js';

/** The co-located test globs of a Node fixture. */
const CO_LOCATED_TEST_GLOBS: readonly string[] = ['**/*.test.*', '**/*.spec.*', '**/__tests__/**'];

/** The directory names that mark test support in a Node fixture. */
const TEST_SUPPORT_SEGMENTS: readonly string[] = [
  'tests',
  'test',
  '__tests__',
  '__mocks__',
  '__fixtures__',
  'fixtures',
  'test-helpers',
];

/** The test terms of the profile. */
type TestTerms = VerificationProfile['tests'];

/** The reason of the unresolved glob term of {@link pinnedUnresolvedGlobProfile}. It is the reason of a configured empty list. */
export const UNRESOLVED_GLOBS_REASON =
  'tests.globs: verification.tests.globs is empty, so no changed file is a test. Set at least one glob, or remove the key to use the seeds.';

/** The reason of the unresolved term of {@link pinnedUnresolvedFirstPartyProfile}. It is the reason of a glob that leaves the root. */
export const UNRESOLVED_FIRST_PARTY_REASON =
  "firstParty: ownership.firstParty holds the glob '../shared/**', which leaves the root. Each glob is a relative path with no '..' segment.";

/** Returns a new profile of a Node fixture on each call, so a test can change its copy. */
export function nodeTestProfile(): VerificationProfile {
  return {
    toolchains: ['node'],
    tests: {
      globs: { state: 'resolved', globs: [...CO_LOCATED_TEST_GLOBS], source: 'detection' },
      support: { segments: [...TEST_SUPPORT_SEGMENTS], source: 'detection' },
      probe: {
        command: { state: 'resolved', argv: ['npm', 'run', 'test:files'], source: 'detection' },
        files: 'after-separator',
        failureExitCodes: { codes: [1], source: 'detection' },
        globs: [...CO_LOCATED_TEST_GLOBS],
      },
    },
    staticAnalysis: {
      state: 'resolved',
      checks: [
        { name: 'lint', command: { state: 'resolved', argv: ['npm', 'run', 'lint'], source: 'detection' } },
        {
          name: 'typecheck',
          command: { state: 'resolved', argv: ['npm', 'run', 'typecheck'], source: 'detection' },
        },
      ],
      source: 'detection',
    },
    integration: {
      command: { state: 'resolved', argv: ['npm', 'run', 'test:run'], source: 'detection' },
      report: 'exit-code',
      failureExitCodes: { codes: [1], source: 'detection' },
    },
    contract: {
      codegen: { state: 'unresolved', reason: 'contract.codegen: no contract command resolves. Set contract.codegen in .exarchos.yml.' },
      diff: { state: 'unresolved', reason: 'contract.diff: no contract command resolves. Set contract.diff in .exarchos.yml.' },
      typecheck: { state: 'resolved', argv: ['npm', 'run', 'typecheck'], source: 'detection' },
    },
    boundaryChecks: [],
    firstParty: { state: 'resolved', globs: ['src/**', 'servers/*/src/**'], source: 'detection' },
  };
}

/** The Node fixture profile as capsule `capsuleVersion` pins it in the dispatch context. Each given test term replaces the term of the fixture. */
export function pinnedTestProfile(capsuleVersion: number, tests: Partial<TestTerms> = {}): PinnedVerificationProfile {
  const profile = nodeTestProfile();
  return { capsuleVersion, profile: { ...profile, tests: { ...profile.tests, ...tests } } };
}

/** A configured glob term that names only C# tests. */
export function cSharpGlobTerm(): TestTerms['globs'] {
  return { state: 'resolved', globs: ['**/*Tests.cs'], source: 'config' };
}

/** A configured co-located glob term of a Node root beside a solution. It keeps the test-name globs of the seeds that it replaces. */
export function polyglotGlobTerm(): TestTerms['globs'] {
  return {
    state: 'resolved',
    globs: [...CO_LOCATED_TEST_GLOBS],
    source: 'config',
    replacedSeeds: ['**/*.test.*', '**/*.spec.*', '**/*Tests.cs', '**/*Test.cs'],
  };
}

/** A probe term of the `none` form: the run of `argv` takes no file list. */
export function unscopedProbeTerm(argv: readonly string[]): TestTerms['probe'] {
  return {
    command: { state: 'resolved', argv: [...argv], source: 'config' },
    files: 'none',
    failureExitCodes: { codes: [1], source: 'detection' },
    globs: [...CO_LOCATED_TEST_GLOBS],
  };
}

/** A profile that capsule `capsuleVersion` pins, whose glob term is unresolved. */
export function pinnedUnresolvedGlobProfile(capsuleVersion: number): PinnedVerificationProfile {
  return pinnedTestProfile(capsuleVersion, { globs: { state: 'unresolved', reason: UNRESOLVED_GLOBS_REASON } });
}

/** A profile that capsule `capsuleVersion` pins, whose `firstParty` term is unresolved. */
export function pinnedUnresolvedFirstPartyProfile(capsuleVersion: number): PinnedVerificationProfile {
  return {
    capsuleVersion,
    profile: { ...nodeTestProfile(), firstParty: { state: 'unresolved', reason: UNRESOLVED_FIRST_PARTY_REASON } },
  };
}
