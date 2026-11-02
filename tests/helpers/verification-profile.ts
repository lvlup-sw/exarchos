/**
 * The shared verification profile fake. It is the profile of a Node fixture with the co-located test globs and `npm run test:files`.
 * It is equal to the output of the resolver for a Node root with the `test:files`, `test:run`, `lint` and `typecheck` scripts.
 * A test that calls a gate in a segment, or a gate at a root with no test command, pins this profile.
 * The other fakes each give one changed term, such as C# globs, a probe of the `none` form, the contract legs or an unresolved term.
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

/** One boundary check of the profile. */
type BoundaryCheck = VerificationProfile['boundaryChecks'][number];

/** The argv of each contract leg that resolves. A leg with no argv is unresolved. */
interface ContractLegs {
  readonly codegen?: readonly string[];
  readonly diff?: readonly string[];
  readonly typecheck?: readonly string[];
}

/** The reason of the unresolved glob term of {@link pinnedUnresolvedGlobProfile}. It is the reason of a configured empty list. */
export const UNRESOLVED_GLOBS_REASON =
  'tests.globs: verification.tests.globs is empty, so no changed file is a test. Set at least one glob, or remove the key to use the seeds.';

/** The reason of the unresolved term of {@link pinnedUnresolvedFirstPartyProfile}. It is the reason of a glob that leaves the root. */
export const UNRESOLVED_FIRST_PARTY_REASON =
  "firstParty: ownership.firstParty holds the glob '../shared/**', which leaves the root. Each glob is a relative path with no '..' segment.";

/** The reason of the unresolved check of {@link unresolvedLintProfile}. It is the reason of a Node seed with no `lint` script. */
export const UNRESOLVED_LINT_REASON =
  "staticAnalysis.lint: no 'lint' script in package.json. Add the script, or set verification.staticAnalysis.lint or the top-level lint: key.";

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

/** A resolved static-analysis term with one configured check for each entry of `checks`, in key order. */
export function staticAnalysisTerm(checks: Readonly<Record<string, readonly string[]>>): VerificationProfile['staticAnalysis'] {
  return {
    state: 'resolved',
    checks: Object.entries(checks).map(([name, argv]) => ({
      name,
      command: { state: 'resolved', argv: [...argv], source: 'config' },
    })),
    source: 'config',
  };
}

/** A contract term with the given legs. Each other leg is unresolved, with the reason of a root that has no contract tool. */
export function contractTerm(legs: ContractLegs): VerificationProfile['contract'] {
  const leg = (name: keyof ContractLegs): VerificationProfile['contract'][keyof ContractLegs] => {
    const argv = legs[name];
    return argv === undefined
      ? { state: 'unresolved', reason: `contract.${name}: no contract command resolves. Set contract.${name} in .exarchos.yml.` }
      : { state: 'resolved', argv: [...argv], source: 'config' };
  };
  return { codegen: leg('codegen'), diff: leg('diff'), typecheck: leg('typecheck') };
}

/** The dependency-cruiser check of a root with `config`: the seed argv, the config and the adapter. */
export function cruiserCheck(config = '.dependency-cruiser.cjs'): BoundaryCheck {
  return {
    adapter: 'dependency-cruiser',
    command: { state: 'resolved', argv: ['depcruise', '--validate', config, '--output-type', 'json'], source: 'detection' },
    config,
  };
}

/** The semgrep-taint check of a root with `config`: the seed argv, the config and the adapter. */
export function taintCheck(config = '.semgrep/no-raw-io-into-core.yml'): BoundaryCheck {
  return {
    adapter: 'semgrep-taint',
    command: { state: 'resolved', argv: ['semgrep', '--error', '--quiet', '--config', config], source: 'detection' },
    config,
  };
}

/** The Node fixture profile with the given boundary checks. A given `firstParty` term replaces the term of the fixture. */
export function boundaryProfile(
  boundaryChecks: readonly BoundaryCheck[],
  firstParty?: VerificationProfile['firstParty'],
): VerificationProfile {
  const profile = nodeTestProfile();
  return { ...profile, boundaryChecks: [...boundaryChecks], firstParty: firstParty ?? profile.firstParty };
}

/** The profile of a Node fixture whose `lint` check is unresolved. Its `typecheck` check stays resolved. */
export function unresolvedLintProfile(): VerificationProfile {
  return {
    ...nodeTestProfile(),
    staticAnalysis: {
      state: 'resolved',
      checks: [
        { name: 'lint', command: { state: 'unresolved', reason: UNRESOLVED_LINT_REASON } },
        {
          name: 'typecheck',
          command: { state: 'resolved', argv: ['npm', 'run', 'typecheck'], source: 'detection' },
        },
      ],
      source: 'detection',
    },
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
