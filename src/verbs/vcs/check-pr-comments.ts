/**
 * Checks a PR for unaddressed review comments through the `VcsProvider`. Each
 * comment that the provider returns counts as an unaddressed thread. The check
 * does not read `parentId` or the resolution status.
 */

import type { VcsProvider, PrComment as VcsPrComment } from '../../vcs/provider.js';
import { requiresGitHub } from '../../vcs/require-github.js';
import { createVcsProvider } from '../../vcs/factory.js';
import type { ToolResult } from '../../format.js';

/**
 * The maximum number of comment lines in a FAIL report. Past the cap, the
 * report gives the total and points to `gh pr view <pr> --comments`. It is an
 * internal constant, not a schema parameter.
 */
export const UNADDRESSED_COMMENT_LIST_CAP = 20;

export interface CheckPrCommentsArgs {
  readonly pr: number;
  /** Defaults to the current repository from `provider.getRepository()`. Used only in the report. */
  readonly repo?: string;
}

interface CheckPrCommentsResult {
  readonly passed: boolean;
  readonly totalComments: number;
  readonly unresolvedThreads: number;
  readonly report: string;
}

export async function handleCheckPrComments(
  args: CheckPrCommentsArgs,
  provider?: VcsProvider,
): Promise<ToolResult> {
  const vcsGuard = requiresGitHub(provider, 'check_pr_comments');
  if (vcsGuard) return vcsGuard;

  if (!args.pr) {
    return {
      success: false,
      error: { code: 'INVALID_INPUT', message: 'pr number is required' },
    };
  }

  const vcs = provider ?? await createVcsProvider();

  let repo = args.repo;
  if (!repo) {
    try {
      const repoInfo = await vcs.getRepository();
      repo = repoInfo.nameWithOwner;
    } catch {
      return {
        success: false,
        error: { code: 'REPO_DETECTION_ERROR', message: 'Could not detect repository. Provide repo argument.' },
      };
    }
  }

  let comments: VcsPrComment[];
  try {
    comments = await vcs.getPrComments(String(args.pr));
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      success: false,
      error: { code: 'GH_API_ERROR', message: `Failed to fetch PR comments via provider: ${message}` },
    };
  }

  const topLevel = comments;
  const unresolvedThreads = topLevel.length;
  const passed = unresolvedThreads === 0;

  const reportLines: string[] = [];
  reportLines.push(`## PR #${args.pr} Comment Status`);
  reportLines.push('');
  reportLines.push(`Top-level comments: ${topLevel.length}`);
  reportLines.push(`With replies: 0`);
  reportLines.push(`Unaddressed: ${unresolvedThreads}`);

  if (passed) {
    reportLines.push('');
    reportLines.push('**Result: PASS** — all comments addressed');
  } else {
    reportLines.push('');
    reportLines.push('### Unaddressed Comments');
    const shownComments = topLevel.slice(0, UNADDRESSED_COMMENT_LIST_CAP);
    for (const c of shownComments) {
      const lineNum = c.line ?? '?';
      const bodyPreview = (c.body.split('\n')[0] ?? '').slice(0, 100);
      reportLines.push(`- [${c.author}] ${c.path ?? 'unknown'}:${lineNum}: ${bodyPreview}`);
    }
    if (topLevel.length > shownComments.length) {
      const remaining = topLevel.length - shownComments.length;
      reportLines.push(
        `- …and ${remaining} more (${unresolvedThreads} unaddressed total). ` +
          `Run \`gh pr view ${args.pr} --comments\` for the full list.`,
      );
    }
    reportLines.push('');
    reportLines.push(`**Result: FAIL** — ${unresolvedThreads} unaddressed comment(s)`);
  }

  const report = reportLines.join('\n');

  const result: CheckPrCommentsResult = {
    passed,
    totalComments: comments.length,
    unresolvedThreads,
    report,
  };

  return { success: true, data: result };
}
