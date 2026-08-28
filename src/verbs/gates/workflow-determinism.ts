// ─── Workflow Determinism Gate ────────────────────────────────────────────────
//
// Orchestrates workflow determinism checking by calling the pure TypeScript
// checkWorkflowDeterminism function and emitting gate.executed events for
// quality-layer gate checks.
// ─────────────────────────────────────────────────────────────────────────────

import type { ToolResult } from '../../format.js';
import type { EventStore } from '../../events/store.js';
import { createEvidenceSubject } from '../../workflow/admission/evidence-subject.js';
import { runPhaseGateWithEvidence } from './gate-runner.js';
import { emitGateEvent, getDiff, sameOperationGateKey } from './gate-utils.js';
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
}

// ─── Handler ───────────────────────────────────────────────────────────────

export async function handleWorkflowDeterminism(
  args: WorkflowDeterminismArgs,
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

  // Durable gate evidence is a declared postcondition here, and a bare
  // `gate.executed` append does not pay it — the observer reads
  // `admission.evidence-recorded`. The shared phase-gate runner records that
  // before any success carrier escapes; the declared signal is still minted by
  // the provider closure below.
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
    await emitGateEvent(
      store,
      args.featureId,
      'workflow-determinism',
      'quality',
      passed,
      {
        dimension: 'D5',
        phase: 'review',
        findingCount,
      },
      sameOperationGateKey('workflow-determinism'),
    );
  } catch { /* fire-and-forget */ }

  // Return structured result
  const result: WorkflowDeterminismResult = {
    passed,
    findingCount,
    report: tsResult.report,
  };

  return { success: true, data: result };
}
