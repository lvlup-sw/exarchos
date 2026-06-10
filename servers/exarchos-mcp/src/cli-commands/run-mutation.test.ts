import { describe, it, expect } from 'vitest';
import { handleRunMutation, type RunMutationDeps } from './run-mutation.js';
import type { ResolvedVerificationRuntime } from '../config/test-runtime-resolver.js';

// ─── Test utilities ──────────────────────────────────────────────────────────

interface Recorder {
  runs: Array<{ cmd: string; args: readonly string[]; cwd: string }>;
  out: string[];
  err: string[];
}

function makeDeps(
  resolved: ResolvedVerificationRuntime | Error,
  overrides: Partial<RunMutationDeps> = {},
): { deps: RunMutationDeps; rec: Recorder } {
  const rec: Recorder = { runs: [], out: [], err: [] };
  const deps: RunMutationDeps = {
    cwd: '/repo',
    resolve: () => {
      if (resolved instanceof Error) throw resolved;
      return resolved;
    },
    run: (cmd, args, cwd) => {
      rec.runs.push({ cmd, args, cwd });
      return 0;
    },
    stdout: (s) => rec.out.push(s),
    stderr: (s) => rec.err.push(s),
    ...overrides,
  };
  return { deps, rec };
}

const RESOLVED = (
  mutation: string | null,
  extra: Partial<ResolvedVerificationRuntime> = {},
): ResolvedVerificationRuntime => ({
  test: null,
  typecheck: null,
  install: null,
  mutation,
  lint: null,
  contract: null,
  source: mutation === null ? 'unresolved' : 'detection',
  ...extra,
});

// ─── Tests ─────────────────────────────────────────────────────────────────

describe('handleRunMutation', () => {
  it('RunMutation_DryRun_PrintsResolvedCommand', () => {
    const { deps, rec } = makeDeps(RESOLVED('npx stryker run'));

    const code = handleRunMutation(['--dry-run'], deps);

    expect(code).toBe(0);
    expect(rec.runs).toHaveLength(0);
    expect(rec.out.join('\n')).toContain('npx stryker run');
  });

  it('RunMutation_Unresolved_ExitsNonZeroWithRemediation', () => {
    const { deps, rec } = makeDeps(
      RESOLVED(null, {
        remediation: 'No mutation runner resolved. Add a .exarchos.yml mutation: command.',
      }),
    );

    const code = handleRunMutation([], deps);

    // Unlike run-tests (exit 0 on unresolved), an explicitly-invoked mutation
    // run with no resolvable runner is a non-zero failure with remediation.
    expect(code).not.toBe(0);
    expect(rec.runs).toHaveLength(0);
    expect(rec.err.join('\n')).toContain('mutation');
    expect(rec.err.join('\n')).toMatch(/\.exarchos\.yml|No mutation runner|remediation/i);
  });

  it('RunMutation_ChildExit_PropagatesExitCode', () => {
    const { deps } = makeDeps(RESOLVED('cargo mutants --in-diff'), {
      run: () => 3,
    });

    const code = handleRunMutation([], deps);

    expect(code).toBe(3);
  });
});
