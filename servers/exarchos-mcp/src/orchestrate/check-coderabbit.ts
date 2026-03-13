// ─── Check CodeRabbit Review State ──────────────────────────────────────────
//
// Queries CodeRabbit review state on GitHub PRs via `gh api`. For each PR,
// fetches reviews, filters to CodeRabbit bot reviews, takes the latest by
// submitted_at, and classifies: APPROVED → pass, NONE → pass, else → fail.
//
// TypeScript port of scripts/check-coderabbit.sh — no jq/awk needed.
// ─────────────────────────────────────────────────────────────────────────────

import { execFileSync } from 'node:child_process';
import type { ToolResult } from '../format.js';

// ─── Types ─────────────────────────────────────────────────────────────────

export interface CheckCoderabbitArgs {
  readonly owner: string;
  readonly repo: string;
  readonly prNumbers: number[];
}

interface GhReview {
  readonly user: { readonly login: string };
  readonly state: string;
  readonly submitted_at: string;
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

export function handleCheckCoderabbit(args: CheckCoderabbitArgs): ToolResult {
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

  const results: PrReviewResult[] = [];

  for (const pr of args.prNumbers) {
    // Skip invalid PR numbers
    if (!Number.isInteger(pr) || pr <= 0) {
      results.push({ pr, state: 'INVALID_PR', verdict: 'skip' });
      continue;
    }

    // Fetch reviews via gh api
    // Use --jq '.[]' to emit newline-delimited JSON objects, avoiding the
    // concatenated-array problem with --paginate on array endpoints (e.g.
    // `[...][...]` instead of a single valid JSON array).
    let reviews: GhReview[];
    try {
      const raw = execFileSync(
        'gh',
        ['api', '--paginate', '--jq', '.[]', `repos/${args.owner}/${args.repo}/pulls/${pr}/reviews`],
        { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] },
      );
      const trimmed = raw.trim();
      if (trimmed.length === 0) {
        reviews = [];
      } else {
        // Each line is a JSON object; wrap into an array and parse
        reviews = JSON.parse(`[${trimmed.split('\n').join(',')}]`) as GhReview[];
      }
    } catch {
      results.push({ pr, state: 'API_ERROR', verdict: 'fail' });
      continue;
    }

    // Filter to CodeRabbit reviews
    const coderabbitReviews = reviews.filter(
      (r) => CODERABBIT_LOGINS.has(r.user.login),
    );

    if (coderabbitReviews.length === 0) {
      results.push({ pr, state: 'NONE', verdict: 'pass' });
      continue;
    }

    // Sort by submitted_at descending, take latest
    coderabbitReviews.sort(
      (a, b) => new Date(b.submitted_at).getTime() - new Date(a.submitted_at).getTime(),
    );
    const latest = coderabbitReviews[0];

    const verdict = latest.state === 'APPROVED' ? 'pass' : 'fail';
    results.push({ pr, state: latest.state, verdict });
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
