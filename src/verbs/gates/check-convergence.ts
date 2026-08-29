// ─── Check Convergence Composite Action ─────────────────────────────────────
//
// Queries the ConvergenceView CQRS projection to compute overall convergence
// across D1-D5 dimensions. Returns a structured pass/fail result and emits
// a meta gate.executed event for traceability.
// ────────────────────────────────────────────────────────────────────────────

import type { ToolResult } from '../../format.js';
import type { EventStore } from '../../events/store.js';
import { foldToTail } from '../../projections/fold-at-tail.js';
import { getOrCreateMaterializer } from '../../projections/views/tools.js';
import { ALL_DIMENSIONS, CONVERGENCE_VIEW } from '../../projections/views/convergence-view.js';
import type { ConvergenceViewState } from '../../projections/views/convergence-view.js';
import { createEvidenceSubject } from '../../workflow/admission/evidence-subject.js';
import { runPhaseGateWithEvidence } from './gate-runner.js';
import { requireGateEvent, sameOperationGateKey } from './gate-utils.js';

// ─── Types ─────────────────────────────────────────────────────────────────

interface CheckConvergenceArgs {
  readonly featureId: string;
  readonly workflowId?: string;
  readonly phase?: string;
}

// ─── Phase Filtering ─────────────────────────────────────────────────────

type DimensionSummary = Record<string, { converged: boolean; gateCount: number; lastChecked: string | null }>;

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

// ─── Handler ───────────────────────────────────────────────────────────────

export async function handleCheckConvergence(
  args: CheckConvergenceArgs,
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

  // The gate declares durable gate evidence as a postcondition, and a bare
  // `gate.executed` append never paid it: every caller that observes
  // postconditions — the dispatch path and the bounded intent executor alike —
  // read a success carrier that had broken its own contract. Routing through
  // the shared phase-gate runner records the evidence before any success
  // carrier escapes, the same way the sibling review gates do.
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

async function executeCheckConvergence(
  args: CheckConvergenceArgs,
  stateDir: string,
  eventStore: EventStore,
): Promise<ToolResult> {
  const store = eventStore;
  const materializer = getOrCreateMaterializer(stateDir);
  // `workflowId` re-points the READ at another stream; it never moved the
  // write, and treating it as if it did put the gate's own row on a stream the
  // action does not declare it touches. The verdict is folded from wherever
  // the caller asked; the record that this gate ran belongs on the subject.
  const readStreamId = args.workflowId ?? args.featureId;

  // Fold the convergence view over `gate.executed` up to the durable tail. A
  // reliability verdict derived from a fold that has not seen the latest gate
  // is worse than no verdict.
  const { view } = await foldToTail<ConvergenceViewState>(
    store,
    materializer,
    readStreamId,
    CONVERGENCE_VIEW,
  );

  // Apply phase filter if specified — filter gate results per dimension
  const filteredDimensions = applyPhaseFilter(view.dimensions, args.phase);

  // Recompute convergence from filtered data
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
