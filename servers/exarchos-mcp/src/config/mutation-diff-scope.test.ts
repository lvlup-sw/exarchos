// ─── mutation diff-scope augmentation — per-runner table (RED→GREEN) ────────
//
// Task 002 (design §4.2): how to scope a resolved mutation command to a diff
// base, keyed by toolchain id. Identity lives in the toolchains SoT module so
// consumers stay runner-agnostic; the resolver applies the augmentation, the
// handler never knows a `--since` flag from a `--in-diff`.
//
// The diff-scope is a tagged DESCRIPTOR, not a string rewrite at the call site —
// four shapes:
//   - append-flag      → append `--since=<base>` (Stryker) etc.
//   - already-native   → the runner is already diff-native (cargo-mutants
//                        `--in-diff`); no augmentation, no double-scope.
//   - path-restricted  → restrict to changed paths (mutmut) — the handler maps
//                        the diff to paths; the descriptor names the strategy.
//   - unscoped-warning → no known augmentation; run unscoped WITH a warning so
//                        the `< minutes` acceptance is never silently violated.
// ────────────────────────────────────────────────────────────────────────────

import { describe, it, expect } from 'vitest';

import { resolveMutationDiffScope } from './toolchains.js';

describe('resolveMutationDiffScope (per-runner diff-scope table)', () => {
  const BASE = 'origin/main';

  it('ResolveMutationDiffScope_NodeStryker_AppendsSinceFlag', () => {
    const scope = resolveMutationDiffScope('node', BASE);
    expect(scope.kind).toBe('append-flag');
    if (scope.kind === 'append-flag') {
      // Stryker scopes a run to the diff with `--since=<base>`.
      expect(scope.flag).toBe('--since=origin/main');
    }
    expect(scope.warning).toBeUndefined();
  });

  it('ResolveMutationDiffScope_DotnetStryker_AppendsSinceFlag', () => {
    const scope = resolveMutationDiffScope('dotnet', BASE);
    expect(scope.kind).toBe('append-flag');
    if (scope.kind === 'append-flag') {
      // dotnet-stryker takes the value as a separate token: `--since origin/main`.
      expect(scope.flag).toBe('--since origin/main');
    }
  });

  it('ResolveMutationDiffScope_RustCargoMutants_AlreadyDiffNative', () => {
    // cargo-mutants resolves to `cargo mutants --in-diff` — already diff-native.
    // The resolver must NOT append a second scope flag (no double-scope).
    const scope = resolveMutationDiffScope('rust', BASE);
    expect(scope.kind).toBe('already-native');
    expect(scope.warning).toBeUndefined();
  });

  it('ResolveMutationDiffScope_PythonMutmut_RestrictsToChangedPaths', () => {
    // mutmut has no `--since`; the run is restricted to the changed paths via
    // `--paths-to-mutate`, whose `<changed>` placeholder the applier fills.
    const scope = resolveMutationDiffScope('python', BASE);
    expect(scope.kind).toBe('path-restricted');
    if (scope.kind === 'path-restricted') {
      expect(scope.flag).toBe('--paths-to-mutate=<changed>');
    }
    expect(scope.warning).toBeUndefined();
  });

  it('ResolveMutationDiffScope_JavaPit_AppendsTargetClasses', () => {
    // PIT scopes via `-DtargetClasses=<changed>` (design §4.2 table). Both Java
    // toolchains (maven + gradle) share the PIT scoping strategy.
    for (const id of ['java-maven', 'java-gradle']) {
      const scope = resolveMutationDiffScope(id, BASE);
      expect(scope.kind).toBe('append-flag');
      if (scope.kind === 'append-flag') {
        expect(scope.flag).toContain('-DtargetClasses=');
      }
    }
  });

  it('ResolveMutationDiffScope_UnknownToolchain_SignalsUnscopedWarning', () => {
    // No known augmentation → unscoped WITH a warning (never silently full).
    const scope = resolveMutationDiffScope('cobol-mutator', BASE);
    expect(scope.kind).toBe('unscoped-warning');
    expect(typeof scope.warning).toBe('string');
    expect((scope.warning ?? '').length).toBeGreaterThan(0);
  });

  it('ResolveMutationDiffScope_ToolchainWithNoMutationRunner_SignalsUnscopedWarning', () => {
    // go/swift/cmake have `mutation: null` in the registry — no runner to scope,
    // so they fall through to the warning arm rather than pretending a scope.
    const scope = resolveMutationDiffScope('go', BASE);
    expect(scope.kind).toBe('unscoped-warning');
    expect(scope.warning).toBeDefined();
  });
});
