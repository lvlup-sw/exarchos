import { describe, it, expect } from 'vitest';
import { handleRunTests, type HostedTestRun, type RunTestsDeps, type RunTestsHost } from '../../../src/lifecycle/run-tests.js';
import type { ResolvedRuntime } from '../../../src/config/test-runtime-resolver.js';

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

/** A host that records each hosted call and returns one fixed outcome. */
function hostOf(outcome: HostedTestRun): { host: RunTestsHost; calls: Array<{ cwd: string; argv: readonly string[] }> } {
  const calls: Array<{ cwd: string; argv: readonly string[] }> = [];
  return { calls, host: { run: async (cwd, argv) => { calls.push({ cwd, argv }); return outcome; } } };
}

describe('handleRunTests', () => {
  it('RunTests_ResolvedCommand_ExecsItAndReturnsExitCode', async () => {
    const { deps, rec } = makeDeps(RESOLVED('pytest -q'));

    const code = await handleRunTests([], deps);

    expect(code).toBe(0);
    expect(rec.runs).toEqual([{ cmd: 'pytest', args: ['-q'], cwd: '/repo' }]);
  });

  it('RunTests_TestProcessFails_PropagatesNonZeroExitCode', async () => {
    const { deps } = makeDeps(RESOLVED('cargo test'), {
      run: () => 2,
    });

    const code = await handleRunTests([], deps);

    expect(code).toBe(2);
  });

  /** The skip is visible because its reason goes to stderr. */
  it('RunTests_Unresolved_SkipsVisiblyAndExitsZero', async () => {
    const { deps, rec } = makeDeps(
      RESOLVED(null, { remediation: 'No project markers detected. Add a .exarchos.yml.' }),
    );

    const code = await handleRunTests([], deps);

    expect(code).toBe(0);
    expect(rec.runs).toHaveLength(0);
    expect(rec.err.join('\n')).toContain('No project markers');
  });

  it('RunTests_MalformedConfig_SurfacesErrorAndExitsNonZero', async () => {
    const { deps, rec } = makeDeps(new Error('Failed to parse .exarchos.yml at /repo/.exarchos.yml'));

    const code = await handleRunTests([], deps);

    expect(code).toBe(1);
    expect(rec.runs).toHaveLength(0);
    expect(rec.err.join('\n')).toContain('.exarchos.yml');
  });

  it('RunTests_DryRun_PrintsResolvedCommandWithoutExecuting', async () => {
    const { deps, rec } = makeDeps(RESOLVED('npm run test:run'));

    const code = await handleRunTests(['--dry-run'], deps);

    expect(code).toBe(0);
    expect(rec.runs).toHaveLength(0);
    expect(rec.out.join('\n')).toContain('npm run test:run');
  });

  /** A provisioned machine waits for the signed result and returns the actual child exit code. No local run starts. */
  it('RunTests_Hosted_ReturnsSignedChildExitCodeWithoutLocalRun', async () => {
    const { host, calls } = hostOf({ kind: 'exited', exitCode: 3, stdout: 'suite output', stderr: 'suite diagnostics' });
    const { deps, rec } = makeDeps(RESOLVED('node test.cjs --flag'), { host });

    const code = await handleRunTests([], deps);

    expect(code).toBe(3);
    expect(rec.runs).toHaveLength(0);
    expect(calls).toEqual([{ cwd: '/repo', argv: ['node', 'test.cjs', '--flag'] }]);
    expect(rec.out).toEqual(['suite output']);
    expect(rec.err).toEqual(['suite diagnostics']);
  });

  /** A host refusal, a key conflict and a dirty tree exit 77. An unavailable or pending verifier exits 75. Each keeps its own message. */
  it('RunTests_Hosted_RefusalExits77AndUnavailableExits75WithDistinctMessages', async () => {
    const refused = hostOf({ kind: 'refused', message: 'The checkout has uncommitted changes. Commit them first, then run the check again.' });
    const first = makeDeps(RESOLVED('node test.cjs'), { host: refused.host });
    expect(await handleRunTests([], first.deps)).toBe(77);
    expect(first.rec.err.join('\n')).toContain('Commit them first');
    expect(first.rec.err.join('\n')).toContain('refused');

    const unavailable = hostOf({ kind: 'unavailable', message: 'The hosted test run gave no verdict: the verifier stopped the run at its pinned time limit.' });
    const second = makeDeps(RESOLVED('node test.cjs'), { host: unavailable.host });
    expect(await handleRunTests([], second.deps)).toBe(75);
    expect(second.rec.err.join('\n')).toContain('pinned time limit');
    expect(second.rec.err.join('\n')).toContain('no result');
    expect([...first.rec.runs, ...second.rec.runs]).toHaveLength(0);
  });

  /** With a host, an unresolved command, a malformed config and a dry run keep their own exits and make no hosted request. */
  it('RunTests_Hosted_UnresolvedMalformedAndDryRunMakeNoRequest', async () => {
    const { host, calls } = hostOf({ kind: 'exited', exitCode: 0, stdout: '', stderr: '' });

    expect(await handleRunTests([], makeDeps(RESOLVED(null, { remediation: 'No project markers detected.' }), { host }).deps)).toBe(0);
    expect(await handleRunTests([], makeDeps(new Error('Failed to parse .exarchos.yml'), { host }).deps)).toBe(1);
    const dry = makeDeps(RESOLVED('node test.cjs'), { host });
    expect(await handleRunTests(['--dry-run'], dry.deps)).toBe(0);
    expect(dry.rec.out).toEqual(['node test.cjs']);
    expect(calls).toHaveLength(0);
  });
});
