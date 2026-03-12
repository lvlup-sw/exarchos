// ─── Check PR Comments ──────────────────────────────────────────────────────
//
// Analyzes PR review comment threads via `gh api` to detect unresolved
// discussions. A top-level comment is "unresolved" if no reply exists.
// Ported from scripts/check-pr-comments.sh.
// ─────────────────────────────────────────────────────────────────────────────

import { execFileSync } from 'node:child_process';
import type { ToolResult } from '../format.js';

// ─── Types ─────────────────────────────────────────────────────────────────

export interface CheckPrCommentsArgs {
  readonly pr: number;
  readonly repo?: string; // defaults to current repo via `gh repo view`
}

interface PrComment {
  readonly id: number;
  readonly in_reply_to_id: number | null;
  readonly user: { readonly login: string };
  readonly path: string;
  readonly line: number | null;
  readonly original_line: number | null;
  readonly body: string;
}

interface CheckPrCommentsResult {
  readonly passed: boolean;
  readonly totalComments: number;
  readonly unresolvedThreads: number;
  readonly report: string;
}

// ─── Handler ───────────────────────────────────────────────────────────────

export function handleCheckPrComments(args: CheckPrCommentsArgs): ToolResult {
  // Guard: validate PR number
  if (!args.pr) {
    return {
      success: false,
      error: { code: 'INVALID_INPUT', message: 'pr number is required' },
    };
  }

  // Resolve repo
  const repo = args.repo ?? detectRepo();
  if (!repo) {
    return {
      success: false,
      error: { code: 'REPO_DETECTION_ERROR', message: 'Could not detect repository. Provide repo argument.' },
    };
  }

  // Fetch comments via gh api
  let comments: PrComment[];
  try {
    const raw = execFileSync('gh', ['api', `repos/${repo}/pulls/${args.pr}/comments`, '--paginate'], {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    comments = JSON.parse(raw) as PrComment[];
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      success: false,
      error: { code: 'GH_API_ERROR', message: `Failed to fetch PR comments via gh api: ${message}` },
    };
  }

  // Analyze threads
  const topLevel = comments.filter((c) => c.in_reply_to_id === null);
  const repliedToIds = new Set(
    comments
      .filter((c) => c.in_reply_to_id !== null)
      .map((c) => c.in_reply_to_id),
  );

  const unaddressed = topLevel.filter((c) => !repliedToIds.has(c.id));
  const unresolvedThreads = unaddressed.length;
  const passed = unresolvedThreads === 0;

  // Build report
  const reportLines: string[] = [];
  reportLines.push(`## PR #${args.pr} Comment Status`);
  reportLines.push('');
  reportLines.push(`Top-level comments: ${topLevel.length}`);
  reportLines.push(`With replies: ${topLevel.length - unresolvedThreads}`);
  reportLines.push(`Unaddressed: ${unresolvedThreads}`);

  if (passed) {
    reportLines.push('');
    reportLines.push('**Result: PASS** — all comments addressed');
  } else {
    reportLines.push('');
    reportLines.push('### Unaddressed Comments');
    for (const c of unaddressed) {
      const lineNum = c.line ?? c.original_line ?? '?';
      const bodyPreview = c.body.split('\n')[0].slice(0, 100);
      reportLines.push(`- [${c.user.login}] ${c.path}:${lineNum}: ${bodyPreview}`);
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

// ─── Helpers ───────────────────────────────────────────────────────────────

function detectRepo(): string | null {
  try {
    const raw = execFileSync('gh', ['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner'], {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return raw.trim() || null;
  } catch {
    return null;
  }
}
