// ─── Check CodeRabbit Review State ──────────────────────────────────────────
//
// Queries CodeRabbit review state on PRs via VcsProvider. For each PR,
// fetches review status, filters to CodeRabbit bot reviewers, and classifies:
// approved -> pass, NONE -> pass, else -> fail.
//
// Migrated from direct `gh api` calls to VcsProvider.getReviewStatus().
// ─────────────────────────────────────────────────────────────────────────────

import type { VcsProvider } from '../vcs/provider.js';
import { createVcsProvider } from '../vcs/factory.js';
import type { ToolResult } from '../format.js';

// ─── Types ─────────────────────────────────────────────────────────────────

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

// ─── Constants ──────────────────────────────────────────────────────────────

const OWNER_REPO_RE = /^[a-zA-Z0-9._-]+$/;

const CODERABBIT_LOGINS = new Set([
  'coderabbitai[bot]',
  'coderabbitai',
  'coderabbit-ai[bot]',
  'coderabbit-ai',
]);

// ─── Handler ────────────────────────────────────────────────────────────────

export async function handleCheckCoderabbit(
  args: CheckCoderabbitArgs,
  provider?: VcsProvider,
): Promise<ToolResult> {
  // Validate owner
  if (!args.owner || !OWNER_REPO_RE.test(args.owner)) {
    return {
      success: false,
      error: { code: 'INVALID_INPUT', message: 'owner is required and must match [a-zA-Z0-9._-]+' },
    };
  }

  // Validate repo
  if (!args.repo || !OWNER_REPO_RE.test(args.repo)) {
    return {
      success: false,
      error: { code: 'INVALID_INPUT', message: 'repo is required and must match [a-zA-Z0-9._-]+' },
    };
  }

  // Validate prNumbers
  if (!args.prNumbers || args.prNumbers.length === 0) {
    return {
      success: false,
      error: { code: 'INVALID_INPUT', message: 'prNumbers must be a non-empty array' },
    };
  }

  const vcs = provider ?? await createVcsProvider();
  const results: PrReviewResult[] = [];

  for (const pr of args.prNumbers) {
    // Skip invalid PR numbers
    if (!Number.isInteger(pr) || pr <= 0) {
      results.push({ pr, state: 'INVALID_PR', verdict: 'skip' });
      continue;
    }

    try {
      const reviewStatus = await vcs.getReviewStatus(String(pr));

      // Filter to CodeRabbit reviewers
      const coderabbitReviewers = reviewStatus.reviewers.filter(
        (r) => CODERABBIT_LOGINS.has(r.login),
      );

      if (coderabbitReviewers.length === 0) {
        results.push({ pr, state: 'NONE', verdict: 'pass' });
        continue;
      }

      // Map reviewer state to review state string
      const latest = coderabbitReviewers[coderabbitReviewers.length - 1];
      const stateStr = latest.state === 'approved' ? 'APPROVED' :
                       latest.state === 'changes_requested' ? 'CHANGES_REQUESTED' :
                       latest.state === 'commented' ? 'COMMENTED' : 'PENDING';

      const verdict = latest.state === 'approved' ? 'pass' : 'fail';
      results.push({ pr, state: stateStr, verdict });
    } catch {
      results.push({ pr, state: 'API_ERROR', verdict: 'fail' });
    }
  }

  // Compute overall pass (skip doesn't count as fail)
  const allPassed = results.every((r) => r.verdict !== 'fail');

  // Build markdown report
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
