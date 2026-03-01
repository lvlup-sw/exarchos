// ─── Review Verdict Composite Action ─────────────────────────────────────────
//
// Orchestrates review verdict computation by running the review-verdict.sh
// script and emitting gate.executed events for per-dimension results and
// the overall review verdict.
// ────────────────────────────────────────────────────────────────────────────

import { execFileSync } from 'node:child_process';
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
  readonly report: string;
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

  // Build script command
  const scriptArgs = [
    '--high', String(args.high),
    '--medium', String(args.medium),
    '--low', String(args.low),
  ];
  if (args.blockedReason) {
    scriptArgs.push('--blocked', args.blockedReason);
  }

  let stdout = '';
  let verdict: 'APPROVED' | 'NEEDS_FIXES' | 'BLOCKED' = 'APPROVED';

  try {
    const output = execFileSync(
      'scripts/review-verdict.sh',
      scriptArgs,
      { timeout: 30_000, stdio: ['pipe', 'pipe', 'pipe'] },
    );
    stdout = Buffer.isBuffer(output) ? output.toString('utf-8') : String(output);
    verdict = 'APPROVED';
  } catch (err: unknown) {
    const execError = err as {
      status?: number;
      stdout?: Buffer | string;
      stderr?: Buffer | string;
    };

    // Timeout or spawn errors have no status — treat as script error
    if (execError.status == null) {
      return {
        success: false,
        error: {
          code: 'SCRIPT_ERROR',
          message: err instanceof Error ? err.message : String(err),
        },
      };
    }

    stdout = execError.stdout instanceof Buffer
      ? execError.stdout.toString('utf-8')
      : String(execError.stdout ?? '');

    // Exit code 1 = NEEDS_FIXES
    if (execError.status === 1) {
      verdict = 'NEEDS_FIXES';
    } else {
      // Exit code 2 = BLOCKED (or script error)
      verdict = 'BLOCKED';
    }
  }

  const result: ReviewVerdictResult = {
    verdict,
    high: args.high,
    medium: args.medium,
    low: args.low,
    report: stdout,
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
