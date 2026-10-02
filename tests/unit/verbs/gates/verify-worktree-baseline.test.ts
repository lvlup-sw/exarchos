import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('node:fs', () => ({
  existsSync: vi.fn(),
  readdirSync: vi.fn(),
  readFileSync: vi.fn(),
}));

vi.mock('node:child_process', () => ({
  execFileSync: vi.fn(),
}));

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { handleVerifyWorktreeBaseline } from '../../../../src/verbs/gates/verify-worktree-baseline.js';

/** A package.json with the `test:run` script that the npm path of the resolver requires. */
const NPM_PACKAGE_JSON = JSON.stringify({ scripts: { 'test:run': 'vitest run' } });

describe('handleVerifyWorktreeBaseline', () => {
  const stateDir = '/tmp/test-state';

  afterEach(() => {
    vi.restoreAllMocks();
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
    vi.mocked(execFileSync).mockReturnValue('Tests passed\n');

    const result = await handleVerifyWorktreeBaseline({ worktreePath: '/worktree' }, stateDir);

    expect(result.success).toBe(true);
    const data = result.data as { passed: boolean; projectType: string; testCommand: string; report: string };
    expect(data.passed).toBe(true);
    expect(data.projectType).toBe('Node.js');
    expect(data.testCommand).toBe('npm run test:run');
    expect(data.report).toContain('PASS');
  });

  it('DotNetProject_TestsPass_ReturnsPassedTrue', async () => {
    vi.mocked(existsSync).mockImplementation((p) => {
      const s = String(p).replace(/\\/g, '/').replace(/^[A-Za-z]:/, '');
      if (s === '/worktree') return true;
      return false;
    });
    vi.mocked(readdirSync).mockReturnValue(['MyApp.csproj' as unknown as ReturnType<typeof readdirSync>[number]]);
    vi.mocked(execFileSync).mockReturnValue('All tests passed\n');

    const result = await handleVerifyWorktreeBaseline({ worktreePath: '/worktree' }, stateDir);

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
    vi.mocked(execFileSync).mockReturnValue('test result: ok\n');

    const result = await handleVerifyWorktreeBaseline({ worktreePath: '/worktree' }, stateDir);

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
    vi.mocked(execFileSync).mockReturnValue('');

    const result = await handleVerifyWorktreeBaseline({ worktreePath: '/worktree' }, stateDir);

    expect(result.success).toBe(false);
    expect(result.error).toMatchObject({ code: 'UNKNOWN_PROJECT_TYPE' });
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

    const error = new Error('Process exited with code 1') as Error & {
      status: number;
      stdout: string;
      stderr: string;
    };
    error.status = 1;
    error.stdout = '3 tests failed';
    error.stderr = 'FAIL src/foo.test.ts';
    vi.mocked(execFileSync).mockImplementation((cmd, args) => {
      if (String(cmd) === 'git') return '.git\n';
      throw error;
    });

    const result = await handleVerifyWorktreeBaseline({ worktreePath: '/worktree' }, stateDir);

    expect(result.success).toBe(true);
    const data = result.data as { passed: boolean; projectType: string; report: string };
    expect(data.passed).toBe(false);
    expect(data.projectType).toBe('Node.js');
    expect(data.report).toContain('FAIL');
  });

  it('PathDoesNotExist_ReturnsError', async () => {
    vi.mocked(existsSync).mockReturnValue(false);

    const result = await handleVerifyWorktreeBaseline({ worktreePath: '/nonexistent' }, stateDir);

    expect(result.success).toBe(false);
    expect(result.error).toMatchObject({ code: 'INVALID_INPUT' });
    expect(result.error?.message).toContain('/nonexistent');
  });

  it('NotAGitWorktree_ReturnsError', async () => {
    vi.mocked(existsSync).mockImplementation((p) => {
      if (String(p) === '/not-git') return true;
      return false;
    });
    vi.mocked(execFileSync).mockImplementation((cmd, args) => {
      if (String(cmd) === 'git' && Array.isArray(args) && args.includes('--git-dir')) {
        throw new Error('fatal: not a git repository');
      }
      return '';
    });

    const result = await handleVerifyWorktreeBaseline({ worktreePath: '/not-git' }, stateDir);

    expect(result.success).toBe(false);
    expect(result.error).toMatchObject({ code: 'NOT_GIT_WORKTREE' });
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
    vi.mocked(execFileSync).mockReturnValue('=== 5 passed in 0.42s ===\n');

    const result = await handleVerifyWorktreeBaseline({ worktreePath: '/worktree' }, stateDir);

    expect(result.success).toBe(true);
    const data = result.data as { passed: boolean; projectType: string; testCommand: string };
    expect(data.passed).toBe(true);
    expect(data.projectType).toBe('Python');
    expect(data.testCommand).toBe('pytest');
    const calls = vi.mocked(execFileSync).mock.calls;
    const pytestCall = calls.find((c) => String(c[0]).replace(/\.cmd$/, '') === 'pytest');
    expect(pytestCall).toBeDefined();
    expect(pytestCall?.[1]).toEqual([]);
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
    vi.mocked(execFileSync).mockReturnValue('bun test passed\n');

    const result = await handleVerifyWorktreeBaseline({ worktreePath: '/worktree' }, stateDir);

    expect(result.success).toBe(true);
    const data = result.data as { passed: boolean; projectType: string; testCommand: string };
    expect(data.projectType).toBe('Node.js (bun)');
    expect(data.testCommand).toBe('bun test');
    const calls = vi.mocked(execFileSync).mock.calls;
    const bunCall = calls.find((c) => String(c[0]).replace(/\.cmd$/, '') === 'bun');
    expect(bunCall?.[1]).toEqual(['test']);
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
    vi.mocked(execFileSync).mockImplementation((cmd) => {
      if (String(cmd) === 'git') return '.git\n';
      return '=== 1 passed ===\n' as unknown as Buffer;
    });

    const result = await handleVerifyWorktreeBaseline({ worktreePath: '/worktree' }, stateDir);

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
    vi.mocked(execFileSync).mockImplementation((cmd) => {
      if (String(cmd) === 'git') return '.git\n';
      return 'Tests OK\n' as unknown as Buffer;
    });

    const result = await handleVerifyWorktreeBaseline({ worktreePath: '/worktree' }, stateDir);

    expect(result.success).toBe(true);
    const data = result.data as { passed: boolean; projectType: string; testCommand: string };
    expect(data.passed).toBe(true);
    expect(data.projectType).toBe('Configured (.exarchos.yml)');
    expect(data.testCommand).toBe('make test');
  });

  /**
   * A dirty path whose working-tree blob matches the committed blob on the agent branch tip is a recoverable `leaked-committed` leak.
   * It is not unrelated dirt. The remediation is `git checkout --` with the path in single quotes, which neutralizes shell metacharacters.
   */
  it('VerifyWorktreeBaseline_LeakedEditByteIdenticalToCommittedAgentChange_IsDetected', async () => {
    const AGENT_BRANCH = 'feature/agent-task-123';
    const LEAKED_PATH = 'src/leaked.ts';
    const SHARED_BLOB = 'export const leaked = true;\n';

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

    vi.mocked(execFileSync).mockImplementation((cmd, args) => {
      const a = (args as string[]) ?? [];
      if (String(cmd) === 'git') {
        if (a.includes('--git-dir')) return '.git\n' as unknown as Buffer;
        if (a.includes('status') && a.includes('--porcelain')) {
          return ` M ${LEAKED_PATH}\n` as unknown as Buffer;
        }
        if (a.includes('hash-object')) {
          return 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n' as unknown as Buffer;
        }
        if (a.includes('rev-parse') && a.some((x) => x.startsWith(AGENT_BRANCH))) {
          return 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n' as unknown as Buffer;
        }
        return '' as unknown as Buffer;
      }
      return 'Tests passed\n' as unknown as Buffer;
    });

    const result = await handleVerifyWorktreeBaseline(
      { worktreePath: '/worktree', agentBranch: AGENT_BRANCH },
      stateDir,
    );

    expect(result.success).toBe(true);
    const data = result.data as {
      leakDetection?: {
        dirty: boolean;
        paths: { path: string; classification: string; remediation?: string }[];
      };
    };
    expect(data.leakDetection).toBeDefined();
    expect(data.leakDetection?.dirty).toBe(true);
    const entry = data.leakDetection?.paths.find((p) => p.path === LEAKED_PATH);
    expect(entry).toBeDefined();
    expect(entry?.classification).toBe('leaked-committed');
    expect(entry?.remediation).toContain(`git checkout -- '${LEAKED_PATH}'`);
  });

  /**
   * Porcelain shows a rename as `R  old -> new`, and the file on disk is at `new`.
   * The parser must pass `new` to `git hash-object`, not the raw arrow string. In the mock, only the new path matches the agent blob.
   */
  it('VerifyWorktreeBaseline_RenamedLeak_ParsesNewPathNotRawArrow', async () => {
    const AGENT_BRANCH = 'feature/agent-task-123';
    const OLD_PATH = 'src/old-name.ts';
    const NEW_PATH = 'src/renamed-leak.ts';

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

    vi.mocked(execFileSync).mockImplementation((cmd, args) => {
      const a = (args as string[]) ?? [];
      if (String(cmd) === 'git') {
        if (a.includes('--git-dir')) return '.git\n' as unknown as Buffer;
        if (a.includes('status') && a.includes('--porcelain')) {
          return `R  ${OLD_PATH} -> ${NEW_PATH}\n` as unknown as Buffer;
        }
        if (a.includes('hash-object') && a.includes(NEW_PATH)) {
          return 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\n' as unknown as Buffer;
        }
        if (a.includes('rev-parse') && a.some((x) => x === `${AGENT_BRANCH}:${NEW_PATH}`)) {
          return 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\n' as unknown as Buffer;
        }
        return '' as unknown as Buffer;
      }
      return 'Tests passed\n' as unknown as Buffer;
    });

    const result = await handleVerifyWorktreeBaseline(
      { worktreePath: '/worktree', agentBranch: AGENT_BRANCH },
      stateDir,
    );

    expect(result.success).toBe(true);
    const data = result.data as {
      leakDetection?: { paths: { path: string; classification: string }[] };
    };
    const paths = data.leakDetection?.paths ?? [];
    expect(paths.some((p) => p.path.includes(' -> '))).toBe(false);
    const entry = paths.find((p) => p.path === NEW_PATH);
    expect(entry).toBeDefined();
    expect(entry?.classification).toBe('leaked-committed');
  });

  /** The agent tip has a different blob, so the path is a divergent local change and classifies as `dirty`. */
  it('VerifyWorktreeBaseline_UnrelatedDirtyTree_IsGenuineBlocker', async () => {
    const AGENT_BRANCH = 'feature/agent-task-123';
    const DIRTY_PATH = 'src/local-wip.ts';

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

    vi.mocked(execFileSync).mockImplementation((cmd, args) => {
      const a = (args as string[]) ?? [];
      if (String(cmd) === 'git') {
        if (a.includes('--git-dir')) return '.git\n' as unknown as Buffer;
        if (a.includes('status') && a.includes('--porcelain')) {
          return ` M ${DIRTY_PATH}\n` as unknown as Buffer;
        }
        if (a.includes('hash-object')) {
          return 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\n' as unknown as Buffer;
        }
        if (a.includes('rev-parse') && a.some((x) => x.startsWith(AGENT_BRANCH))) {
          return 'cccccccccccccccccccccccccccccccccccccccc\n' as unknown as Buffer;
        }
        return '' as unknown as Buffer;
      }
      return 'Tests passed\n' as unknown as Buffer;
    });

    const result = await handleVerifyWorktreeBaseline(
      { worktreePath: '/worktree', agentBranch: AGENT_BRANCH },
      stateDir,
    );

    expect(result.success).toBe(true);
    const data = result.data as {
      leakDetection?: {
        dirty: boolean;
        paths: { path: string; classification: string }[];
      };
    };
    expect(data.leakDetection?.dirty).toBe(true);
    const entry = data.leakDetection?.paths.find((p) => p.path === DIRTY_PATH);
    expect(entry?.classification).toBe('dirty');
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
    vi.mocked(execFileSync).mockReturnValue('pnpm tests passed\n');

    const result = await handleVerifyWorktreeBaseline({ worktreePath: '/worktree' }, stateDir);

    expect(result.success).toBe(true);
    const data = result.data as { passed: boolean; projectType: string; testCommand: string };
    expect(data.projectType).toBe('Node.js (pnpm)');
    expect(data.testCommand).toBe('pnpm test');
    const calls = vi.mocked(execFileSync).mock.calls;
    const pnpmCall = calls.find((c) => String(c[0]).replace(/\.cmd$/, '') === 'pnpm');
    expect(pnpmCall?.[1]).toEqual(['test']);
  });
});
