/**
 * `review_diff` orchestrate handler. It runs `git diff` and returns a capped diff plus a markdown
 * report. The capped diff text appears only once, in `data.diff`. The report carries the stat
 * summary, the full file list, and a steering hint when the diff is truncated.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import type { ToolResult } from '../../format.js';

/** Caps on the embedded diff. The first cap that the diff reaches stops it. */
export const REVIEW_DIFF_CAPS = {
  /** Maximum number of `@@` hunks embedded in `data.diff`. */
  maxHunks: 40,
  /** Hard character backstop on the embedded diff (bounds one huge hunk). */
  maxChars: 16_000,
} as const;

interface ReviewDiffArgs {
  readonly worktreePath?: string;
  readonly baseBranch?: string;
}

interface CappedDiff {
  readonly text: string;
  readonly truncated: boolean;
  readonly hunksTotal: number;
  readonly hunksReturned: number;
}

/**
 * Caps a unified diff at `maxHunks` hunks and `maxChars` characters, newlines included. The report
 * still names every changed file when the diff is truncated.
 */
export function capDiff(diff: string): CappedDiff {
  if (diff.length === 0) {
    return { text: '', truncated: false, hunksTotal: 0, hunksReturned: 0 };
  }

  const lines = diff.split('\n');
  const isHunkHeader = (line: string): boolean => line.startsWith('@@ ');
  const hunksTotal = lines.filter(isHunkHeader).length;

  const kept: string[] = [];
  let hunksReturned = 0;
  let chars = 0;
  let truncated = false;

  for (const line of lines) {
    if (isHunkHeader(line)) {
      if (hunksReturned >= REVIEW_DIFF_CAPS.maxHunks) {
        truncated = true;
        break;
      }
      hunksReturned += 1;
    }
    if (chars + line.length + 1 > REVIEW_DIFF_CAPS.maxChars) {
      truncated = true;
      break;
    }
    kept.push(line);
    chars += line.length + 1;
  }

  return {
    text: kept.join('\n'),
    truncated,
    hunksTotal,
    hunksReturned,
  };
}

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
 * Runs `git diff` with three-dot notation. If that fails, for example in a shallow clone with no
 * merge base, it runs the two-dot form.
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

/**
 * Validates `worktreePath`, then diffs it against `baseBranch`, which defaults to `main`. An
 * unknown base branch returns `DIFF_FAILED`, not a thrown error.
 */
export async function handleReviewDiff(
  args: ReviewDiffArgs,
  _stateDir: string,
): Promise<ToolResult> {
  const worktreePath = args.worktreePath ?? process.cwd();
  const baseBranch = args.baseBranch ?? 'main';

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

  const currentBranch = git(['branch', '--show-current'], worktreePath);

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

  const files = nameOnly
    .split('\n')
    .map((f) => f.trim())
    .filter((f) => f.length > 0);
  const filesChanged = files.length;

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
      data: {
        diff: '',
        filesChanged: 0,
        truncated: false,
        hunksTotal: 0,
        hunksReturned: 0,
        report,
      },
    };
  }

  const capped = capDiff(diff);

  const steering = capped.truncated
    ? `_Diff truncated: showing ${capped.hunksReturned} of ${capped.hunksTotal} hunks. Run \`git diff ${baseBranch}...HEAD\` in \`${worktreePath}\` for the full diff._`
    : undefined;

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
    '### Diff',
    '',
    `Full diff in \`data.diff\` (${capped.hunksReturned} of ${capped.hunksTotal} hunks).`,
    ...(steering ? ['', steering] : []),
  ].join('\n');

  return {
    success: true,
    data: {
      diff: capped.text,
      filesChanged,
      truncated: capped.truncated,
      hunksTotal: capped.hunksTotal,
      hunksReturned: capped.hunksReturned,
      report,
    },
  };
}
