// ─── Post-Merge Gate Handler ────────────────────────────────────────────────
//
// Orchestrates the post-merge regression check (DR-4) at the
// synthesize → cleanup boundary. Wraps `scripts/check-post-merge.sh`,
// parses stdout report and stderr FINDING lines, and emits a
// gate.executed event for flywheel integration.
// ────────────────────────────────────────────────────────────────────────────

import { execFileSync } from 'node:child_process';
import type { ToolResult } from '../format.js';
import { getOrCreateEventStore } from '../views/tools.js';
import { emitGateEvent } from './gate-utils.js';

// ─── Types ─────────────────────────────────────────────────────────────────

interface PostMergeArgs {
  readonly featureId: string;
  readonly prUrl: string;
  readonly mergeSha: string;
}

interface PostMergeResult {
  readonly passed: boolean;
  readonly prUrl: string;
  readonly mergeSha: string;
  readonly findings: string[];
  readonly report: string;
}

// ─── FINDING Parser ────────────────────────────────────────────────────────

const FINDING_PATTERN = /^FINDING \[.+$/;

function parseFindings(stderr: string): string[] {
  return stderr
    .split('\n')
    .filter((line) => FINDING_PATTERN.test(line.trim()));
}

// ─── Handler ───────────────────────────────────────────────────────────────

export async function handlePostMerge(
  args: PostMergeArgs,
  stateDir: string,
): Promise<ToolResult> {
  // Guard clauses: validate all required inputs
  if (!args.featureId) {
    return {
      success: false,
      error: { code: 'INVALID_INPUT', message: 'featureId is required' },
    };
  }

  if (!args.prUrl) {
    return {
      success: false,
      error: { code: 'INVALID_INPUT', message: 'prUrl is required' },
    };
  }

  if (!args.mergeSha) {
    return {
      success: false,
      error: { code: 'INVALID_INPUT', message: 'mergeSha is required' },
    };
  }

  // Run the post-merge check script
  let report = '';
  let findings: string[] = [];
  let passed = false;
  let exitCode = 0;

  try {
    const output = execFileSync(
      'scripts/check-post-merge.sh',
      ['--pr-url', args.prUrl, '--merge-sha', args.mergeSha],
      {
        encoding: 'buffer',
        timeout: 120_000,
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );
    report = output.toString('utf-8');
    passed = true;
    exitCode = 0;
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

    exitCode = execError.status;

    // Exit code 2 = usage error — this is a script-level failure, not a gate result
    if (exitCode === 2) {
      const stderrText = execError.stderr instanceof Buffer
        ? execError.stderr.toString('utf-8')
        : '';
      return {
        success: false,
        error: {
          code: 'SCRIPT_ERROR',
          message: stderrText || 'check-post-merge.sh exited with usage error (exit 2)',
        },
      };
    }

    // Exit code 1 = findings detected — parse report and findings
    if (exitCode === 1) {
      report = execError.stdout instanceof Buffer
        ? execError.stdout.toString('utf-8')
        : '';
      const stderrText = execError.stderr instanceof Buffer
        ? execError.stderr.toString('utf-8')
        : '';
      findings = parseFindings(stderrText);
      passed = false;
    } else {
      // Exit code ≥3 = unexpected error — treat as script error
      return {
        success: false,
        error: {
          code: 'SCRIPT_ERROR',
          message: err instanceof Error ? err.message : String(err),
        },
      };
    }
  }

  // Emit gate.executed event for flywheel integration (fire-and-forget)
  try {
    const store = getOrCreateEventStore(stateDir);
    await emitGateEvent(store, args.featureId, 'post-merge', 'post-merge', passed, {
      dimension: 'D4',
      phase: 'synthesize',
      prUrl: args.prUrl,
      mergeSha: args.mergeSha,
      findings,
    });
  } catch { /* fire-and-forget: emission failure must not break the gate check */ }

  // Build result
  const data: PostMergeResult = {
    passed,
    prUrl: args.prUrl,
    mergeSha: args.mergeSha,
    findings,
    report,
  };

  return { success: true, data };
}
