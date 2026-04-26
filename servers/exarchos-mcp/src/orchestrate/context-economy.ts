// ─── Context Economy Gate ────────────────────────────────────────────────────
//
// Orchestrates context-economy checking by calling the pure TypeScript
// checkContextEconomy function and emitting gate.executed events for
// quality-layer gate checks.
// ─────────────────────────────────────────────────────────────────────────────

import type { ToolResult } from '../format.js';
import type { EventStore } from '../event-store/store.js';
import { emitGateEvent, getDiff } from './gate-utils.js';
import { checkContextEconomy } from './pure/context-economy.js';
import { queryRuntimeMetrics } from '../telemetry/telemetry-queries.js';
import type { RuntimeMetrics } from '../telemetry/telemetry-queries.js';

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
  const baseBranch = args.baseBranch || 'main';

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
    await emitGateEvent(store, args.featureId, 'context-economy', 'quality', passed, {
      dimension: 'D3',
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
