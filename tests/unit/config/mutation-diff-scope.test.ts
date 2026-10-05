/**
 * `resolveMutationDiffScope`: how to scope the mutation command of each toolchain to a diff base.
 * The result is a tagged descriptor with four kinds: `append-flag`, `already-native`,
 * `path-restricted` and `unscoped-warning`.
 */
import { describe, it, expect } from 'vitest';

import { resolveMutationDiffScope } from '../../../src/config/toolchains.js';

describe('resolveMutationDiffScope (per-runner diff-scope table)', () => {
  const BASE = 'origin/main';

  it('ResolveMutationDiffScope_NodeStryker_AppendsSinceFlag', () => {
    const scope = resolveMutationDiffScope('node', BASE);
    expect(scope.kind).toBe('append-flag');
    if (scope.kind === 'append-flag') {
      expect(scope.flag).toBe('--since=origin/main');
    }
    expect(scope.warning).toBeUndefined();
  });

  /** Stryker.NET takes the value as a separate token. */
  it('ResolveMutationDiffScope_DotnetStryker_AppendsSinceFlag', () => {
    const scope = resolveMutationDiffScope('dotnet', BASE);
    expect(scope.kind).toBe('append-flag');
    if (scope.kind === 'append-flag') {
      expect(scope.flag).toBe('--since origin/main');
    }
  });

  it('ResolveMutationDiffScope_RustCargoMutants_AlreadyDiffNative', () => {
    const scope = resolveMutationDiffScope('rust', BASE);
    expect(scope.kind).toBe('already-native');
    expect(scope.warning).toBeUndefined();
  });

  it('ResolveMutationDiffScope_PythonMutmut_RestrictsToChangedPaths', () => {
    const scope = resolveMutationDiffScope('python', BASE);
    expect(scope.kind).toBe('path-restricted');
    if (scope.kind === 'path-restricted') {
      expect(scope.flag).toBe('--paths-to-mutate=<changed>');
    }
    expect(scope.warning).toBeUndefined();
  });

  it('ResolveMutationDiffScope_JavaPit_AppendsTargetClasses', () => {
    for (const id of ['java-maven', 'java-gradle']) {
      const scope = resolveMutationDiffScope(id, BASE);
      expect(scope.kind).toBe('append-flag');
      if (scope.kind === 'append-flag') {
        expect(scope.flag).toContain('-DtargetClasses=');
      }
    }
  });

  it('ResolveMutationDiffScope_UnknownToolchain_SignalsUnscopedWarning', () => {
    const scope = resolveMutationDiffScope('cobol-mutator', BASE);
    expect(scope.kind).toBe('unscoped-warning');
    expect(typeof scope.warning).toBe('string');
    expect((scope.warning ?? '').length).toBeGreaterThan(0);
  });

  /** `go` has `mutation: null` in the registry, so no runner exists to scope. */
  it('ResolveMutationDiffScope_ToolchainWithNoMutationRunner_SignalsUnscopedWarning', () => {
    const scope = resolveMutationDiffScope('go', BASE);
    expect(scope.kind).toBe('unscoped-warning');
    expect(scope.warning).toBeDefined();
  });
});
