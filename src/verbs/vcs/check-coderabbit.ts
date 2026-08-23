// ─── Check CodeRabbit Review State ──────────────────────────────────────────
//
// Queries CodeRabbit review state on PRs via VcsProvider. For each PR,
// fetches review status, filters to CodeRabbit bot reviewers, and classifies:
// approved -> pass, absent reviewer -> indeterminate, else -> fail.
//
// Migrated from direct `gh api` calls to VcsProvider.getReviewStatus().
// ─────────────────────────────────────────────────────────────────────────────

import type { VcsProvider } from '../../vcs/provider.js';
import { createVcsProvider } from '../../vcs/factory.js';
import type { ToolResult } from '../../format.js';

// ─── Types ─────────────────────────────────────────────────────────────────

export interface CheckCoderabbitArgs {
  readonly owner: string;
  readonly repo: string;
  readonly prNumbers: number[];
}

export interface PrReviewResult {
  readonly pr: number;
  readonly state: string;
  readonly verdict: 'pass' | 'fail' | 'skip' | 'indeterminate';
}

interface CheckCoderabbitResult {
  readonly passed: boolean;
  readonly report: string;
  readonly results: readonly PrReviewResult[];
  /** Present only when a PR carried no review from the recognized reviewer. */
  readonly skipped?: true;
  readonly discriminant?: string;
  readonly reason?: string;
}

/**
 * The discriminant carried when the recognized reviewer never reviewed.
 *
 * Exported because the outcome has a READER: the synthesize skill's step 4
 * branches on it to tell an unmeasured obligation from a disproof, and without
 * that branch a repository the vendor does not watch reads `passed: false` and
 * is sent to a fix cycle that cannot fix anything. Naming the constant is what
 * lets the guard on that documentation follow a rename.
 */
export const CODERABBIT_REVIEWER_ABSENT = 'coderabbit-reviewer-absent';

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

      // An absent reviewer is not an approval. The check exists to establish
      // that this reviewer looked at the PR, and nothing here establishes that
      // — so it yields no verdict rather than the pass it used to mint, which
      // read as coverage on every repository the reviewer does not watch.
      if (coderabbitReviewers.length === 0) {
        results.push({ pr, state: 'NONE', verdict: 'indeterminate' });
        continue;
      }

      // Map reviewer state to review state string
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

  // Overall verdict. `skip` is a withdrawn subject (an unusable PR number, so
  // there was never an obligation); `indeterminate` is an OWED one that went
  // unmeasured, so it withholds the pass instead of being counted as one.
  const failCount = results.filter((r) => r.verdict === 'fail').length;
  const unmeasured = results.filter((r) => r.verdict === 'indeterminate');
  const allPassed = failCount === 0 && unmeasured.length === 0;

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
  const unmeasuredReason =
    `no CodeRabbit review found on ${unmeasured.length} PR(s): ` +
    `${unmeasured.map((r) => `#${r.pr}`).join(', ')}`;
  if (allPassed) {
    lines.push('**Result: PASS** — all PRs passed CodeRabbit review');
  } else if (failCount > 0) {
    lines.push(`**Result: FAIL** — ${failCount} PR(s) did not pass CodeRabbit review`);
  } else {
    lines.push(`**Result: INDETERMINATE** — ${unmeasuredReason}`);
  }

  const report = lines.join('\n');

  const result: CheckCoderabbitResult = {
    passed: allPassed,
    report,
    results,
    // Only when nothing FAILED but something went unmeasured: a real disproof
    // is a conclusion, and stamping it as a skip would hide it.
    ...(failCount === 0 && unmeasured.length > 0
      ? { skipped: true, discriminant: CODERABBIT_REVIEWER_ABSENT, reason: unmeasuredReason }
      : {}),
  };

  return { success: true, data: result };
}
