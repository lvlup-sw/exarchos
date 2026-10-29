/**
 * The shared verification profile fake. It is the profile of a Node fixture with the co-located test globs and `npm run test:files`.
 * A test that calls a gate in a segment, or a gate at a root with no test command, pins this profile.
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
      codegen: { state: 'unresolved', reason: 'contract.codegen: no contract toolchain matches the fixture' },
      diff: { state: 'unresolved', reason: 'contract.diff: no contract toolchain matches the fixture' },
      typecheck: { state: 'resolved', argv: ['npm', 'run', 'typecheck'], source: 'detection' },
    },
    boundaryChecks: [],
    firstParty: { state: 'resolved', globs: ['src/**', 'servers/*/src/**'], source: 'detection' },
  };
}

/** The Node fixture profile as capsule `capsuleVersion` pins it in the dispatch context. */
export function pinnedTestProfile(capsuleVersion: number): PinnedVerificationProfile {
  return { capsuleVersion, profile: nodeTestProfile() };
}
