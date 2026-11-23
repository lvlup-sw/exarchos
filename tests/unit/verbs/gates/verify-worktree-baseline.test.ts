import { describe, it, expect, vi, afterEach } from 'vitest';

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

vi.mock('../../../../src/utils/git-tree.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../src/utils/git-tree.js')>()),
  processObservationalGitPath: vi.fn(() => '/usr/bin/git'),
}));

vi.mock('../../../../src/verbs/verification/lifecycle-check.js', () => ({
  admitLifecycleLegs: vi.fn(),
}));

vi.mock('../../../../src/verbs/gates/gate-utils.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../src/verbs/gates/gate-utils.js')>()),
  observeCurrentCheckout: vi.fn(),
}));

vi.mock('../../../../src/verbs/gates/gate-runner.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../src/verbs/gates/gate-runner.js')>()),
  closedListingChanges: vi.fn(),
  closedListingBlobs: vi.fn(),
}));

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { handleVerifyWorktreeBaseline } from '../../../../src/verbs/gates/verify-worktree-baseline.js';
import { admitLifecycleLegs } from '../../../../src/verbs/verification/lifecycle-check.js';
import { closedListingBlobs, closedListingChanges } from '../../../../src/verbs/gates/gate-runner.js';
import { observeCurrentCheckout, type CurrentCheckoutRead } from '../../../../src/verbs/gates/gate-utils.js';
import { gitCommonDirOf } from '../../../../src/utils/paths.js';
import type { EventStore } from '../../../../src/events/store.js';

/** A package.json with the `test:run` script that the npm path of the resolver requires. */
const NPM_PACKAGE_JSON = JSON.stringify({ scripts: { 'test:run': 'vitest run' } });

/** The event store of each call. The lifecycle check is a mock, so no case reads it. */
const store = { query: vi.fn(), append: vi.fn() } as unknown as EventStore;

/** Stub the next baseline leg of the local executor. */
function observedLeg(exitCode: number, stdout = '', stderr = ''): void {
  vi.mocked(admitLifecycleLegs).mockResolvedValueOnce([
    { name: 'test', kind: 'command', run: { argv: ['test'], end: 'exited', exitCode, stdout, stderr } },
  ]);
}

/** The argument vector of the one admitted baseline leg. */
function admittedArgv(): readonly string[] | undefined {
  return vi.mocked(admitLifecycleLegs).mock.calls[0]?.[0].legs[0]?.argv;
}

/** The head of the observed worktree and the tip of the agent branch. */
const HEAD = 'a'.repeat(40);
const AGENT_TIP = 'b'.repeat(40);

/** An observed worktree whose agent branch resolves to {@link AGENT_TIP}. The listing helpers are mocks, so the reads stay unused. */
function observedWorktree(): CurrentCheckoutRead {
  const read: CurrentCheckoutRead = {
    kind: 'observed',
    checkout: { checkout: '/worktree', repository: '/worktree/.git', gitDir: '/worktree/.git', branch: 'refs/heads/main', head: HEAD },
    observer: {
      reads: {},
      base: async () => ({ kind: 'observed', value: AGENT_TIP }),
    } as unknown as Extract<CurrentCheckoutRead, { kind: 'observed' }>['observer'],
  };
  return read;
}

/** A Node worktree whose test command resolves to `npm run test:run`. */
function nodeWorktree(): void {
  vi.mocked(existsSync).mockImplementation((p) => {
    const s = String(p).replace(/\\/g, '/').replace(/^[A-Za-z]:/, '');
    return s === '/worktree' || s === '/worktree/package.json';
  });
  vi.mocked(readdirSync).mockReturnValue([]);
  vi.mocked(readFileSync).mockImplementation((p) => {
    if (String(p).endsWith('package.json')) return NPM_PACKAGE_JSON;
    throw new Error(`unexpected readFileSync: ${String(p)}`);
  });
}

