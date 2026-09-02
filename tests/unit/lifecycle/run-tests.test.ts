import { describe, it, expect } from 'vitest';
import { handleRunTests, type RunTestsDeps } from '../../../src/lifecycle/run-tests.js';
import type { ResolvedRuntime } from '../../../src/config/test-runtime-resolver.js';

// ─── Test utilities ──────────────────────────────────────────────────────────

interface Recorder {
  runs: Array<{ cmd: string; args: readonly string[]; cwd: string }>;
  out: string[];
  err: string[];
}

function makeDeps(
  resolved: ResolvedRuntime | Error,
  overrides: Partial<RunTestsDeps> = {},
): { deps: RunTestsDeps; rec: Recorder } {
  const rec: Recorder = { runs: [], out: [], err: [] };
  const deps: RunTestsDeps = {
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

const RESOLVED = (test: string | null, extra: Partial<ResolvedRuntime> = {}): ResolvedRuntime => ({
  test,
  typecheck: null,
  install: null,
  source: test === null ? 'unresolved' : 'detection',
  ...extra,
});

// ─── Tests ─────────────────────────────────────────────────────────────────

describe('handleRunTests', () => {
  it('RunTests_ResolvedCommand_ExecsItAndReturnsExitCode', () => {
    const { deps, rec } = makeDeps(RESOLVED('pytest -q'));

    const code = handleRunTests([], deps);

    expect(code).toBe(0);
    expect(rec.runs).toEqual([{ cmd: 'pytest', args: ['-q'], cwd: '/repo' }]);
  });

  it('RunTests_TestProcessFails_PropagatesNonZeroExitCode', () => {
    const { deps } = makeDeps(RESOLVED('cargo test'), {
      run: () => 2,
    });

    const code = handleRunTests([], deps);

    expect(code).toBe(2);
  });

  it('RunTests_Unresolved_SkipsVisiblyAndExitsZero', () => {
    const { deps, rec } = makeDeps(
      RESOLVED(null, { remediation: 'No project markers detected. Add a .exarchos.yml.' }),
    );

    const code = handleRunTests([], deps);

    expect(code).toBe(0);
    expect(rec.runs).toHaveLength(0);
    // Visible, not silent (DIM-2): the skip reason reaches stderr.
    expect(rec.err.join('\n')).toContain('No project markers');
  });

  it('RunTests_MalformedConfig_SurfacesErrorAndExitsNonZero', () => {
    const { deps, rec } = makeDeps(new Error('Failed to parse .exarchos.yml at /repo/.exarchos.yml'));

    const code = handleRunTests([], deps);

    expect(code).toBe(1);
    expect(rec.runs).toHaveLength(0);
    expect(rec.err.join('\n')).toContain('.exarchos.yml');
  });

  it('RunTests_DryRun_PrintsResolvedCommandWithoutExecuting', () => {
    const { deps, rec } = makeDeps(RESOLVED('npm run test:run'));

    const code = handleRunTests(['--dry-run'], deps);

    expect(code).toBe(0);
    expect(rec.runs).toHaveLength(0);
    expect(rec.out.join('\n')).toContain('npm run test:run');
  });
});
