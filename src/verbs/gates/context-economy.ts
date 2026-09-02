// ─── Context Economy Gate ────────────────────────────────────────────────────
//
// Orchestrates context-economy checking by calling the pure TypeScript
// checkContextEconomy function and emitting gate.executed events for
// quality-layer gate checks.
// ─────────────────────────────────────────────────────────────────────────────

import type { ToolResult } from '../../format.js';
import type { EventStore } from '../../events/store.js';
import { createEvidenceSubject } from '../../workflow/admission/evidence-subject.js';
import { runPhaseGateWithEvidence } from './gate-runner.js';
import { getDiff, requireGateEvent, sameOperationGateKey } from './gate-utils.js';
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

  // The gate declares durable gate evidence as a postcondition and paid it with
  // a bare `gate.executed` append, which is a different record on a different
  // axis — the observer reads `admission.evidence-recorded`. Routing the verdict
  // through the shared phase-gate runner records that evidence before any
  // success carrier escapes; the provider keeps minting its own declared
  // `gate.executed` row from inside the closure below.
  return runPhaseGateWithEvidence({
    streamId: args.featureId,
    gateClass: 'context-economy',
    requirementId: 'requirement:context-economy',
    stateDir,
    eventStore,
    subject: (phaseAttemptId) =>
      createEvidenceSubject(
        { kind: 'phase-attempt', phaseAttemptId },
        { gate: 'context-economy', phase: 'review' },
      ),
    providerInput: args,
    executeProvider: async () => executeContextEconomy(args, stateDir, eventStore),
  });
}

async function executeContextEconomy(
  args: ContextEconomyArgs,
  stateDir: string,
  eventStore: EventStore,
): Promise<ToolResult> {
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

  // Query runtime metrics via telemetry query abstraction (graceful degradation on failure)
  const runtimeMetrics = await queryRuntimeMetrics(store, stateDir);

  // Return structured result
  const result: ContextEconomyResult = {
    passed,
    findingCount,
    report,
    runtimeMetrics,
  };
  const carrier: ToolResult = { success: true, data: result };

  const unrecorded = await requireGateEvent(
    store,
    args.featureId,
    'context-economy',
    'quality',
    passed,
    carrier,
    {
      dimension: 'D3',
      phase: 'review',
      findingCount,
    },
    sameOperationGateKey('context-economy'),
  );
  if (unrecorded !== undefined) return unrecorded;

  return carrier;
}
