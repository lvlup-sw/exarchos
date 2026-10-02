/**
 * Regression test for the worktree-escape leak (#1301).
 * An absolute parent-repo path in `Edit` or `Write` ignores the agent worktree cwd and writes into the main worktree.
 * `handleVerifyWorktreeBoundary` denies each write target outside the agent worktree root.
 * The guard unit suite stubs `gitToplevel` and `realpath`, so it cannot see a `defaultGitToplevel` that reports the main repo toplevel.
 * This file makes real linked worktrees under `.worktrees/` and runs the guard with its default git and filesystem seams.
 * Only `stderr` is injected.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { realpathSync } from 'node:fs';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { rmrfAsync } from '../../../../tools/test-helpers/temp-dir.js';
import { execFileAsync } from '../../../../tools/test-helpers/spawn.js';
import { handleVerifyWorktreeBoundary } from '../../../../src/lifecycle/verify-worktree-boundary.js';

/** Run `git <args>` from `cwd`, returning trimmed stdout (throws on failure). */
async function git(cwd: string, args: readonly string[]): Promise<string> {
  return (await execFileAsync('git', args, { cwd })).trim();
}

/** Build a PreToolUse hook payload string, as Claude Code feeds on stdin. */
function preToolUse(
  toolInput: Record<string, unknown>,
  cwd: string,
  toolName = 'Edit',
): string {
  return JSON.stringify({ cwd, tool_name: toolName, tool_input: toolInput });
}

/** PreToolUse hook exit codes: 0 allows the write, 2 denies it. */
const ALLOW = 0;
const DENY = 2;

/**
 * `worktreePath` is the agent cwd and `siblingPath` is the worktree of a parallel agent.
 * `runGuard` keeps the default git and filesystem seams and captures only `stderr`.
 */
describe('WorktreeBoundaryGuard #1301 leak-shape regression (real linked worktree, real git seams)', () => {
  let repoRoot: string;
  let worktreePath: string;
  let siblingPath: string;

  function runGuard(stdin: string): { code: number; err: string } {
    const errLines: string[] = [];
    const code = handleVerifyWorktreeBoundary(stdin, {
      stderr: (s) => errLines.push(s),
    });
    return { code, err: errLines.join('\n') };
  }

  /**
   * `realpathSync` resolves the macOS `/tmp` symlink, so the containment check compares canonical paths.
   * The committed `src.txt` gives the absolute-path leak a real target in the main worktree.
   * The two linked worktrees have their own toplevels, as native isolation makes them.
   */
  beforeEach(async () => {
    repoRoot = realpathSync(await mkdtemp(path.join(tmpdir(), 'boundary-1301-')));
    await git(repoRoot, ['init', '-q', '-b', 'main']);
    await git(repoRoot, ['config', 'user.email', 'test@example.com']);
    await git(repoRoot, ['config', 'user.name', 'Test']);
    await git(repoRoot, ['config', 'commit.gpgsign', 'false']);
    await writeFile(path.join(repoRoot, 'src.txt'), 'baseline\n');
    await git(repoRoot, ['add', '.']);
    await git(repoRoot, ['commit', '-q', '-m', 'baseline']);

    worktreePath = path.join(repoRoot, '.worktrees', 'agent-x');
    siblingPath = path.join(repoRoot, '.worktrees', 'agent-other');
    await git(repoRoot, ['worktree', 'add', '-q', worktreePath, '-b', 'agent-x']);
    await git(repoRoot, ['worktree', 'add', '-q', siblingPath, '-b', 'agent-other']);
  });

  afterEach(async () => {
    await rmrfAsync(repoRoot);
  });

  /**
   * The real `defaultGitToplevel` must resolve the agent cwd to the linked worktree toplevel.
   * The main repo is then out of bounds, and the deny reason cites #1301.
   */
  it('WorktreeBoundary_AbsoluteMainRepoPath_DeniedThroughRealGitToplevel', () => {
    const { code, err } = runGuard(
      preToolUse({ file_path: path.join(repoRoot, 'src.txt') }, worktreePath),
    );
    expect(code).toBe(DENY);
    expect(err).toMatch(/outside the isolated worktree/i);
    expect(err).toContain('#1301');
  });

  /** A relative `..` path from the worktree resolves to the same main-repo file. */
  it('WorktreeBoundary_DotDotEscapeToMainRepo_Denied', () => {
    const { code } = runGuard(
      preToolUse({ file_path: '../../src.txt' }, worktreePath),
    );
    expect(code).toBe(DENY);
  });

  /** A write into the worktree of a parallel agent is also out of bounds. */
  it('WorktreeBoundary_SiblingWorktreePath_Denied', () => {
    const { code } = runGuard(
      preToolUse(
        { file_path: path.join(siblingPath, 'src.txt') },
        worktreePath,
      ),
    );
    expect(code).toBe(DENY);
  });

  /** The notebook write tool has the same leak path. */
  it('WorktreeBoundary_NotebookEditIntoMainRepo_Denied', () => {
    const { code } = runGuard(
      preToolUse(
        { notebook_path: path.join(repoRoot, 'analysis.ipynb') },
        worktreePath,
        'NotebookEdit',
      ),
    );
    expect(code).toBe(DENY);
  });

  it('WorktreeBoundary_RelativePathInsideWorktree_Allowed', () => {
    const { code } = runGuard(
      preToolUse({ file_path: 'src.txt' }, worktreePath),
    );
    expect(code).toBe(ALLOW);
  });

  it('WorktreeBoundary_AbsolutePathInsideWorktree_Allowed', () => {
    const { code } = runGuard(
      preToolUse(
        { file_path: path.join(worktreePath, 'src.txt') },
        worktreePath,
      ),
    );
    expect(code).toBe(ALLOW);
  });

  /** A new nested path runs the `ENOENT` branch of `defaultRealpath` on a real filesystem. */
  it('WorktreeBoundary_NewNestedFileInsideWorktree_Allowed', () => {
    const { code } = runGuard(
      preToolUse(
        { file_path: path.join(worktreePath, 'sub', 'brand-new.ts') },
        worktreePath,
      ),
    );
    expect(code).toBe(ALLOW);
  });
});
