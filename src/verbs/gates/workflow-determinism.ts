// ─── Workflow Determinism Gate ────────────────────────────────────────────────
//
// Orchestrates workflow determinism checking by calling the pure TypeScript
// checkWorkflowDeterminism function and emitting gate.executed events for
// quality-layer gate checks.
// ─────────────────────────────────────────────────────────────────────────────

import type { ToolResult } from '../../format.js';
import type { EventStore } from '../../events/store.js';
import { emitGateEvent, getDiff } from './gate-utils.js';
import { BASE_BRANCH_UNRESOLVED, resolveDiffBase } from '../../vcs/resolve-base-branch.js';
import { checkWorkflowDeterminism } from '../pure/workflow-determinism.js';

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
  /** Present only on the inconclusive carrier below. */
  readonly skipped?: true;
  readonly discriminant?: string;
  readonly reason?: string;
}

const GATE_NAME = 'workflow-determinism';
const GATE_LAYER = 'quality';
const GATE_DIMENSION = 'D5';

/** Record the unscoped run. Fire-and-forget, matching the conclusive path. */
async function emitUnscoped(
  store: EventStore,
  featureId: string,
  reason: string,
): Promise<void> {
  try {
    await emitGateEvent(store, featureId, GATE_NAME, GATE_LAYER, false, {
      dimension: GATE_DIMENSION,
      phase: 'review',
      findingCount: 0,
      skipped: true,
      discriminant: BASE_BRANCH_UNRESOLVED,
      reason,
    });
  } catch { /* fire-and-forget */ }
}

// ─── Handler ───────────────────────────────────────────────────────────────

export async function handleWorkflowDeterminism(
  args: WorkflowDeterminismArgs,
  _stateDir: string,
  eventStore: EventStore,
): Promise<ToolResult> {
  // Guard clause: validate required inputs
  if (!args.featureId) {
    return {
      success: false,
      error: { code: 'INVALID_INPUT', message: 'featureId is required' },
    };
  }

  const repoRoot = args.repoRoot || process.cwd();

  // No detected default branch means no diff to judge — report that, rather
  // than judging a diff against a branch the repository may not have.
  const base = await resolveDiffBase(repoRoot, args.baseBranch);
  if (base.kind === 'unresolved') {
    const inconclusive: WorkflowDeterminismResult = {
      passed: false,
      findingCount: 0,
      report: base.reason,
      skipped: true,
      discriminant: BASE_BRANCH_UNRESOLVED,
      reason: base.reason,
    };
    // Indeterminate is a VERDICT, so it is recorded like one. This action
    // declares `gate.executed` unconditionally; returning success without it
    // would leave the declaration and the handler saying different things, and
    // it would leave the durable log unable to tell "could not be scoped" from
    // "never invoked". The row is fail-closed (`passed: false`) and carries the
    // skip markers, so no reader mistakes it for a gate that ran.
    await emitUnscoped(eventStore, args.featureId, base.reason);
    return { success: true, data: inconclusive };
  }
  const baseBranch = base.branch;

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
    const store = eventStore;
    await emitGateEvent(store, args.featureId, GATE_NAME, GATE_LAYER, passed, {
      dimension: GATE_DIMENSION,
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
