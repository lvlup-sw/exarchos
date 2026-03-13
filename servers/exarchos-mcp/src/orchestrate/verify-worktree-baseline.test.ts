import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('node:fs', () => ({
  existsSync: vi.fn(),
  readdirSync: vi.fn(),
}));

vi.mock('node:child_process', () => ({
  execFileSync: vi.fn(),
}));

import { existsSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { handleVerifyWorktreeBaseline } from './verify-worktree-baseline.js';

describe('handleVerifyWorktreeBaseline', () => {
  const stateDir = '/tmp/test-state';

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('NodeProject_TestsPass_ReturnsPassedTrue', async () => {
    vi.mocked(existsSync).mockImplementation((p) => {
      if (String(p) === '/worktree') return true;
      if (String(p) === '/worktree/package.json') return true;
      if (String(p) === '/worktree/Cargo.toml') return false;
      return false;
    });
    vi.mocked(readdirSync).mockReturnValue([]);
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
      if (String(p) === '/worktree') return true;
      if (String(p) === '/worktree/package.json') return false;
      if (String(p) === '/worktree/Cargo.toml') return false;
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
      if (String(p) === '/worktree') return true;
      if (String(p) === '/worktree/package.json') return false;
      if (String(p) === '/worktree/Cargo.toml') return true;
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
      if (String(p) === '/worktree') return true;
      if (String(p) === '/worktree/package.json') return false;
      if (String(p) === '/worktree/Cargo.toml') return false;
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
      if (String(p) === '/worktree') return true;
      if (String(p) === '/worktree/package.json') return true;
      if (String(p) === '/worktree/Cargo.toml') return false;
      return false;
    });
    vi.mocked(readdirSync).mockReturnValue([]);

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
});
