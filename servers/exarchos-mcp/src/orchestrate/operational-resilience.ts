// ─── Operational Resilience Gate ──────────────────────────────────────────────
//
// Orchestrates operational resilience checking by calling the pure TypeScript
// checkOperationalResilience function and emitting gate.executed events for
// quality-layer gate checks.
// ─────────────────────────────────────────────────────────────────────────────

import type { ToolResult } from '../format.js';
import type { EventStore } from '../event-store/store.js';
import { emitGateEvent, getDiff } from './gate-utils.js';
import { checkOperationalResilience } from './pure/operational-resilience.js';

// ─── Types ─────────────────────────────────────────────────────────────────

interface OperationalResilienceArgs {
  readonly featureId: string;
  readonly repoRoot?: string;
  readonly baseBranch?: string;
}

interface OperationalResilienceResult {
  readonly passed: boolean;
  readonly findingCount: number;
  readonly report: string;
}

// ─── Handler ───────────────────────────────────────────────────────────────

export async function handleOperationalResilience(
  args: OperationalResilienceArgs,
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
  const tsResult = checkOperationalResilience(diff);

  const passed = tsResult.pass;
  const findingCount = tsResult.findingCount;

  // Build report from structured result
  const reportLines: string[] = [];
  if (findingCount > 0) {
    for (const f of tsResult.findings) {
      reportLines.push(`- **${f.severity}**: ${f.message}`);
    }
    reportLines.push('');
    reportLines.push(`Result: FINDINGS (${findingCount} findings detected)`);
  } else {
    reportLines.push('Result: PASS (all operational resilience checks passed)');
  }
  const report = reportLines.join('\n');

  // Emit gate.executed event (fire-and-forget)
  try {
    const store = eventStore;
    await emitGateEvent(store, args.featureId, 'operational-resilience', 'quality', passed, {
      dimension: 'D4',
      phase: 'review',
      findingCount,
    });
  } catch { /* fire-and-forget */ }

  // Return structured result
  const result: OperationalResilienceResult = {
    passed,
    findingCount,
    report,
  };

  return { success: true, data: result };
}
