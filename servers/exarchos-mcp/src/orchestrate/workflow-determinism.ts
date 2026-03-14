// ─── Workflow Determinism Gate ────────────────────────────────────────────────
//
// Orchestrates workflow determinism checking by calling the pure TypeScript
// checkWorkflowDeterminism function and emitting gate.executed events for
// quality-layer gate checks.
// ─────────────────────────────────────────────────────────────────────────────

import type { ToolResult } from '../format.js';
import { getOrCreateEventStore } from '../views/tools.js';
import { emitGateEvent, getDiff } from './gate-utils.js';
import { checkWorkflowDeterminism } from './pure/workflow-determinism.js';

// ─── Types ─────────────────────────────────────────────────────────────────

interface WorkflowDeterminismArgs {
  readonly featureId: string;
  readonly repoRoot?: string;
  readonly baseBranch?: string;
}

interface WorkflowDeterminismResult {
  readonly passed: boolean;
  readonly findingCount: number;
  readonly report: string;
}

// ─── Handler ───────────────────────────────────────────────────────────────

export async function handleWorkflowDeterminism(
  args: WorkflowDeterminismArgs,
  stateDir: string,
): Promise<ToolResult> {
  // Guard clause: validate required inputs
  if (!args.featureId) {
    return {
      success: false,
      error: { code: 'INVALID_INPUT', message: 'featureId is required' },
    };
  }

  const repoRoot = args.repoRoot || process.cwd();
  const baseBranch = args.baseBranch || 'main';

  // Get the diff — fail-closed if git is unavailable
  const diff = getDiff(repoRoot, baseBranch);
  if (diff === null) {
    return {
      success: false,
      error: { code: 'DIFF_ERROR', message: `Failed to get diff from git in ${repoRoot}` },
    };
  }
  const tsResult = checkWorkflowDeterminism({ diffContent: diff });

  const passed = tsResult.status === 'pass';
  const findingCount = tsResult.findingCount;

  // Emit gate.executed event (fire-and-forget)
  try {
    const store = getOrCreateEventStore(stateDir);
    await emitGateEvent(store, args.featureId, 'workflow-determinism', 'quality', passed, {
      dimension: 'D5',
      phase: 'review',
      findingCount,
    });
  } catch { /* fire-and-forget */ }

  // Return structured result
  const result: WorkflowDeterminismResult = {
    passed,
    findingCount,
    report: tsResult.report,
  };

  return { success: true, data: result };
}
