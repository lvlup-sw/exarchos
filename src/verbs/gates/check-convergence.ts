/**
 * The convergence gate. It folds the convergence view and computes convergence across the
 * dimensions. It returns pass or fail and records a meta gate event.
 */

import type { ToolResult } from '../../format.js';
import type { EventStore } from '../../events/store.js';
import { foldToTail } from '../../projections/fold-at-tail.js';
import { getOrCreateMaterializer } from '../../projections/views/tools.js';
import { ALL_DIMENSIONS, CONVERGENCE_VIEW } from '../../projections/views/convergence-view.js';
import type { ConvergenceViewState } from '../../projections/views/convergence-view.js';
import { createEvidenceSubject } from '../../workflow/admission/evidence-subject.js';
import { runPhaseGateWithEvidence } from './gate-runner.js';
import { requireGateEvent, sameOperationGateKey } from './gate-utils.js';

interface CheckConvergenceArgs {
  readonly featureId: string;
  readonly workflowId?: string;
  readonly phase?: string;
}

type DimensionSummary = Record<string, { converged: boolean; gateCount: number; lastChecked: string | null }>;

/**
 * Summarizes each dimension. When `phase` is set, only the gate results of that phase count. A
 * dimension converges when it has gate results and each one passed.
 */
function applyPhaseFilter(
  dimensions: ConvergenceViewState['dimensions'],
  phase?: string,
): DimensionSummary {
  const result: DimensionSummary = {};
  for (const [key, dim] of Object.entries(dimensions)) {
    const filteredResults = phase
      ? dim.gateResults.filter((r) => r.phase === phase)
      : dim.gateResults;
    const converged = filteredResults.length > 0 && filteredResults.every((r) => r.passed);
    result[key] = {
      converged,
      gateCount: filteredResults.length,
      lastChecked: dim.lastChecked,
    };
  }
  return result;
}

/**
 * Runs the convergence gate through the shared phase-gate runner. The gate declares durable
 * gate evidence as a postcondition, and the runner records it before a success carrier returns.
 */
export async function handleCheckConvergence(
  args: CheckConvergenceArgs,
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
    gateClass: 'convergence',
    requirementId: 'requirement:convergence',
    stateDir,
    eventStore,
    subject: (phaseAttemptId) =>
      createEvidenceSubject(
        { kind: 'phase-attempt', phaseAttemptId },
        { gate: 'convergence', phase: args.phase ?? null, workflowId: args.workflowId ?? null },
      ),
    providerInput: args,
    executeProvider: async () => executeCheckConvergence(args, stateDir, eventStore),
  });
}

/**
 * Computes the convergence verdict from a fold to the durable tail. `workflowId` changes only
 * the stream that the fold reads. The gate record stays on the subject stream, because the
 * action declares only that stream.
 */
async function executeCheckConvergence(
  args: CheckConvergenceArgs,
  stateDir: string,
  eventStore: EventStore,
): Promise<ToolResult> {
  const store = eventStore;
  const materializer = getOrCreateMaterializer(stateDir);
  const readStreamId = args.workflowId ?? args.featureId;

  const { view } = await foldToTail<ConvergenceViewState>(
    store,
    materializer,
    readStreamId,
    CONVERGENCE_VIEW,
  );

  const filteredDimensions = applyPhaseFilter(view.dimensions, args.phase);

  const uncheckedDimensions = ALL_DIMENSIONS.filter((d) => {
    const dim = filteredDimensions[d];
    return !dim || dim.gateCount === 0;
  });
  const overallConverged = ALL_DIMENSIONS.every((d) => {
    const dim = filteredDimensions[d];
    return dim && dim.gateCount > 0 && dim.converged;
  });
  const passed = overallConverged;

  const carrier: ToolResult = {
    success: true,
    data: {
      passed,
      overallConverged,
      uncheckedDimensions,
      dimensions: filteredDimensions,
    },
  };

  const unrecorded = await requireGateEvent(
    store,
    args.featureId,
    'convergence',
    'meta',
    passed,
    carrier,
    {
      phase: 'meta',
      ...(args.workflowId !== undefined && args.workflowId !== args.featureId
        ? { readStreamId }
        : {}),
      uncheckedDimensions,
      dimensionSummary: filteredDimensions,
    },
    sameOperationGateKey('convergence'),
  );
  if (unrecorded !== undefined) return unrecorded;

  return carrier;
}
