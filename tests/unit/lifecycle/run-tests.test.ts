import { describe, it, expect } from 'vitest';
import { handleRunTests, type LocalTestRun, type RunTestsDeps, type RunTestsHost } from '../../../src/lifecycle/run-tests.js';
import type { ResolvedRuntime } from '../../../src/config/test-runtime-resolver.js';

interface Recorder {
  out: string[];
  err: string[];
}

function makeDeps(
  resolved: ResolvedRuntime | Error,
  overrides: Partial<RunTestsDeps> = {},
): { deps: RunTestsDeps; rec: Recorder } {
  const rec: Recorder = { out: [], err: [] };
  const deps: RunTestsDeps = {
    cwd: '/repo',
    host: { run: async () => { throw new Error('This case runs no test command'); } },
    resolve: () => {
      if (resolved instanceof Error) throw resolved;
      return resolved;
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

/** A host that records each local call and returns one fixed outcome. */
function hostOf(outcome: LocalTestRun): { host: RunTestsHost; calls: Array<{ cwd: string; argv: readonly string[] }> } {
  const calls: Array<{ cwd: string; argv: readonly string[] }> = [];
  return { calls, host: { run: async (cwd, argv) => { calls.push({ cwd, argv }); return outcome; } } };
}

describe('handleRunTests', () => {
  /** The skip is visible because its reason goes to stderr. */
  it('RunTests_Unresolved_SkipsVisiblyAndExitsZero', async () => {
    const { deps, rec } = makeDeps(
      RESOLVED(null, { remediation: 'No project markers detected. Add a .exarchos.yml.' }),
    );

    const code = await handleRunTests([], deps);

    expect(code).toBe(0);
    expect(rec.err.join('\n')).toContain('No project markers');
    expect(rec.err.join('\n')).not.toContain('provision');
  });

  it('RunTests_MalformedConfig_SurfacesErrorAndExitsNonZero', async () => {
    const { deps, rec } = makeDeps(new Error('Failed to parse .exarchos.yml at /repo/.exarchos.yml'));

    const code = await handleRunTests([], deps);

    expect(code).toBe(1);
    expect(rec.err.join('\n')).toContain('.exarchos.yml');
  });

  it('RunTests_DryRun_PrintsResolvedCommandWithoutExecuting', async () => {
    const { deps, rec } = makeDeps(RESOLVED('npm run test:run'));

    const code = await handleRunTests(['--dry-run'], deps);

    expect(code).toBe(0);
    expect(rec.err).toEqual([]);
    expect(rec.out.join('\n')).toContain('npm run test:run');
  });

  /** The local host runs the resolved argv in the cwd, and the verb returns the child exit code with its output. */
  it('RunTests_LocalHost_ReturnsTheChildExitCodeAndOutput', async () => {
    const { host, calls } = hostOf({ kind: 'exited', exitCode: 3, stdout: 'suite output', stderr: 'suite diagnostics' });
    const { deps, rec } = makeDeps(RESOLVED('node test.cjs --flag'), { host });

    const code = await handleRunTests([], deps);

    expect(code).toBe(3);
    expect(calls).toEqual([{ cwd: '/repo', argv: ['node', 'test.cjs', '--flag'] }]);
    expect(rec.out).toEqual(['suite output']);
    expect(rec.err).toEqual(['suite diagnostics']);
  });

  /** A refused run exits 77, and a run with no verdict exits 75. Each keeps its own message. No outcome exits 78. */
  it('RunTests_LocalHost_RefusalExits77AndNoVerdictExits75WithDistinctMessages', async () => {
    const refused = hostOf({ kind: 'refused', message: 'The working directory is not the root of its checkout.' });
    const first = makeDeps(RESOLVED('node test.cjs'), { host: refused.host });
    expect(await handleRunTests([], first.deps)).toBe(77);
    expect(first.rec.err.join('\n')).toContain('not the root of its checkout');
    expect(first.rec.err.join('\n')).toContain('refused');

    const unavailable = hostOf({ kind: 'unavailable', message: 'The test run gave no verdict: the executor stopped the run at its time cap.' });
    const second = makeDeps(RESOLVED('node test.cjs'), { host: unavailable.host });
    expect(await handleRunTests([], second.deps)).toBe(75);
    expect(second.rec.err.join('\n')).toContain('time cap');
    expect(second.rec.err.join('\n')).toContain('no result');
    expect([...refused.calls, ...unavailable.calls]).toHaveLength(2);
  });

  /** An unresolved command, a malformed config and a dry run keep their own exits and run nothing. */
  it('RunTests_LocalHost_UnresolvedMalformedAndDryRunRunNothing', async () => {
    const { host, calls } = hostOf({ kind: 'exited', exitCode: 0, stdout: '', stderr: '' });

    expect(await handleRunTests([], makeDeps(RESOLVED(null, { remediation: 'No project markers detected.' }), { host }).deps)).toBe(0);
    expect(await handleRunTests([], makeDeps(new Error('Failed to parse .exarchos.yml'), { host }).deps)).toBe(1);
    const dry = makeDeps(RESOLVED('node test.cjs'), { host });
    expect(await handleRunTests(['--dry-run'], dry.deps)).toBe(0);
    expect(dry.rec.out).toEqual(['node test.cjs']);
    expect(calls).toHaveLength(0);
  });
});
