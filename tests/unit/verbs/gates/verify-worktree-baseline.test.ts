import { describe, it, expect, vi, afterEach } from 'vitest';
import { realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';

vi.mock('node:fs', () => ({
  existsSync: vi.fn(),
  readdirSync: vi.fn(),
  readFileSync: vi.fn(),
}));

vi.mock('node:child_process', () => ({
  execFileSync: vi.fn(),
}));

vi.mock('../../../../src/utils/paths.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../src/utils/paths.js')>()),
  gitCommonDirOf: vi.fn(() => '/worktree/.git'),
}));

vi.mock('../../../../src/verbs/gates/gate-runner.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../src/verbs/gates/gate-runner.js')>();
  return { ...actual, admitLifecycleLegs: vi.fn(actual.admitLifecycleLegs) };
});

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { handleVerifyWorktreeBaseline } from '../../../../src/verbs/gates/verify-worktree-baseline.js';
import { admitLifecycleLegs } from '../../../../src/verbs/gates/gate-runner.js';
import { gitCommonDirOf } from '../../../../src/utils/paths.js';
import type { VerificationHostConnector } from '../../../../src/contract/verification/harness-verification.js';

/** A package.json with the `test:run` script that the npm path of the resolver requires. */
const NPM_PACKAGE_JSON = JSON.stringify({ scripts: { 'test:run': 'vitest run' } });

/** A connector for the cases whose signed test leg is stubbed. */
const connector: VerificationHostConnector = {
  publicKey: 'unused', gitPath: '/nonexistent/git', resourceId: 'unused', profileId: 'unused',
  client: { submit: async () => ({ kind: 'unavailable', reason: 'unused' }), retrieve: async () => ({ kind: 'unavailable', reason: 'unused' }) },
};

/** Stub the next signed baseline leg of the verifier. */
function signedLeg(exitCode: number, stdout = '', stderr = ''): void {
  vi.mocked(admitLifecycleLegs).mockResolvedValueOnce([
    { name: 'test', kind: 'command', run: { end: 'exited', exitCode, stdout, stderr, outputDigest: 'a'.repeat(64) } },
  ]);
}

/** The argument vector of the one admitted baseline leg. */
function admittedArgv(): readonly string[] | undefined {
  return vi.mocked(admitLifecycleLegs).mock.calls[0]?.[0].legs[0]?.argv;
}

/** A connector whose verifier no case reaches. Each exchange records its call. */
function unreachableConnector(exchanges: string[]): VerificationHostConnector {
  return {
    publicKey: 'unused', gitPath: '/nonexistent/git', resourceId: 'unused', profileId: 'unused',
    client: {
      submit: async () => { exchanges.push('submit'); return { kind: 'unavailable', reason: 'unused' }; },
      retrieve: async () => { exchanges.push('retrieve'); return { kind: 'unavailable', reason: 'unused' }; },
    },
  };
}

