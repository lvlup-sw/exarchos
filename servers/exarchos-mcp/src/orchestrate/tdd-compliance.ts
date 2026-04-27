// ─── TDD Compliance Gate ──────────────────────────────────────────────────────
//
// Orchestrates TDD compliance checking by calling the pure TypeScript
// checkTddCompliance function and emitting gate.executed events for
// per-task TDD compliance gating.
// ─────────────────────────────────────────────────────────────────────────────

import type { ToolResult } from '../format.js';
import type { EventStore } from '../event-store/store.js';
import { emitGateEvent } from './gate-utils.js';
import { checkTddCompliance } from './pure/tdd-compliance.js';

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

  const passed = tsResult.status === 'pass';

  // Emit gate.executed event (fire-and-forget)
  try {
    const store = eventStore;
    await emitGateEvent(store, args.featureId, 'tdd-compliance', 'testing', passed, {
      dimension: 'D1',
      phase: 'delegate',
      taskId: args.taskId,
      branch: args.branch,
      passCount: tsResult.passCount,
      failCount: tsResult.failCount,
      totalCommits: tsResult.commitsAnalyzed,
    });
  } catch { /* fire-and-forget */ }

  return {
    success: true,
    data: {
      passed,
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
