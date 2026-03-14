// ─── Review Verdict Composite Action ─────────────────────────────────────────
//
// Pure TypeScript review verdict computation — classifies review findings
// into a routing verdict (APPROVED / NEEDS_FIXES / BLOCKED) and generates
// a markdown report. No bash script dependency.
// ────────────────────────────────────────────────────────────────────────────

import type { ToolResult } from '../format.js';
import { getOrCreateEventStore } from '../views/tools.js';
import { emitGateEvent } from './gate-utils.js';

// ─── Argument & Result Types ────────────────────────────────────────────────

interface ReviewVerdictArgs {
  readonly featureId: string;
  readonly high: number;
  readonly medium: number;
  readonly low: number;
  readonly blockedReason?: string;
  readonly dimensionResults?: Record<string, { passed: boolean; findingCount: number }>;
}

interface ReviewVerdictResult {
  readonly verdict: 'APPROVED' | 'NEEDS_FIXES' | 'BLOCKED';
  readonly high: number;
  readonly medium: number;
  readonly low: number;
  readonly blockedReason?: string;
  readonly report: string;
}

// ─── Verdict Logic ──────────────────────────────────────────────────────────

/**
 * Compute the review verdict from finding counts.
 * Priority: BLOCKED > NEEDS_FIXES > APPROVED.
 *
 * - BLOCKED: blockedReason is provided
 * - NEEDS_FIXES: high > 0
 * - APPROVED: no HIGH-severity findings
 */
export function computeVerdict(args: {
  high: number;
  medium: number;
  low: number;
  blockedReason?: string;
}): 'APPROVED' | 'NEEDS_FIXES' | 'BLOCKED' {
  if (args.blockedReason) {
    return 'BLOCKED';
  }
  if (args.high > 0) {
    return 'NEEDS_FIXES';
  }
  return 'APPROVED';
}

// ─── Report Generation ──────────────────────────────────────────────────────

/**
 * Generate a markdown verdict report matching the bash script's output format.
 */
export function generateVerdictReport(
  verdict: 'APPROVED' | 'NEEDS_FIXES' | 'BLOCKED',
  args: { high: number; medium: number; low: number; blockedReason?: string },
): string {
  const lines: string[] = [];
  const total = args.high + args.medium + args.low;

  if (verdict === 'BLOCKED') {
    lines.push(
      '## Review Verdict: BLOCKED',
      '',
      `**Reason:** ${args.blockedReason ?? 'Unknown'}`,
      '',
      'Return to design phase. Route to `/ideate --redesign`.',
    );
  } else if (verdict === 'NEEDS_FIXES') {
    lines.push(
      '## Review Verdict: NEEDS_FIXES',
      '',
      `Found ${args.high} HIGH-severity findings. Route to \`/delegate --fixes\`.`,
      '',
      `**Finding summary:** ${args.high} high, ${args.medium} medium, ${args.low} low (${total} total)`,
    );
  } else {
    lines.push(
      '## Review Verdict: APPROVED',
      '',
      'No HIGH-severity findings. Proceed to synthesis.',
      '',
      `**Finding summary:** ${args.high} high, ${args.medium} medium, ${args.low} low (${total} total)`,
    );
  }

  return lines.join('\n');
}

// ─── Handler ───────────────────────────────────────────────────────────────

export async function handleReviewVerdict(
  args: ReviewVerdictArgs,
  stateDir: string,
): Promise<ToolResult> {
  // Input validation
  if (!args.featureId) {
    return {
      success: false,
      error: { code: 'INVALID_INPUT', message: 'featureId is required' },
    };
  }

  if (
    !Number.isFinite(args.high) || args.high < 0
    || !Number.isFinite(args.medium) || args.medium < 0
    || !Number.isFinite(args.low) || args.low < 0
  ) {
    return {
      success: false,
      error: { code: 'INVALID_INPUT', message: 'high, medium, and low must be non-negative finite numbers' },
    };
  }

  // Compute verdict in pure TypeScript
  const verdict = computeVerdict(args);
  const report = generateVerdictReport(verdict, args);

  const result: ReviewVerdictResult = {
    verdict,
    high: args.high,
    medium: args.medium,
    low: args.low,
    ...(args.blockedReason ? { blockedReason: args.blockedReason } : {}),
    report,
  };

  // Emit per-dimension gate events (fire-and-forget)
  if (args.dimensionResults) {
    for (const [key, entry] of Object.entries(args.dimensionResults)) {
      try {
        const store = getOrCreateEventStore(stateDir);
        await emitGateEvent(store, args.featureId, `review-${key}`, 'review', entry.passed, {
          dimension: key,
          phase: 'review',
          findingCount: entry.findingCount,
        });
      } catch { /* fire-and-forget */ }
    }
  }

  // Emit summary gate event (fire-and-forget)
  try {
    const store = getOrCreateEventStore(stateDir);
    await emitGateEvent(store, args.featureId, 'review-verdict', 'review', verdict === 'APPROVED', {
      verdict,
      phase: 'review',
      high: args.high,
      medium: args.medium,
      low: args.low,
    });
  } catch { /* fire-and-forget */ }

  return { success: true, data: result };
}
