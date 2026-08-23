// ─── Context Economy Gate ────────────────────────────────────────────────────
//
// Orchestrates context-economy checking by calling the pure TypeScript
// checkContextEconomy function and emitting gate.executed events for
// quality-layer gate checks.
// ─────────────────────────────────────────────────────────────────────────────

import type { ToolResult } from '../../format.js';
import type { EventStore } from '../../events/store.js';
import { emitGateEvent, getDiff } from './gate-utils.js';
import { BASE_BRANCH_UNRESOLVED, resolveDiffBase } from '../../vcs/resolve-base-branch.js';
import { checkContextEconomy } from '../pure/context-economy.js';
import { queryRuntimeMetrics } from '../../projections/telemetry/telemetry-queries.js';
import type { RuntimeMetrics } from '../../projections/telemetry/telemetry-queries.js';

// ─── Types ─────────────────────────────────────────────────────────────────

interface ContextEconomyArgs {
  readonly featureId: string;
  readonly repoRoot?: string;
  readonly baseBranch?: string;
}

interface ContextEconomyResult {
  readonly passed: boolean;
  readonly findingCount: number;
  readonly report: string;
  readonly runtimeMetrics?: RuntimeMetrics;
  /** Present only on the inconclusive carrier below. */
  readonly skipped?: true;
  readonly discriminant?: string;
  readonly reason?: string;
}

const GATE_NAME = 'context-economy';
const GATE_LAYER = 'quality';
const GATE_DIMENSION = 'D3';

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

export async function handleContextEconomy(
  args: ContextEconomyArgs,
  stateDir: string,
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

  // A diff needs two ends. Without a detected default branch this gate has one,
  // and the honest report is that it could not scope its subject — an advisory
  // carrier that normalizes to indeterminate, never a diff against a branch the
  // repository may not have and never a silent pass.
  const base = await resolveDiffBase(repoRoot, args.baseBranch);
  if (base.kind === 'unresolved') {
    const inconclusive: ContextEconomyResult = {
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
  const tsResult = checkContextEconomy(diff);

  const passed = tsResult.pass;
  const findingCount = tsResult.findings.length;

  // Build report from structured result
  const reportLines: string[] = [];
  if (findingCount > 0) {
    for (const f of tsResult.findings) {
      reportLines.push(`- **${f.severity}**: ${f.message}`);
    }
    reportLines.push('');
    reportLines.push(`Result: FINDINGS (${findingCount} findings detected)`);
  } else {
    reportLines.push(`Result: PASS (${tsResult.checksPassed}/${tsResult.checksRun} checks passed)`);
  }
  const report = reportLines.join('\n');

  const store = eventStore;

  // Emit gate.executed event (fire-and-forget)
  try {
    await emitGateEvent(store, args.featureId, GATE_NAME, GATE_LAYER, passed, {
      dimension: GATE_DIMENSION,
      phase: 'review',
      findingCount,
    });
  } catch { /* fire-and-forget */ }

  // Query runtime metrics via telemetry query abstraction (graceful degradation on failure)
  const runtimeMetrics = await queryRuntimeMetrics(store, stateDir);

  // Return structured result
  const result: ContextEconomyResult = {
    passed,
    findingCount,
    report,
    runtimeMetrics,
  };

  return { success: true, data: result };
}
