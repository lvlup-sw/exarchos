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

  const passed = view.overallConverged;

  // Build compact dimension summary (gate counts, not full result arrays)
  const dimensions: Record<string, { converged: boolean; gateCount: number; lastChecked: string | null }> = {};
  for (const [key, dim] of Object.entries(view.dimensions)) {
    dimensions[key] = {
      converged: dim.converged,
      gateCount: dim.gateResults.length,
      lastChecked: dim.lastChecked,
    };
  }

  // Emit meta gate.executed event (fire-and-forget)
  try {
    await emitGateEvent(store, streamId, 'convergence', 'meta', passed, {
      phase: 'meta',
      uncheckedDimensions: view.uncheckedDimensions,
      dimensionSummary: dimensions,
    });
  } catch { /* fire-and-forget */ }

  return {
    success: true,
    data: {
      passed,
      overallConverged: view.overallConverged,
      uncheckedDimensions: view.uncheckedDimensions,
      dimensions,
    },
  };
}
