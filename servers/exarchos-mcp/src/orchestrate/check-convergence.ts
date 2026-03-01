// ─── Check Convergence Composite Action ─────────────────────────────────────
//
// Queries the ConvergenceView CQRS projection to compute overall convergence
// across D1-D5 dimensions. Returns a structured pass/fail result and emits
// a meta gate.executed event for traceability.
// ────────────────────────────────────────────────────────────────────────────

import type { ToolResult } from '../format.js';
import {
  getOrCreateEventStore,
  getOrCreateMaterializer,
  queryDeltaEvents,
} from '../views/tools.js';
import { CONVERGENCE_VIEW } from '../views/convergence-view.js';
import type { ConvergenceViewState } from '../views/convergence-view.js';
import { emitGateEvent } from './gate-utils.js';

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
): Promise<ToolResult> {
  // Guard clause: validate required inputs
  if (!args.featureId) {
    return {
      success: false,
      error: { code: 'INVALID_INPUT', message: 'featureId is required' },
    };
  }

  const store = getOrCreateEventStore(stateDir);
  const materializer = getOrCreateMaterializer(stateDir);
  const streamId = args.workflowId ?? args.featureId;

  // Materialize convergence view from gate.executed events
  const events = await queryDeltaEvents(store, materializer, streamId, CONVERGENCE_VIEW);
  const view = materializer.materialize<ConvergenceViewState>(
    streamId,
    CONVERGENCE_VIEW,
    events,
  );

  // Apply phase filter if specified — filter gate results per dimension
  const filteredDimensions = applyPhaseFilter(view.dimensions, args.phase);

  // Recompute convergence from filtered data
  const allDimensionKeys = ['D1', 'D2', 'D3', 'D4', 'D5'];
  const uncheckedDimensions = allDimensionKeys.filter((d) => {
    const dim = filteredDimensions[d];
    return !dim || dim.gateCount === 0;
  });
  const overallConverged = allDimensionKeys.every((d) => {
    const dim = filteredDimensions[d];
    return dim && dim.gateCount > 0 && dim.converged;
  });
  const passed = overallConverged;

  // Emit meta gate.executed event (fire-and-forget)
  try {
    await emitGateEvent(store, streamId, 'convergence', 'meta', passed, {
      phase: 'meta',
      uncheckedDimensions,
      dimensionSummary: filteredDimensions,
    });
  } catch { /* fire-and-forget */ }

  return {
    success: true,
    data: {
      passed,
      overallConverged,
      uncheckedDimensions,
      dimensions: filteredDimensions,
    },
  };
}
