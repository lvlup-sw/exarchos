/**
 * The operational resilience gate. It runs `checkOperationalResilience` over
 * the branch diff through `runPhaseGateWithEvidence`. The runner records
 * durable gate evidence before a success result returns, and the provider
 * appends the quality-layer `gate.executed` event. If git cannot produce the
 * diff, the gate fails closed.
 */

import type { ToolResult } from '../../format.js';
import type { EventStore } from '../../events/store.js';
import { createEvidenceSubject } from '../../workflow/admission/evidence-subject.js';
import { runPhaseGateWithEvidence } from './gate-runner.js';
import { getDiff, requireGateEvent, sameOperationGateKey } from './gate-utils.js';
import { checkOperationalResilience } from '../pure/operational-resilience.js';

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

export async function handleOperationalResilience(
  args: OperationalResilienceArgs,
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
    gateClass: 'operational-resilience',
    requirementId: 'requirement:operational-resilience',
    stateDir,
    eventStore,
    subject: (phaseAttemptId) =>
      createEvidenceSubject(
        { kind: 'phase-attempt', phaseAttemptId },
        { gate: 'operational-resilience', phase: 'review' },
      ),
    providerInput: args,
    executeProvider: async () => executeOperationalResilience(args, eventStore),
  });
}

async function executeOperationalResilience(
  args: OperationalResilienceArgs,
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
  const tsResult = checkOperationalResilience(diff);

  const passed = tsResult.pass;
  const findingCount = tsResult.findingCount;

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

  const result: OperationalResilienceResult = {
    passed,
    findingCount,
    report,
  };
  const carrier: ToolResult = { success: true, data: result };

  const unrecorded = await requireGateEvent(
    eventStore,
    args.featureId,
    'operational-resilience',
    'quality',
    passed,
    carrier,
    {
      dimension: 'D4',
      phase: 'review',
      findingCount,
    },
    sameOperationGateKey('operational-resilience'),
  );
  if (unrecorded !== undefined) return unrecorded;

  return carrier;
}
