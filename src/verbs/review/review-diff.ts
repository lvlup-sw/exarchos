/**
 * `review_diff` orchestrate handler. It reads the diff through the constrained Git reader and returns a capped diff plus a markdown
 * report. The capped diff text appears only once, in `data.diff`. The report carries the stat
 * summary, the full file list, and a steering hint when the diff is truncated.
 */

import fs from 'node:fs';
import type { ToolResult } from '../../format.js';
import {
  decideRelation, exitedWithOne, locateObservational, observeHead, resolveObservedBase, type ObservationalCheckout,
} from '../../utils/git-observer.js';
import { observationalReader } from '../../utils/git-tree.js';

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

/** The output of a read with its leading and trailing newlines removed. */
function trimNewlines(output: string): string {
  return output.replace(/^\n+|\n+$/g, '');
}

/** The short branch name of the symbolic HEAD. A detached HEAD gives the empty name. Any other failure rejects. */
async function currentBranchOf(located: ObservationalCheckout): Promise<string> {
  try {
    const ref = (await located.reads.branch(located.gitDir, located.checkout)).trim();
    return ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : ref;
  } catch (error) {
    if (exitedWithOne(error)) return '';
    throw error;
  }
}

/** The stat, the name list and the full diff of one review, and the branch of the checkout. */
interface ReviewReads {
  readonly branch: string;
  readonly stat: string;
  readonly nameOnly: string;
  readonly diff: string;
}

/**
 * Read the review diff from the merge base of the base name and the head over exact commits, with the default rename detection.
 * A decided "no merge base" reads from the base itself. An undecided answer in a shallow checkout rejects.
 */
async function readReview(located: ObservationalCheckout, baseBranch: string): Promise<ReviewReads> {
  const branch = await currentBranchOf(located);
  const { head } = await observeHead(located);
  const base = await resolveObservedBase(located, baseBranch);
  const relation = await decideRelation(located, 'merge-base', base, head);
  if (relation.kind === 'unreadable') throw new Error(relation.reason);
  const from = relation.kind === 'related' ? relation.commit : base;
  const { reads, gitDir, checkout } = located;
  return {
    branch,
    stat: trimNewlines(await reads.diffStat(gitDir, checkout, from, head)),
    nameOnly: trimNewlines(await reads.nameOnly(gitDir, checkout, from, head)),
    diff: trimNewlines(await reads.fullDiff(gitDir, checkout, from, head)),
  };
}

/**
 * Validates `worktreePath`, then diffs it against `baseBranch`, which defaults to `main`, through the constrained reader.
 * A non-empty `gitPath` names the Git executable, else the read uses the process-wide Git path.
 * A path outside any checkout returns `NOT_GIT_REPO`. An unknown base branch and an unreadable read return `DIFF_FAILED`, not a thrown error.
 */
export async function handleReviewDiff(
  args: ReviewDiffArgs,
  _stateDir: string,
  gitPath?: string,
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

  const observation = await locateObservational(worktreePath, observationalReader(gitPath));
  if (observation.kind === 'absent') {
    return {
      success: false,
      error: {
        code: 'NOT_GIT_REPO',
        message: `Not a git repository: ${worktreePath}`,
      },
    };
  }

  let currentBranch: string;
  let stat: string;
  let nameOnly: string;
  let diff: string;
  try {
    if (observation.kind === 'unreadable') throw new Error(observation.reason);
    ({ branch: currentBranch, stat, nameOnly, diff } = await readReview(observation.located, baseBranch));
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
