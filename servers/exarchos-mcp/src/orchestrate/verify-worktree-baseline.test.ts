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
import { handleVerifyWorktreeBaseline } from './verify-worktree-baseline.js';

// Helper: package.json contents declaring a `test:run` script (required by the
// resolver's npm code path).
const NPM_PACKAGE_JSON = JSON.stringify({ scripts: { 'test:run': 'vitest run' } });

describe('handleVerifyWorktreeBaseline', () => {
  const stateDir = '/tmp/test-state';

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('NodeProject_TestsPass_ReturnsPassedTrue', async () => {
    vi.mocked(existsSync).mockImplementation((p) => {
      const s = String(p);
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
      const s = String(p);
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
      const s = String(p);
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
      const s = String(p);
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
      const s = String(p);
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
      // Allow git rev-parse to succeed
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
    // git rev-parse --git-dir throws for non-git directories
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

  // ── T08 additions: behavior changes from resolver migration ─────────────

  it('detectProjectType_PythonProject_ReturnsPytestNow', async () => {
    // Intentional gap closure: prior to T08 a Python project (pyproject.toml
    // only) returned UNKNOWN_PROJECT_TYPE. The unified resolver now detects
    // it and selects pytest.
    vi.mocked(existsSync).mockImplementation((p) => {
      const s = String(p);
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
    // Verify pytest was invoked with no args (cmd='pytest', args=[]).
    const calls = vi.mocked(execFileSync).mock.calls;
    const pytestCall = calls.find((c) => String(c[0]) === 'pytest');
    expect(pytestCall).toBeDefined();
    expect(pytestCall?.[1]).toEqual([]);
  });

  it('detectProjectType_BunProject_ReturnsBunTest', async () => {
    vi.mocked(existsSync).mockImplementation((p) => {
      const s = String(p);
      if (s === '/worktree') return true;
      if (s === '/worktree/package.json') return true;
      if (s === '/worktree/bun.lockb') return true;
      return false;
    });
    vi.mocked(readdirSync).mockReturnValue([]);
    // bun does not require scripts.test, but the resolver still reads package.json.
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
    const bunCall = calls.find((c) => String(c[0]) === 'bun');
    expect(bunCall?.[1]).toEqual(['test']);
  });

  it('detectProjectType_PnpmProject_ReturnsPnpmTest', async () => {
    vi.mocked(existsSync).mockImplementation((p) => {
      const s = String(p);
      if (s === '/worktree') return true;
      if (s === '/worktree/package.json') return true;
      if (s === '/worktree/pnpm-lock.yaml') return true;
      return false;
    });
    vi.mocked(readdirSync).mockReturnValue([]);
    // pnpm path requires a `test` script in package.json.
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
    const pnpmCall = calls.find((c) => String(c[0]) === 'pnpm');
    expect(pnpmCall?.[1]).toEqual(['test']);
  });
});
