/**
 * The workflow determinism gate. It runs `checkWorkflowDeterminism` over the
 * branch diff through `runPhaseGateWithEvidence`. The runner records durable
 * gate evidence before a success result returns, and the provider appends the
 * quality-layer `gate.executed` event. If git cannot produce the diff, the
 * gate fails closed.
 */

import type { ToolResult } from '../../format.js';
import type { EventStore } from '../../events/store.js';
import { createEvidenceSubject } from '../../workflow/admission/evidence-subject.js';
import { runPhaseGateWithEvidence } from './gate-runner.js';
import { getDiff, requireGateEvent, sameOperationGateKey } from './gate-utils.js';
import { checkWorkflowDeterminism } from '../pure/workflow-determinism.js';

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

export async function handleWorkflowDeterminism(
  args: WorkflowDeterminismArgs,
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
    gateClass: 'workflow-determinism',
    requirementId: 'requirement:workflow-determinism',
    stateDir,
    eventStore,
    subject: (phaseAttemptId) =>
      createEvidenceSubject(
        { kind: 'phase-attempt', phaseAttemptId },
        { gate: 'workflow-determinism', phase: 'review' },
      ),
    providerInput: args,
    executeProvider: async () => executeWorkflowDeterminism(args, eventStore),
  });
}

async function executeWorkflowDeterminism(
  args: WorkflowDeterminismArgs,
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
  const tsResult = checkWorkflowDeterminism({ diffContent: diff });

  const passed = tsResult.status === 'pass';
  const findingCount = tsResult.findingCount;

  const result: WorkflowDeterminismResult = {
    passed,
    findingCount,
    report: tsResult.report,
  };
  const carrier: ToolResult = { success: true, data: result };

  const unrecorded = await requireGateEvent(
    eventStore,
    args.featureId,
    'workflow-determinism',
    'quality',
    passed,
    carrier,
    {
      dimension: 'D5',
      phase: 'review',
      findingCount,
    },
    sameOperationGateKey('workflow-determinism'),
  );
  if (unrecorded !== undefined) return unrecorded;

  return carrier;
}