describe('handleVerifyWorktreeBaseline', () => {
  const stateDir = '/tmp/test-state';

  afterEach(() => {
    vi.restoreAllMocks();
    vi.mocked(admitLifecycleLegs).mockReset();
    vi.mocked(gitCommonDirOf).mockClear();
    vi.mocked(closedListingChanges).mockReset();
    vi.mocked(closedListingBlobs).mockReset();
    vi.mocked(observeCurrentCheckout).mockReset();
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
    observedLeg(0, 'Tests passed\n');

    const result = await handleVerifyWorktreeBaseline({ worktreePath: '/worktree' }, stateDir, store);

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
    observedLeg(0, 'All tests passed\n');

    const result = await handleVerifyWorktreeBaseline({ worktreePath: '/worktree' }, stateDir, store);

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
    observedLeg(0, 'test result: ok\n');

    const result = await handleVerifyWorktreeBaseline({ worktreePath: '/worktree' }, stateDir, store);

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

    const result = await handleVerifyWorktreeBaseline({ worktreePath: '/worktree' }, stateDir, store);

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
    observedLeg(1, '3 tests failed', 'FAIL src/foo.test.ts');

    const result = await handleVerifyWorktreeBaseline({ worktreePath: '/worktree' }, stateDir, store);

    expect(result.success).toBe(true);
    const data = result.data as { passed: boolean; projectType: string; report: string };
    expect(data.passed).toBe(false);
    expect(data.projectType).toBe('Node.js');
    expect(data.report).toContain('FAIL');
    expect(data.report).toContain('exit code 1');
  });

  it('PathDoesNotExist_ReturnsError', async () => {
    vi.mocked(existsSync).mockReturnValue(false);

    const result = await handleVerifyWorktreeBaseline({ worktreePath: '/nonexistent' }, stateDir, store);

    expect(result.success).toBe(false);
    expect(result.error).toMatchObject({ code: 'INVALID_INPUT' });
    expect(result.error?.message).toContain('/nonexistent');
  });

  /** A call keeps NOT_GIT_WORKTREE through the process-free climb, and starts no process. */
  it('NotAGitWorktree_ReturnsError', async () => {
    vi.mocked(existsSync).mockImplementation((p) => {
      if (String(p) === '/not-git') return true;
      return false;
    });
    vi.mocked(gitCommonDirOf).mockImplementationOnce(() => { throw new Error('No .git entry above the directory'); });

    const result = await handleVerifyWorktreeBaseline({ worktreePath: '/not-git' }, stateDir, store);

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
    observedLeg(0, '=== 5 passed in 0.42s ===\n');

    const result = await handleVerifyWorktreeBaseline({ worktreePath: '/worktree' }, stateDir, store);

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
    observedLeg(0, 'bun test passed\n');

    const result = await handleVerifyWorktreeBaseline({ worktreePath: '/worktree' }, stateDir, store);

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
    observedLeg(0, '=== 1 passed ===\n');

    const result = await handleVerifyWorktreeBaseline({ worktreePath: '/worktree' }, stateDir, store);

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
    observedLeg(0, 'Tests OK\n');

    const result = await handleVerifyWorktreeBaseline({ worktreePath: '/worktree' }, stateDir, store);

    expect(result.success).toBe(true);
    const data = result.data as { passed: boolean; projectType: string; testCommand: string };
    expect(data.passed).toBe(true);
    expect(data.projectType).toBe('Configured (.exarchos.yml)');
    expect(data.testCommand).toBe('make test');
    expect(admittedArgv()).toEqual(['make', 'test']);
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
    observedLeg(0, 'pnpm tests passed\n');

    const result = await handleVerifyWorktreeBaseline({ worktreePath: '/worktree' }, stateDir, store);

    expect(result.success).toBe(true);
    const data = result.data as { passed: boolean; projectType: string; testCommand: string };
    expect(data.projectType).toBe('Node.js (pnpm)');
    expect(data.testCommand).toBe('pnpm test');
    expect(admittedArgv()).toEqual(['pnpm', 'test']);
  });

  /**
   * A dirty path whose working blob matches the blob on the agent branch tip is a recoverable `leaked-committed` leak with a quoted remediation.
   * An untracked path and a tracked path with other bytes are dirt. The executor refuses the dirty tree, and the refusal carries the leak detection.
   */
  it('VerifyWorktreeBaseline_LeakedEditByteIdenticalToCommittedAgentChange_IsDetected', async () => {
    nodeWorktree();
    vi.mocked(observeCurrentCheckout).mockResolvedValue(observedWorktree());
    vi.mocked(closedListingChanges).mockResolvedValue([
      { path: "src/it's leaked.ts", tracked: true, workingBlob: 'c'.repeat(40) },
      { path: 'src/edited.ts', tracked: true, workingBlob: 'd'.repeat(40) },
      { path: 'src/deleted.ts', tracked: true },
      { path: 'scratch.txt', tracked: false },
    ]);
    vi.mocked(closedListingBlobs).mockResolvedValue(new Map([["src/it's leaked.ts", 'c'.repeat(40)], ['src/edited.ts', 'e'.repeat(40)], ['scratch.txt', 'f'.repeat(40)]]));
    vi.mocked(admitLifecycleLegs).mockResolvedValueOnce({ success: false, error: { code: 'LOCAL_CHECK_REFUSED', message: 'The working directory has uncommitted changes.' } });

    const result = await handleVerifyWorktreeBaseline({ worktreePath: '/worktree', agentBranch: 'feature/agent-task-123' }, stateDir, store);

    expect(result).toMatchObject({ success: false, error: { code: 'LOCAL_CHECK_REFUSED' } });
    expect(result.data).toEqual({ leakDetection: { dirty: true, paths: [
      { path: "src/it's leaked.ts", classification: 'leaked-committed', remediation: "git checkout -- 'src/it'\\''s leaked.ts'" },
      { path: 'src/edited.ts', classification: 'dirty' },
      { path: 'src/deleted.ts', classification: 'dirty' },
      { path: 'scratch.txt', classification: 'dirty' },
    ] } });
    expect(vi.mocked(closedListingBlobs).mock.calls[0]?.[3]).toBe(AGENT_TIP);
    expect(execFileSync).not.toHaveBeenCalled();
  });

  /** A clean worktree with a leak request reports no leak, and the baseline runs in the local executor. */
  it('VerifyWorktreeBaseline_CleanWorktreeWithLeakRequest_ReportsNoLeakAndRunsTheBaseline', async () => {
    nodeWorktree();
    vi.mocked(observeCurrentCheckout).mockResolvedValue(observedWorktree());
    vi.mocked(closedListingChanges).mockResolvedValue([]);
    observedLeg(0, 'Tests passed\n');

    const result = await handleVerifyWorktreeBaseline({ worktreePath: '/worktree', agentBranch: 'task/a' }, stateDir, store);

    expect(result).toMatchObject({ success: true, data: { passed: true, leakDetection: { dirty: false, paths: [] } } });
    expect(closedListingBlobs).not.toHaveBeenCalled();
    expect(vi.mocked(admitLifecycleLegs).mock.calls[0]?.[0]).toMatchObject({ eventStore: store, checkout: '/worktree' });
    expect(vi.mocked(admitLifecycleLegs).mock.calls[0]?.[0].streamId).toBeUndefined();
  });

  /** A tree that the closed listings cannot classify, or an agent branch that does not resolve, counts as dirty with a cause and no path. */
  it('VerifyWorktreeBaseline_UnreadableTreeOrBranch_CountsAsDirtyWithACause', async () => {
    nodeWorktree();
    vi.mocked(observeCurrentCheckout).mockResolvedValue(observedWorktree());
    vi.mocked(closedListingChanges).mockResolvedValueOnce(undefined);
    observedLeg(0);
    const unread = await handleVerifyWorktreeBaseline({ worktreePath: '/worktree', agentBranch: 'task/a' }, stateDir, store);
    expect(unread).toMatchObject({ success: true, data: { leakDetection: { dirty: true, paths: [], unread: expect.stringContaining('closed Git listings') } } });

    vi.mocked(closedListingChanges).mockResolvedValueOnce([{ path: 'a.ts', tracked: true, workingBlob: 'c'.repeat(40) }]);
    vi.mocked(closedListingBlobs).mockResolvedValueOnce(undefined);
    observedLeg(0);
    const branch = await handleVerifyWorktreeBaseline({ worktreePath: '/worktree', agentBranch: 'task/a' }, stateDir, store);
    expect(branch).toMatchObject({ success: true, data: { leakDetection: { dirty: true, paths: [], unread: expect.stringContaining('agent branch') } } });
  });

  /** A refusal of the local executor keeps its code and runs no local process. A leg with no verdict is pending and never reads as a failed baseline. */
  it('VerifyWorktreeBaseline_LocalRefusalAndPendingRun_KeepTheirCodes', async () => {
    nodeWorktree();
    vi.mocked(admitLifecycleLegs).mockResolvedValueOnce({ success: false, error: { code: 'LOCAL_CHECK_REFUSED', message: 'refused' } });
    const refused = await handleVerifyWorktreeBaseline({ worktreePath: '/worktree' }, stateDir, store);
    expect(refused).toEqual({ success: false, error: { code: 'LOCAL_CHECK_REFUSED', message: 'refused' } });

    vi.mocked(admitLifecycleLegs).mockResolvedValueOnce([
      { name: 'test', kind: 'command', run: { argv: ['npm'], end: 'exited', exitCode: null, stdout: '', stderr: '' } },
    ]);
    const pending = await handleVerifyWorktreeBaseline({ worktreePath: '/worktree' }, stateDir, store);
    expect(pending).toMatchObject({ success: false, error: { code: 'HOSTED_ADEQUACY_PENDING' } });
    expect(execFileSync).not.toHaveBeenCalled();
  });
});
