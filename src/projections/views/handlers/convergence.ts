import { EventStore } from '../../../events/store.js';
import type { ToolResult } from '../../../format.js';
import { CONVERGENCE_VIEW, type ConvergenceViewState } from '../convergence-view.js';
import { getOrCreateMaterializer } from './materializer.js';
import { queryDeltaEvents } from './query.js';
import { readWorkflowStateJson } from './streams.js';

// ─── View Convergence Handler ──────────────────────────────────────────────

export async function handleViewConvergence(
  args: {
    workflowId?: string;
    // DR-8 (Task 024) — compact-by-default drops each dimension's per-gate
    // `gateResults` array; `detail: true` restores the gate-level detail.
    detail?: boolean;
  },
  stateDir: string,
  eventStore: EventStore,
): Promise<ToolResult> {
  try {
    const store = eventStore;
    const materializer = getOrCreateMaterializer(stateDir);
    const streamId = args.workflowId ?? 'default';

    const events = await queryDeltaEvents(store, materializer, streamId, CONVERGENCE_VIEW);
    const view = materializer.materialize<ConvergenceViewState>(
      streamId,
      CONVERGENCE_VIEW,
      events,
    );

    // Fix 2 (#1184) — when `gate.executed` events don't cover all dimensions,
    // fall back to `state.reviews.findingsByDimension`. The reviewer stamps
    // findings into state.json via `workflow set` even when the gate harness
    // didn't run, so an unchecked dimension here may still have ground-truth
    // data that should mark it as covered. We don't synthesize gate results
    // (we lack pass/fail timestamps), but we DO remove the dimension from
    // `uncheckedDimensions` so consumers stop blocking on a phantom gap.
    const state = await readWorkflowStateJson(stateDir, streamId);
    const reviews = state?.['reviews'];
    const findingsByDimension =
      reviews && typeof reviews === 'object' && !Array.isArray(reviews)
        ? (reviews as Record<string, unknown>)['findingsByDimension']
        : undefined;
    let effectiveView: ConvergenceViewState = view;
    if (
      findingsByDimension &&
      typeof findingsByDimension === 'object' &&
      !Array.isArray(findingsByDimension) &&
      view.uncheckedDimensions.length > 0
    ) {
      const covered = new Set(Object.keys(findingsByDimension as Record<string, unknown>));
      const remaining = view.uncheckedDimensions.filter((d) => !covered.has(d));
      if (remaining.length !== view.uncheckedDimensions.length) {
        effectiveView = { ...view, uncheckedDimensions: remaining };
      }
    }

    // DR-8 (Task 024) compact-by-default — drop each dimension's per-gate
    // `gateResults` array; the `converged` / `lastChecked` headline +
    // `uncheckedDimensions` stay. `detail: true` restores the gate-level detail.
    if (args.detail) {
      return { success: true, data: effectiveView };
    }
    const dimensions: Record<string, unknown> = {};
    for (const [name, dim] of Object.entries(effectiveView.dimensions)) {
      const { gateResults: _gateResults, ...rest } = dim;
      dimensions[name] = rest;
    }
    return { success: true, data: { ...effectiveView, dimensions } };
  } catch (err) {
    return {
      success: false,
      error: {
        code: 'VIEW_ERROR',
        message: err instanceof Error ? err.message : String(err),
      },
    };
  }
}
