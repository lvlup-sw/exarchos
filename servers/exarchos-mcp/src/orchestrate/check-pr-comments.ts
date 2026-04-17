// ─── Check PR Comments ──────────────────────────────────────────────────────
//
// Analyzes PR review comment threads via VcsProvider to detect unresolved
// discussions. Comments from getPrComments() represent review comments; the
// handler groups them by path+line to detect unreplied top-level threads.
// ─────────────────────────────────────────────────────────────────────────────

import type { VcsProvider, PrComment as VcsPrComment } from '../vcs/provider.js';
import { createVcsProvider } from '../vcs/factory.js';
import type { ToolResult } from '../format.js';

// ─── Types ─────────────────────────────────────────────────────────────────

export interface CheckPrCommentsArgs {
  readonly pr: number;
  readonly repo?: string; // defaults to current repo via provider.getRepository()
}

interface CheckPrCommentsResult {
  readonly passed: boolean;
  readonly totalComments: number;
  readonly unresolvedThreads: number;
  readonly report: string;
}

// ─── Handler ───────────────────────────────────────────────────────────────

export async function handleCheckPrComments(
  args: CheckPrCommentsArgs,
  provider?: VcsProvider,
): Promise<ToolResult> {
  // Guard: validate PR number
  if (!args.pr) {
    return {
      success: false,
      error: { code: 'INVALID_INPUT', message: 'pr number is required' },
    };
  }

  const vcs = provider ?? await createVcsProvider();

  // Resolve repo (used for report display, not for API calls)
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

  // Fetch comments via VcsProvider
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

  // The VcsProvider returns flat review comments. We treat each comment as
  // a "top-level" entry. The provider does not include in_reply_to_id, so
  // all comments are currently treated as unresolved threads (each is a
  // standalone review comment without reply tracking). This is conservative:
  // the handler flags all comments as needing attention.
  //
  // If the provider later adds reply threading (in_reply_to_id), we can
  // restore the original thread-grouping logic here.
  const topLevel = comments;
  const unresolvedThreads = topLevel.length;
  const passed = unresolvedThreads === 0;

  // Build report
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
    for (const c of topLevel) {
      const lineNum = c.line ?? '?';
      const bodyPreview = c.body.split('\n')[0].slice(0, 100);
      reportLines.push(`- [${c.author}] ${c.path ?? 'unknown'}:${lineNum}: ${bodyPreview}`);
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
