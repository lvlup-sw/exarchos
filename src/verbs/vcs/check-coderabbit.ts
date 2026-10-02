/**
 * Reads the CodeRabbit review state of each PR through the `VcsProvider`. A PR
 * passes when its last CodeRabbit review is approved, or when it has no
 * CodeRabbit review. Any other state, or an API error, fails. An invalid PR
 * number is skipped, and a skip is not a failure.
 */

import type { VcsProvider } from '../../vcs/provider.js';
import { createVcsProvider } from '../../vcs/factory.js';
import type { ToolResult } from '../../format.js';

export interface CheckCoderabbitArgs {
  readonly owner: string;
  readonly repo: string;
  readonly prNumbers: number[];
}

export interface PrReviewResult {
  readonly pr: number;
  readonly state: string;
  readonly verdict: 'pass' | 'fail' | 'skip';
}

interface CheckCoderabbitResult {
  readonly passed: boolean;
  readonly report: string;
  readonly results: readonly PrReviewResult[];
}

const OWNER_REPO_RE = /^[a-zA-Z0-9._-]+$/;

const CODERABBIT_LOGINS = new Set([
  'coderabbitai[bot]',
  'coderabbitai',
  'coderabbit-ai[bot]',
  'coderabbit-ai',
]);

export async function handleCheckCoderabbit(
  args: CheckCoderabbitArgs,
  provider?: VcsProvider,
): Promise<ToolResult> {
  if (!args.owner || !OWNER_REPO_RE.test(args.owner)) {
    return {
      success: false,
      error: { code: 'INVALID_INPUT', message: 'owner is required and must match [a-zA-Z0-9._-]+' },
    };
  }

  if (!args.repo || !OWNER_REPO_RE.test(args.repo)) {
    return {
      success: false,
      error: { code: 'INVALID_INPUT', message: 'repo is required and must match [a-zA-Z0-9._-]+' },
    };
  }

  if (!args.prNumbers || args.prNumbers.length === 0) {
    return {
      success: false,
      error: { code: 'INVALID_INPUT', message: 'prNumbers must be a non-empty array' },
    };
  }

  const vcs = provider ?? await createVcsProvider();
  const results: PrReviewResult[] = [];

  for (const pr of args.prNumbers) {
    if (!Number.isInteger(pr) || pr <= 0) {
      results.push({ pr, state: 'INVALID_PR', verdict: 'skip' });
      continue;
    }

    try {
      const reviewStatus = await vcs.getReviewStatus(String(pr));

      const coderabbitReviewers = reviewStatus.reviewers.filter(
        (r) => CODERABBIT_LOGINS.has(r.login),
      );

      if (coderabbitReviewers.length === 0) {
        results.push({ pr, state: 'NONE', verdict: 'pass' });
        continue;
      }

      const latest = coderabbitReviewers[coderabbitReviewers.length - 1];
      if (latest === undefined) continue;
      const stateStr = latest.state === 'approved' ? 'APPROVED' :
                       latest.state === 'changes_requested' ? 'CHANGES_REQUESTED' :
                       latest.state === 'commented' ? 'COMMENTED' : 'PENDING';

      const verdict = latest.state === 'approved' ? 'pass' : 'fail';
      results.push({ pr, state: stateStr, verdict });
    } catch {
      results.push({ pr, state: 'API_ERROR', verdict: 'fail' });
    }
  }

  const allPassed = results.every((r) => r.verdict !== 'fail');

  const lines: string[] = [];
  lines.push('## CodeRabbit Review Status');
  lines.push('');
  lines.push(`**Repository:** ${args.owner}/${args.repo}`);
  lines.push('');
  lines.push('| PR | State | Verdict |');
  lines.push('|----|-------|---------|');
  for (const r of results) {
    lines.push(`| #${r.pr} | ${r.state} | ${r.verdict} |`);
  }
  lines.push('');
  if (allPassed) {
    lines.push('**Result: PASS** — all PRs passed CodeRabbit review');
  } else {
    const failCount = results.filter((r) => r.verdict === 'fail').length;
    lines.push(`**Result: FAIL** — ${failCount} PR(s) did not pass CodeRabbit review`);
  }

  const report = lines.join('\n');

  const result: CheckCoderabbitResult = { passed: allPassed, report, results };

  return { success: true, data: result };
}