describe('handleVerifyWorktreeBaseline', () => {
  const stateDir = '/tmp/test-state';

  afterEach(() => {
    vi.restoreAllMocks();
    vi.mocked(admitLifecycleLegs).mockClear();
    vi.mocked(gitCommonDirOf).mockClear();
  });

  it('NodeProject_TestsPass_ReturnsPassedTrue', async () => {
    vi.mocked(existsSync).mockImplementation((p) => {
      const s = String(p).replace(/\\/g, '/').replace(/^[A-Za-z]:/, '');
      if (s === '/worktree') return true;
      if (s === '/worktree/package.json') return true;
      return false;
    });
    vi.mocked(readdirSync).mockReturnValue([]);
    vi.mocked(readFileSync).mockImplementation((p) => {
      if (String(p).endsWith('package.json')) return NPM_PACKAGE_JSON;
      throw new Error(`unexpected readFileSync: ${String(p)}`);
    });
    signedLeg(0, 'Tests passed\n');

    const result = await handleVerifyWorktreeBaseline({ worktreePath: '/worktree' }, stateDir, connector);

    expect(result.success).toBe(true);
    const data = result.data as { passed: boolean; projectType: string; testCommand: string; report: string };
    expect(data.passed).toBe(true);
    expect(data.projectType).toBe('Node.js');
    expect(data.testCommand).toBe('npm run test:run');
    expect(data.report).toContain('PASS');
    expect(execFileSync).not.toHaveBeenCalled();
  });

  it('DotNetProject_TestsPass_ReturnsPassedTrue', async () => {
    vi.mocked(existsSync).mockImplementation((p) => {
      const s = String(p).replace(/\\/g, '/').replace(/^[A-Za-z]:/, '');
      if (s === '/worktree') return true;
      return false;
    });
    vi.mocked(readdirSync).mockReturnValue(['MyApp.csproj' as unknown as ReturnType<typeof readdirSync>[number]]);
    signedLeg(0, 'All tests passed\n');

    const result = await handleVerifyWorktreeBaseline({ worktreePath: '/worktree' }, stateDir, connector);

    expect(result.success).toBe(true);
    const data = result.data as { passed: boolean; projectType: string; testCommand: string };
    expect(data.passed).toBe(true);
    expect(data.projectType).toBe('.NET');
    expect(data.testCommand).toBe('dotnet test');
  });

  it('RustProject_TestsPass_ReturnsPassedTrue', async () => {
    vi.mocked(existsSync).mockImplementation((p) => {
      const s = String(p).replace(/\\/g, '/').replace(/^[A-Za-z]:/, '');
      if (s === '/worktree') return true;
      if (s === '/worktree/Cargo.toml') return true;
      return false;
    });
    vi.mocked(readdirSync).mockReturnValue([]);
    signedLeg(0, 'test result: ok\n');

    const result = await handleVerifyWorktreeBaseline({ worktreePath: '/worktree' }, stateDir, connector);

    expect(result.success).toBe(true);
    const data = result.data as { passed: boolean; projectType: string; testCommand: string };
    expect(data.passed).toBe(true);
    expect(data.projectType).toBe('Rust');
    expect(data.testCommand).toBe('cargo test');
  });

  it('UnknownProjectType_ReturnsError', async () => {
    vi.mocked(existsSync).mockImplementation((p) => {
      const s = String(p).replace(/\\/g, '/').replace(/^[A-Za-z]:/, '');
      if (s === '/worktree') return true;
      return false;
    });
    vi.mocked(readdirSync).mockReturnValue([]);

    const result = await handleVerifyWorktreeBaseline({ worktreePath: '/worktree' }, stateDir, connector);

    expect(result.success).toBe(false);
    expect(result.error).toMatchObject({ code: 'UNKNOWN_PROJECT_TYPE' });
    expect(admitLifecycleLegs).not.toHaveBeenCalled();
  });

  it('TestsFail_ReturnsPassedFalse', async () => {
    vi.mocked(existsSync).mockImplementation((p) => {
      const s = String(p).replace(/\\/g, '/').replace(/^[A-Za-z]:/, '');
      if (s === '/worktree') return true;
      if (s === '/worktree/package.json') return true;
      return false;
    });
    vi.mocked(readdirSync).mockReturnValue([]);
    vi.mocked(readFileSync).mockImplementation((p) => {
      if (String(p).endsWith('package.json')) return NPM_PACKAGE_JSON;
      throw new Error(`unexpected readFileSync: ${String(p)}`);
    });
    signedLeg(1, '3 tests failed', 'FAIL src/foo.test.ts');

    const result = await handleVerifyWorktreeBaseline({ worktreePath: '/worktree' }, stateDir, connector);

    expect(result.success).toBe(true);
    const data = result.data as { passed: boolean; projectType: string; report: string };
    expect(data.passed).toBe(false);
    expect(data.projectType).toBe('Node.js');
    expect(data.report).toContain('FAIL');
    expect(data.report).toContain('exit code 1');
  });

  it('PathDoesNotExist_ReturnsError', async () => {
    vi.mocked(existsSync).mockReturnValue(false);

    const result = await handleVerifyWorktreeBaseline({ worktreePath: '/nonexistent' }, stateDir);

    expect(result.success).toBe(false);
    expect(result.error).toMatchObject({ code: 'INVALID_INPUT' });
    expect(result.error?.message).toContain('/nonexistent');
  });

  /** A provisioned call keeps NOT_GIT_WORKTREE through the process-free climb, and starts no process. */
  it('NotAGitWorktree_ReturnsError', async () => {
    vi.mocked(existsSync).mockImplementation((p) => {
      if (String(p) === '/not-git') return true;
      return false;
    });
    vi.mocked(gitCommonDirOf).mockImplementationOnce(() => { throw new Error('No .git entry above the directory'); });

    const result = await handleVerifyWorktreeBaseline({ worktreePath: '/not-git' }, stateDir, connector);

    expect(result.success).toBe(false);
    expect(result.error).toMatchObject({ code: 'NOT_GIT_WORKTREE' });
    expect(gitCommonDirOf).toHaveBeenCalledWith('/not-git');
    expect(execFileSync).not.toHaveBeenCalled();
  });

  /** A Python project with only `pyproject.toml` resolves to pytest, which runs with no arguments. */
  it('detectProjectType_PythonProject_ReturnsPytestNow', async () => {
    vi.mocked(existsSync).mockImplementation((p) => {
      const s = String(p).replace(/\\/g, '/').replace(/^[A-Za-z]:/, '');
      if (s === '/worktree') return true;
      if (s === '/worktree/pyproject.toml') return true;
      return false;
    });
    vi.mocked(readdirSync).mockReturnValue([]);
    signedLeg(0, '=== 5 passed in 0.42s ===\n');

    const result = await handleVerifyWorktreeBaseline({ worktreePath: '/worktree' }, stateDir, connector);

    expect(result.success).toBe(true);
    const data = result.data as { passed: boolean; projectType: string; testCommand: string };
    expect(data.passed).toBe(true);
    expect(data.projectType).toBe('Python');
    expect(data.testCommand).toBe('pytest');
    expect(admittedArgv()).toEqual(['pytest']);
  });

  /** Bun does not require `scripts.test`, but the resolver still reads package.json. */
  it('detectProjectType_BunProject_ReturnsBunTest', async () => {
    vi.mocked(existsSync).mockImplementation((p) => {
      const s = String(p).replace(/\\/g, '/').replace(/^[A-Za-z]:/, '');
      if (s === '/worktree') return true;
      if (s === '/worktree/package.json') return true;
      if (s === '/worktree/bun.lockb') return true;
      return false;
    });
    vi.mocked(readdirSync).mockReturnValue([]);
    vi.mocked(readFileSync).mockImplementation((p) => {
      if (String(p).endsWith('package.json')) return JSON.stringify({});
      throw new Error(`unexpected readFileSync: ${String(p)}`);
    });
    signedLeg(0, 'bun test passed\n');

    const result = await handleVerifyWorktreeBaseline({ worktreePath: '/worktree' }, stateDir, connector);

    expect(result.success).toBe(true);
    const data = result.data as { passed: boolean; projectType: string; testCommand: string };
    expect(data.projectType).toBe('Node.js (bun)');
    expect(data.testCommand).toBe('bun test');
    expect(admittedArgv()).toEqual(['bun', 'test']);
  });

  /**
   * With no detection markers, the handler must still use the test command from `.exarchos.yml`.
   * `pytest` is in the built-in label set, so the project type is `Python`.
   * On Windows, `resolve()` adds a drive and backslashes to the config path, so the mock strips both.
   */
  it('ConfigSourcedTestCommand_KnownRunner_HonoredByHandler', async () => {
    vi.mocked(existsSync).mockImplementation((p) => {
      const s = String(p).replace(/\\/g, '/').replace(/^[A-Za-z]:/, '');
      if (s === '/worktree') return true;
      if (s === '/worktree/.exarchos.yml') return true;
      return false;
    });
    vi.mocked(readdirSync).mockReturnValue([]);
    vi.mocked(readFileSync).mockImplementation((p) => {
      if (String(p).endsWith('.exarchos.yml')) {
        return 'test: pytest\n';
      }
      throw new Error(`unexpected readFileSync: ${String(p)}`);
    });
    signedLeg(0, '=== 1 passed ===\n');

    const result = await handleVerifyWorktreeBaseline({ worktreePath: '/worktree' }, stateDir, connector);

    expect(result.success).toBe(true);
    const data = result.data as { passed: boolean; projectType: string; testCommand: string };
    expect(data.passed).toBe(true);
    expect(data.projectType).toBe('Python');
    expect(data.testCommand).toBe('pytest');
  });

  /** `make test` is not in the built-in label set, so the project type is a label that names the config source. */
  it('ConfigSourcedTestCommand_UnknownRunner_GetsConfiguredLabel', async () => {
    vi.mocked(existsSync).mockImplementation((p) => {
      const s = String(p).replace(/\\/g, '/').replace(/^[A-Za-z]:/, '');
      if (s === '/worktree') return true;
      if (s === '/worktree/.exarchos.yml') return true;
      return false;
    });
    vi.mocked(readdirSync).mockReturnValue([]);
    vi.mocked(readFileSync).mockImplementation((p) => {
      if (String(p).endsWith('.exarchos.yml')) {
        return 'test: make test\n';
      }
      throw new Error(`unexpected readFileSync: ${String(p)}`);
    });
    signedLeg(0, 'Tests OK\n');

    const result = await handleVerifyWorktreeBaseline({ worktreePath: '/worktree' }, stateDir, connector);

    expect(result.success).toBe(true);
    const data = result.data as { passed: boolean; projectType: string; testCommand: string };
    expect(data.passed).toBe(true);
    expect(data.projectType).toBe('Configured (.exarchos.yml)');
    expect(data.testCommand).toBe('make test');
    expect(admittedArgv()).toEqual(['make', 'test']);
  });

  /**
   * A leak-detection request on a machine with no verifier refuses after the path check and before the Git climb.
   * No route inspects the tree, so no Git process starts.
   */
  it('VerifyWorktreeBaseline_LeakDetectionWithNoConnector_RefusesBeforeAnyGitRead', async () => {
    vi.mocked(existsSync).mockImplementation((p) => String(p).replace(/^[A-Za-z]:/, '') === '/worktree');

    const result = await handleVerifyWorktreeBaseline(
      { worktreePath: '/worktree', agentBranch: 'feature/agent-task-123' },
      stateDir,
    );

    expect(result).toMatchObject({ success: false, error: { code: 'VERIFIER_NOT_PROVISIONED' } });
    expect(result.error?.message).toContain('Provision the verifier');
    expect(gitCommonDirOf).not.toHaveBeenCalled();
    expect(admitLifecycleLegs).not.toHaveBeenCalled();
    expect(execFileSync).not.toHaveBeenCalled();
  });

  /** A provisioned leak-detection request refuses, because leak detection needs clean-tree evidence of the harness. No tree inspection and no test run start. */
  it('VerifyWorktreeBaseline_LeakDetectionWithConnector_RefusesWithNoTreeInspection', async () => {
    vi.mocked(existsSync).mockImplementation((p) => {
      const s = String(p).replace(/\\/g, '/').replace(/^[A-Za-z]:/, '');
      return s === '/worktree' || s === '/worktree/package.json';
    });
    vi.mocked(readdirSync).mockReturnValue([]);
    vi.mocked(readFileSync).mockImplementation((p) => {
      if (String(p).endsWith('package.json')) return NPM_PACKAGE_JSON;
      throw new Error(`unexpected readFileSync: ${String(p)}`);
    });

    const result = await handleVerifyWorktreeBaseline(
      { worktreePath: '/worktree', agentBranch: 'feature/agent-task-123' },
      stateDir,
      connector,
    );

    expect(result).toMatchObject({ success: false, error: { code: 'HOSTED_VERIFICATION_REFUSED' } });
    expect(result.error?.message).toContain('leak detection');
    expect(admitLifecycleLegs).not.toHaveBeenCalled();
    expect(execFileSync).not.toHaveBeenCalled();
  });

  /** With no connector, a path outside any checkout refuses with VERIFIER_NOT_PROVISIONED. The refusal comes before the NOT_GIT_WORKTREE check. */
  it('VerifyWorktreeBaseline_NotAGitWorktreeWithNoConnector_RefusesBeforeTheClimb', async () => {
    vi.mocked(existsSync).mockImplementation((p) => String(p) === '/not-git');
    vi.mocked(gitCommonDirOf).mockImplementationOnce(() => { throw new Error('No .git entry above the directory'); });

    const result = await handleVerifyWorktreeBaseline({ worktreePath: '/not-git' }, stateDir);

    expect(result).toMatchObject({ success: false, error: { code: 'VERIFIER_NOT_PROVISIONED' } });
    expect(gitCommonDirOf).not.toHaveBeenCalled();
    expect(execFileSync).not.toHaveBeenCalled();
  });

  /** The pnpm path requires a `test` script in package.json. */
  it('detectProjectType_PnpmProject_ReturnsPnpmTest', async () => {
    vi.mocked(existsSync).mockImplementation((p) => {
      const s = String(p).replace(/\\/g, '/').replace(/^[A-Za-z]:/, '');
      if (s === '/worktree') return true;
      if (s === '/worktree/package.json') return true;
      if (s === '/worktree/pnpm-lock.yaml') return true;
      return false;
    });
    vi.mocked(readdirSync).mockReturnValue([]);
    vi.mocked(readFileSync).mockImplementation((p) => {
      if (String(p).endsWith('package.json'))
        return JSON.stringify({ scripts: { test: 'vitest run' } });
      throw new Error(`unexpected readFileSync: ${String(p)}`);
    });
    signedLeg(0, 'pnpm tests passed\n');

    const result = await handleVerifyWorktreeBaseline({ worktreePath: '/worktree' }, stateDir, connector);

    expect(result.success).toBe(true);
    const data = result.data as { passed: boolean; projectType: string; testCommand: string };
    expect(data.projectType).toBe('Node.js (pnpm)');
    expect(data.testCommand).toBe('pnpm test');
    expect(admittedArgv()).toEqual(['pnpm', 'test']);
  });

  /**
   * A provisioned route refuses leak detection and an existing checkout that has no operator identity.
   * No local test command runs, and no exchange starts.
   */
  it('Provisioned_LeakDetectionAndUnidentifiedCheckout_RefuseWithoutLocalRun', async () => {
    const checkout = await realpath(tmpdir());
    vi.mocked(existsSync).mockImplementation((p) => String(p) === checkout || String(p) === `${checkout}/package.json`);
    vi.mocked(readdirSync).mockReturnValue([]);
    vi.mocked(readFileSync).mockImplementation((p) => {
      if (String(p).endsWith('package.json')) return NPM_PACKAGE_JSON;
      throw new Error(`unexpected readFileSync: ${String(p)}`);
    });
    const exchanges: string[] = [];

    const leaks = await handleVerifyWorktreeBaseline({ worktreePath: checkout, agentBranch: 'task/a' }, stateDir, unreachableConnector(exchanges));
    const unidentified = await handleVerifyWorktreeBaseline({ worktreePath: checkout }, stateDir, unreachableConnector(exchanges));

    expect(leaks).toMatchObject({ success: false, error: { code: 'HOSTED_VERIFICATION_REFUSED' } });
    expect(leaks.error?.message).toContain('leak detection');
    expect(unidentified).toMatchObject({ success: false, error: { code: 'HOSTED_VERIFICATION_REFUSED' } });
    expect(unidentified.error?.message).toContain('no approved identity for this checkout');
    expect(vi.mocked(admitLifecycleLegs).mock.calls).toHaveLength(1);
    expect(vi.mocked(admitLifecycleLegs).mock.calls.every(([input]) => input.checkout === checkout)).toBe(true);
    expect(execFileSync).not.toHaveBeenCalled();
    expect(exchanges).toEqual([]);
  });
});
