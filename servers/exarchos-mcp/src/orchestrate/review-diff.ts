// ─── Review Diff Orchestrate Action ─────────────────────────────────────────
//
// Generates a context-efficient diff for code review by running git diff
// and formatting output as structured markdown.
// Replaces scripts/review-diff.sh with a TypeScript orchestrate handler.
// ────────────────────────────────────────────────────────────────────────────

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import type { ToolResult } from '../format.js';

// ─── Types ──────────────────────────────────────────────────────────────────

interface ReviewDiffArgs {
  readonly worktreePath?: string;
  readonly baseBranch?: string;
}

// ─── Git Helpers ────────────────────────────────────────────────────────────

/** Run a git command, returning stdout with leading/trailing newlines stripped. */
function git(args: readonly string[], cwd: string): string {
  return execFileSync('git', [...args], {
    cwd,
    encoding: 'utf-8',
    timeout: 30_000,
    stdio: ['pipe', 'pipe', 'pipe'],
  }).replace(/^\n+|\n+$/g, '');
}

/**
 * Run a git diff with three-dot notation first, falling back to two-dot
 * if the merge base is unavailable (e.g., shallow clone).
 */
function gitDiffWithFallback(
  base: string,
  extraArgs: readonly string[],
  cwd: string,
): string {
  try {
    return git(['diff', `${base}...HEAD`, ...extraArgs], cwd);
  } catch {
    return git(['diff', `${base}..HEAD`, ...extraArgs], cwd);
  }
}

// ─── Handler ────────────────────────────────────────────────────────────────

export async function handleReviewDiff(
  args: ReviewDiffArgs,
  _stateDir: string,
): Promise<ToolResult> {
  const worktreePath = args.worktreePath ?? process.cwd();
  const baseBranch = args.baseBranch ?? 'main';

  // Validate path exists and is a directory
  try {
    if (!fs.statSync(worktreePath).isDirectory()) {
      return {
        success: false,
        error: {
          code: 'INVALID_INPUT',
          message: `Not a directory: ${worktreePath}`,
        },
      };
    }
  } catch {
    return {
      success: false,
      error: {
        code: 'INVALID_INPUT',
        message: `Directory not found: ${worktreePath}`,
      },
    };
  }

  // Verify git repository
  try {
    git(['rev-parse', '--git-dir'], worktreePath);
  } catch {
    return {
      success: false,
      error: {
        code: 'NOT_GIT_REPO',
        message: `Not a git repository: ${worktreePath}`,
      },
    };
  }

  // Get current branch
  const currentBranch = git(['branch', '--show-current'], worktreePath);

  // Get diff components — wrap in try-catch so unknown base branch returns structured error
  let stat: string;
  let nameOnly: string;
  let diff: string;
  try {
    stat = gitDiffWithFallback(baseBranch, ['--stat'], worktreePath);
    nameOnly = gitDiffWithFallback(baseBranch, ['--name-only'], worktreePath);
    diff = gitDiffWithFallback(baseBranch, ['--unified=3'], worktreePath);
  } catch (err) {
    return {
      success: false,
      error: {
        code: 'DIFF_FAILED',
        message: `Failed to compute diff against '${baseBranch}': ${err instanceof Error ? err.message : String(err)}`,
      },
    };
  }

  // Parse file list
  const files = nameOnly
    .split('\n')
    .map((f) => f.trim())
    .filter((f) => f.length > 0);
  const filesChanged = files.length;

  // Handle empty diff
  if (filesChanged === 0) {
    const report = [
      '## Review Diff',
      '',
      `**Worktree:** ${worktreePath}`,
      `**Branch:** ${currentBranch}`,
      `**Base:** ${baseBranch}`,
      '',
      'No changes found between branches.',
    ].join('\n');

    return {
      success: true,
      data: { diff: '', filesChanged: 0, report },
    };
  }

  // Build markdown report
  const fileList = files.map((f) => `- \`${f}\``).join('\n');
  const report = [
    '## Review Diff',
    '',
    `**Worktree:** ${worktreePath}`,
    `**Branch:** ${currentBranch}`,
    `**Base:** ${baseBranch}`,
    '',
    '### Changed Files',
    '',
    '```',
    stat,
    '```',
    '',
    '### Files Modified',
    '',
    fileList,
    '',
    '### Diff Content',
    '',
    '```diff',
    diff,
    '```',
  ].join('\n');

  return {
    success: true,
    data: { diff, filesChanged, report },
  };
}
