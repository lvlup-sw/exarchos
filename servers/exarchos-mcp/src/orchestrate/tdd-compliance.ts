// ─── TDD Compliance Orchestrate Action ────────────────────────────────────────
//
// Wraps scripts/check-tdd-compliance.sh as a composite orchestrate action,
// emitting a gate.executed event for per-task TDD compliance gating.
// ────────────────────────────────────────────────────────────────────────────

import { execFileSync } from 'node:child_process';
import type { ToolResult } from '../format.js';
import { getOrCreateEventStore } from '../views/tools.js';
import { emitGateEvent } from './gate-utils.js';

// ─── Types ──────────────────────────────────────────────────────────────────

interface TddComplianceArgs {
  readonly featureId: string;
  readonly taskId: string;
  readonly branch: string;
  readonly baseBranch?: string;
}

interface ComplianceCounts {
  readonly passCount: number;
  readonly failCount: number;
  readonly total: number;
}

// ─── Report Parsing ─────────────────────────────────────────────────────────

function parseComplianceCounts(report: string): ComplianceCounts {
  // Match "**Result: PASS** (N/M commits compliant)" or "**Result: FAIL** (N/M commits have violations)"
  const passMatch = report.match(/Result: PASS\*{0,2}\s+\((\d+)\/(\d+)\s+commits compliant\)/);
  if (passMatch) {
    const passCount = parseInt(passMatch[1], 10);
    const total = parseInt(passMatch[2], 10);
    return { passCount, failCount: 0, total };
  }

  const failMatch = report.match(/Result: FAIL\*{0,2}\s+\((\d+)\/(\d+)\s+commits have violations\)/);
  if (failMatch) {
    const failCount = parseInt(failMatch[1], 10);
    const total = parseInt(failMatch[2], 10);
    const passCount = total - failCount;
    return { passCount, failCount, total };
  }

  // No commits case or unparseable
  return { passCount: 0, failCount: 0, total: 0 };
}

// ─── Handler ────────────────────────────────────────────────────────────────

export async function handleTddCompliance(
  args: TddComplianceArgs,
  stateDir: string,
): Promise<ToolResult> {
  // Validate required args
  if (!args.featureId) {
    return {
      success: false,
      error: { code: 'INVALID_INPUT', message: 'featureId is required' },
    };
  }

  if (!args.taskId) {
    return {
      success: false,
      error: { code: 'INVALID_INPUT', message: 'taskId is required' },
    };
  }

  if (!args.branch) {
    return {
      success: false,
      error: { code: 'INVALID_INPUT', message: 'branch is required' },
    };
  }

  const repoRoot = process.cwd();
  const baseBranch = args.baseBranch || 'main';
  const scriptArgs = [
    '--repo-root', repoRoot,
    '--branch', args.branch,
    '--base-branch', baseBranch,
  ];

  let report: string;
  let passed: boolean;

  try {
    const output = execFileSync(
      'scripts/check-tdd-compliance.sh',
      scriptArgs,
      { timeout: 60_000, stdio: ['pipe', 'pipe', 'pipe'] },
    );
    report = Buffer.isBuffer(output) ? output.toString('utf-8') : String(output);
    passed = true;
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
          code: 'TDD_CHECK_ERROR',
          message: err instanceof Error ? err.message : String(err),
        },
      };
    }

    // Exit code 1 = violations found (not an error, just a fail result)
    if (execError.status === 1) {
      report = execError.stdout instanceof Buffer
        ? execError.stdout.toString('utf-8')
        : String(execError.stdout ?? '');
      passed = false;
    } else {
      // Exit code 2 or other = usage/unexpected error
      return {
        success: false,
        error: {
          code: 'TDD_CHECK_ERROR',
          message: err instanceof Error ? err.message : String(err),
        },
      };
    }
  }

  // Parse compliance counts from report
  const counts = parseComplianceCounts(report);

  // Emit gate.executed event (fire-and-forget: emission failure must not break the gate check)
  try {
    const store = getOrCreateEventStore(stateDir);
    await emitGateEvent(store, args.featureId, 'tdd-compliance', 'testing', passed, {
      dimension: 'D1',
      phase: 'delegate',
      taskId: args.taskId,
      branch: args.branch,
      passCount: counts.passCount,
      failCount: counts.failCount,
      totalCommits: counts.total,
    });
  } catch { /* fire-and-forget */ }

  return {
    success: true,
    data: {
      passed,
      taskId: args.taskId,
      branch: args.branch,
      compliance: counts,
      report,
    },
  };
}
