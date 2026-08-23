// ─── Verify Worktree Orchestrate Action ──────────────────────────────────────
//
// Verifies that the current or provided working directory is a *linked* git
// worktree rather than the repository's main checkout.
// ─────────────────────────────────────────────────────────────────────────────

import * as fs from 'node:fs';
import * as path from 'node:path';
import { toPosix } from '../../utils/paths.js';
import type { ToolResult } from '../../format.js';
import type { GitExec } from '../pure/execute-merge.js';
import { defaultGitExec } from './gate-utils.js';

// ─── Types ──────────────────────────────────────────────────────────────────

interface VerifyWorktreeArgs {
  readonly cwd?: string;
}

/** What git says the directory is. */
type WorktreeMembership =
  | { readonly kind: 'linked' }
  | { readonly kind: 'main-checkout' }
  | { readonly kind: 'outside'; readonly reason: string };

// ─── Membership ─────────────────────────────────────────────────────────────

/**
 * Ask git whether `dir` is a linked worktree.
 *
 * A path substring cannot answer this. Where a repository keeps its worktrees
 * is that repository's choice — `.worktrees/`, `worktrees/`, the harness-native
 * `.claude/worktrees/`, or a directory outside the repo entirely — so testing
 * for one spelling misses every other layout (this gate reported "not in a
 * worktree" from inside a real one) and matches any unrelated directory that
 * happens to use it. Git already holds the fact: a linked worktree has a
 * private git dir beneath the shared one, so `--git-dir` and `--git-common-dir`
 * differ, while in the main checkout they name the same path.
 *
 * One `rev-parse` answers all three questions; a non-zero exit means the
 * directory is not inside a repository at all.
 */
function classifyWorktree(dir: string, gitExec: GitExec): WorktreeMembership {
  const probe = gitExec(dir, [
    'rev-parse',
    '--is-inside-work-tree',
    '--git-dir',
    '--git-common-dir',
  ]);

  if (probe.exitCode !== 0) {
    return { kind: 'outside', reason: firstLine(probe.stdout) || 'git rev-parse failed' };
  }

  const [insideWorkTree, gitDir, commonDir] = probe.stdout.trim().split(/\r?\n/);
  if (insideWorkTree !== 'true') {
    return { kind: 'outside', reason: 'not inside a git work tree' };
  }
  if (gitDir === undefined || commonDir === undefined) {
    return { kind: 'outside', reason: 'git reported no git-dir/git-common-dir pair' };
  }

  // Either path may come back relative to `dir`; resolve both before comparing.
  return path.resolve(dir, gitDir.trim()) === path.resolve(dir, commonDir.trim())
    ? { kind: 'main-checkout' }
    : { kind: 'linked' };
}

function firstLine(text: string): string {
  return text.trim().split(/\r?\n/)[0]?.trim() ?? '';
}

// ─── Handler ────────────────────────────────────────────────────────────────

export async function handleVerifyWorktree(
  args: VerifyWorktreeArgs,
  _stateDir: string,
  gitExec: GitExec = defaultGitExec,
): Promise<ToolResult> {
  const rawPath = args.cwd ?? process.cwd();
  // Normalize to POSIX so the returned path is separator-agnostic
  // (path.resolve emits backslashes on Windows).
  const resolvedPath = toPosix(path.resolve(rawPath));

  if (!fs.existsSync(resolvedPath)) {
    return {
      success: false,
      error: {
        code: 'INVALID_INPUT',
        message: `Directory does not exist: ${resolvedPath}`,
      },
    };
  }

  const stat = fs.statSync(resolvedPath);
  if (!stat.isDirectory()) {
    return {
      success: false,
      error: {
        code: 'INVALID_INPUT',
        message: `Path is not a directory: ${resolvedPath}`,
      },
    };
  }

  const membership = classifyWorktree(resolvedPath, gitExec);

  if (membership.kind === 'linked') {
    return {
      success: true,
      data: {
        passed: true,
        path: resolvedPath,
        message: `OK: Working in worktree at ${resolvedPath}`,
      },
    };
  }

  const reason =
    membership.kind === 'main-checkout'
      ? "it is the repository's main checkout"
      : membership.reason;

  return {
    success: true,
    data: {
      passed: false,
      path: resolvedPath,
      message: `Not in a worktree! Current directory: ${resolvedPath} — ${reason}. Expected: a linked git worktree, whichever directory this repository keeps worktrees in. ABORTING — DO NOT proceed with file modifications.`,
    },
  };
}
