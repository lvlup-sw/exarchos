/**
 * The context-economy gate. It runs the pure `checkContextEconomy` check over the branch diff and records a quality-layer `gate.executed` event.
 */

import type { ToolResult } from '../../format.js';
import type { EventStore } from '../../events/store.js';
import { createEvidenceSubject } from '../../workflow/admission/evidence-subject.js';
import { runPhaseGateWithEvidence } from './gate-runner.js';
import { getDiff, requireGateEvent, sameOperationGateKey } from './gate-utils.js';
import { checkContextEconomy } from '../pure/context-economy.js';
import { queryRuntimeMetrics } from '../../projections/telemetry/telemetry-queries.js';
import type { RuntimeMetrics } from '../../projections/telemetry/telemetry-queries.js';

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

/**
 * Runs the gate through the shared phase-gate runner, which records the durable gate evidence before a success result returns.
 * The postcondition observer reads that evidence as `admission.evidence-recorded`. The provider still appends its own `gate.executed` row.
 */
export async function handleContextEconomy(
  args: ContextEconomyArgs,
  stateDir: string,
  eventStore: EventStore,
): Promise<ToolResult> {
  if (!args.featureId) {
    return {
      success: false,
      error: { code: 'INVALID_INPUT', message: 'featureId is required' },
    };
  }

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

/**
 * Checks the diff against `baseBranch` and builds the report. If git cannot give a diff, the gate fails closed.
 */
async function executeContextEconomy(
  args: ContextEconomyArgs,
  stateDir: string,
  eventStore: EventStore,
): Promise<ToolResult> {
  const repoRoot = args.repoRoot || process.cwd();
  const baseBranch = args.baseBranch || 'main';

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

  const runtimeMetrics = await queryRuntimeMetrics(store, stateDir);

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
