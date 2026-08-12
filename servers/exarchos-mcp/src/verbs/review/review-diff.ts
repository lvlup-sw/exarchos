// ─── Review Diff Orchestrate Action ─────────────────────────────────────────
//
// Generates a context-efficient diff for code review by running git diff
// and formatting output as structured markdown.
// Replaces scripts/review-diff.sh with a TypeScript orchestrate handler.
//
// DR-7 (counts-not-transcripts): the raw diff is embedded AT MOST ONCE — in
// `data.diff` — and capped to a bounded number of hunks / characters. The
// markdown `data.report` carries the stat-summary + full file list + a steering
// hint when the diff is truncated, but NEVER re-embeds the diff text (the old
// double-embed: full diff in `data.diff` and again inside `data.report`).
// ────────────────────────────────────────────────────────────────────────────

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import type { ToolResult } from '../../format.js';

// ─── Caps (counts-not-transcripts) ──────────────────────────────────────────

/**
 * Bounds on the single embedded diff copy. A large diff is capped to the first
 * `maxHunks` hunks and, as a hard backstop against a single pathological hunk,
 * `maxChars` characters — whichever binds first. Exported so budget tests can
 * assert against the contract rather than magic numbers.
 */
export const REVIEW_DIFF_CAPS = {
  /** Maximum number of `@@` hunks embedded in `data.diff`. */
  maxHunks: 40,
  /** Hard character backstop on the embedded diff (bounds one huge hunk). */
  maxChars: 16_000,
} as const;

// ─── Types ──────────────────────────────────────────────────────────────────

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

// ─── Diff Capping ────────────────────────────────────────────────────────────

/**
 * Cap a unified diff to at most `maxHunks` hunks and `maxChars` characters.
 *
 * Counts-not-transcripts: the full per-file list + stat summary (carried by the
 * report) always names every changed file, so triage never loses "what changed"
 * even when the hunk transcript is truncated. The steering hint points at the
 * uncapped path (`git diff <base>...HEAD`).
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
    // +1 for the rejoining newline.
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

  // Cap the diff to a bounded number of hunks / characters. The raw diff lives
  // here — and ONLY here — so no hunk text is ever embedded more than once.
  const capped = capDiff(diff);

  // Steering hint to the uncapped path when the transcript was truncated.
  const steering = capped.truncated
    ? `_Diff truncated: showing ${capped.hunksReturned} of ${capped.hunksTotal} hunks. Run \`git diff ${baseBranch}...HEAD\` in \`${worktreePath}\` for the full diff._`
    : undefined;

  // Build markdown report — stat-summary + file list + steering, but NO embedded
  // diff text (that would double-embed what already lives in `data.diff`).
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
