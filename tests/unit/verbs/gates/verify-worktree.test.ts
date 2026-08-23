// ─── Verify Worktree Action Tests ─────────────────────────────────────────────

import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ToolResult } from '../../../../src/format.js';
import type { GitExec } from '../../../../src/verbs/pure/execute-merge.js';
import { toPosix } from '../../../../src/utils/paths.js';

vi.mock('node:fs');

import { handleVerifyWorktree } from '../../../../src/verbs/gates/verify-worktree.js';

const STATE_DIR = '/tmp/test-verify-worktree';

// Mirror the handler's `toPosix(path.resolve(cwd))`: on Windows path.resolve
// prefixes the drive, so the raw `/foo/...` input the test passes is NOT what
// the handler ends up checking against the fs mock or returning (#1620).
const resolvedOf = (p: string): string => toPosix(path.resolve(p));

beforeEach(() => {
  vi.restoreAllMocks();
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

function mockDirExists(dirPath: string): void {
  const resolved = resolvedOf(dirPath);
  vi.mocked(fs.existsSync).mockImplementation((p) => p === resolved);
  vi.mocked(fs.statSync).mockImplementation((p) => {
    if (p === resolved) {
      return { isDirectory: () => true } as fs.Stats;
    }
    throw new Error(`ENOENT: no such file or directory, stat '${String(p)}'`);
  });
}

interface GitCall {
  readonly dir: string;
  readonly args: readonly string[];
}

/**
 * A `git rev-parse --is-inside-work-tree --git-dir --git-common-dir` stub.
 * `gitDir === commonDir` is the main checkout; differing paths are a linked
 * worktree — exactly the distinction the handler reads.
 */
function stubRevParse(
  lines: readonly string[],
  calls: GitCall[] = [],
  exitCode = 0,
): GitExec {
  return (dir, args) => {
    calls.push({ dir, args: [...args] });
    return { stdout: `${lines.join('\n')}\n`, exitCode };
  };
}

const linkedWorktree = (repo: string, name: string): readonly string[] => [
  'true',
  `${repo}/.git/worktrees/${name}`,
  `${repo}/.git`,
];

const mainCheckout = (): readonly string[] => ['true', '.git', '.git'];

function dataOf(result: ToolResult): { passed: boolean; path: string; message: string } {
  return result.data as { passed: boolean; path: string; message: string };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('handleVerifyWorktree', () => {
  it('ClaudeWorktreesLayout_IsRecognized', async () => {
    // The harness's own layout. The retired predicate tested for a
    // `.worktrees/` substring, which this path does not contain — the gate
    // aborted from inside a real worktree.
    const worktreePath = '/repo/.claude/worktrees/feature-x';
    expect(worktreePath.includes('.worktrees/')).toBe(false);
    mockDirExists(worktreePath);

    const result = await handleVerifyWorktree(
      { cwd: worktreePath },
      STATE_DIR,
      stubRevParse(linkedWorktree('/repo', 'feature-x')),
    );

    expect(result.success).toBe(true);
    const data = dataOf(result);
    expect(data.passed).toBe(true);
    expect(data.path).toBe(resolvedOf(worktreePath));
    expect(data.message).toContain('worktree');
  });

  it('MainCheckout_IsNotAWorktree', async () => {
    const repoPath = '/repo';
    mockDirExists(repoPath);

    const result = await handleVerifyWorktree(
      { cwd: repoPath },
      STATE_DIR,
      stubRevParse(mainCheckout()),
    );

    expect(result.success).toBe(true);
    const data = dataOf(result);
    expect(data.passed).toBe(false);
    expect(data.message).toContain('Not in a worktree');
    expect(data.message).toContain('main checkout');
  });

  it('MembershipComesFromGit_NotASubstring', async () => {
    // A path that spells `.worktrees/` but is the main checkout: fails.
    const spelledLikeAWorktree = '/repo/.worktrees/looks-right';
    mockDirExists(spelledLikeAWorktree);
    const calls: GitCall[] = [];

    const spoofed = await handleVerifyWorktree(
      { cwd: spelledLikeAWorktree },
      STATE_DIR,
      stubRevParse(mainCheckout(), calls),
    );
    expect(dataOf(spoofed).passed).toBe(false);

    // A path that spells nothing but IS a linked worktree: passes.
    const unnamedLayout = '/elsewhere/checkouts/wt-7';
    mockDirExists(unnamedLayout);

    const genuine = await handleVerifyWorktree(
      { cwd: unnamedLayout },
      STATE_DIR,
      stubRevParse(['true', '/repo/.git/worktrees/wt-7', '/repo/.git'], calls),
    );
    expect(dataOf(genuine).passed).toBe(true);

    // Both verdicts came from git, asked at the directory under test.
    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(call.args).toContain('rev-parse');
      expect(call.args).toContain('--git-common-dir');
    }
    expect(calls[0]?.dir).toBe(resolvedOf(spelledLikeAWorktree));
    expect(calls[1]?.dir).toBe(resolvedOf(unnamedLayout));
  });

  it('returns failed with the git reason when the directory is not in a repository', async () => {
    const looseDir = '/tmp/loose';
    mockDirExists(looseDir);

    const result = await handleVerifyWorktree(
      { cwd: looseDir },
      STATE_DIR,
      stubRevParse(['fatal: not a git repository (or any of the parent directories): .git'], [], 128),
    );

    expect(result.success).toBe(true);
    const data = dataOf(result);
    expect(data.passed).toBe(false);
    expect(data.message).toContain('not a git repository');
  });

  it('returns failed inside a bare repository', async () => {
    const bareDir = '/repo.git';
    mockDirExists(bareDir);

    const result = await handleVerifyWorktree(
      { cwd: bareDir },
      STATE_DIR,
      stubRevParse(['false', '.', '.']),
    );

    expect(dataOf(result).passed).toBe(false);
  });

  it('returns error for non-existent directory', async () => {
    const badPath = '/does/not/exist';
    vi.mocked(fs.existsSync).mockReturnValue(false);

    const result: ToolResult = await handleVerifyWorktree(
      { cwd: badPath },
      STATE_DIR,
      stubRevParse(mainCheckout()),
    );

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('INVALID_INPUT');
    expect(result.error?.message).toContain('does not exist');
  });

  it('defaults to process.cwd() when no cwd arg provided', async () => {
    const fakeCwd = '/home/user/checkouts/task-002';
    vi.spyOn(process, 'cwd').mockReturnValue(fakeCwd);
    mockDirExists(fakeCwd);

    const result = await handleVerifyWorktree(
      {},
      STATE_DIR,
      stubRevParse(linkedWorktree('/home/user/project', 'task-002')),
    );

    expect(result.success).toBe(true);
    const data = dataOf(result);
    expect(data.passed).toBe(true);
    expect(data.path).toBe(resolvedOf(fakeCwd));
  });

  it('resolves relative paths correctly', async () => {
    const resolvedPath = path.resolve('relative/path');
    mockDirExists(resolvedPath);
    const calls: GitCall[] = [];

    const result = await handleVerifyWorktree(
      { cwd: 'relative/path' },
      STATE_DIR,
      stubRevParse(mainCheckout(), calls),
    );

    expect(result.success).toBe(true);
    expect(path.isAbsolute(dataOf(result).path)).toBe(true);
    expect(calls[0]?.dir).toBe(resolvedOf(resolvedPath));
  });
});
