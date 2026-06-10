// ─── TDD Compliance Gate ──────────────────────────────────────────────────────
//
// Orchestrates TDD compliance checking by calling the pure TypeScript
// checkTddCompliance function and emitting gate.executed events for
// per-task TDD compliance gating.
// ─────────────────────────────────────────────────────────────────────────────

import type { ToolResult } from '../format.js';
import type { EventStore } from '../event-store/store.js';
import { emitGateEvent } from './gate-utils.js';
import { resolveGateSeverity } from './gate-severity.js';
import { checkTddCompliance } from './pure/tdd-compliance.js';
import { DEFAULTS, type ResolvedProjectConfig } from '../config/resolve.js';

// ─── Types ──────────────────────────────────────────────────────────────────

interface TddComplianceArgs {
  readonly featureId: string;
  readonly taskId: string;
  readonly branch: string;
  readonly baseBranch?: string;
}

// ─── Handler ────────────────────────────────────────────────────────────────

export async function handleTddCompliance(
  args: TddComplianceArgs,
  stateDir: string,
  eventStore: EventStore,
  /**
   * Resolved project config used ONLY to determine this gate's severity
   * (verification-ladder slice 1: `tdd-compliance` is advisory by default).
   * Defaults to the built-in `DEFAULTS`, whose per-gate default for
   * `tdd-compliance` resolves to `warning` (advisory). A project that sets an
   * explicit `review.gates['tdd-compliance']` override still gets that
   * severity — the demotion only moves the DEFAULT.
   */
  config?: ResolvedProjectConfig,
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

  // Call pure TypeScript implementation
  const tsResult = checkTddCompliance({
    repoRoot,
    branch: args.branch,
    baseBranch,
  });

  // A 'warn' status (empty base..branch range — e.g. the task branch was
  // already merged into integration) is a NON-PASS advisory: passed stays
  // false so the gate does not read as a vacuous TDD pass (#1500).
  const passed = tsResult.status === 'pass';

  // Advisory reason for non-pass results that aren't true violations.
  const reason =
    tsResult.status === 'warn'
      ? `No commits between ${baseBranch} and ${args.branch} (already merged? check ordering) — TDD compliance could not be verified.`
      : undefined;

  // Verification-ladder slice 1: resolve this gate's severity. The per-gate
  // default (DEFAULTS.review.gates['tdd-compliance']) is advisory (warning); a
  // project override still wins. This is the only behavioral flip — the gate
  // logic, events, and report below are unchanged.
  const severity = resolveGateSeverity('tdd-compliance', 'D1', config ?? DEFAULTS);

  // Emit gate.executed event (fire-and-forget)
  try {
    const store = eventStore;
    await emitGateEvent(store, args.featureId, 'tdd-compliance', 'testing', passed, {
      dimension: 'D1',
      phase: 'delegate',
      taskId: args.taskId,
      branch: args.branch,
      severity,
      passCount: tsResult.passCount,
      failCount: tsResult.failCount,
      totalCommits: tsResult.commitsAnalyzed,
    });
  } catch { /* fire-and-forget */ }

  // INV-5b: this is an advisory carrier — success:true with data.passed
  // reflecting the gate outcome, NOT an error envelope. `status` and
  // `reason` surface why a non-pass result is advisory (e.g. 'warn');
  // `severity` surfaces the demoted-by-default blocking posture.
  return {
    success: true,
    data: {
      passed,
      status: tsResult.status,
      severity,
      ...(reason !== undefined ? { reason } : {}),
      taskId: args.taskId,
      branch: args.branch,
      compliance: {
        passCount: tsResult.passCount,
        failCount: tsResult.failCount,
        total: tsResult.commitsAnalyzed,
      },
      report: tsResult.report,
    },
  };
}
