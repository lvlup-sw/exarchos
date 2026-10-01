import { EventStore } from '../../../events/store.js';
import { toViewFailure } from '../../degraded-result.js';
import type { ToolResult } from '../../../format.js';
import { CONVERGENCE_VIEW, type ConvergenceViewState } from '../convergence-view.js';
import { getOrCreateMaterializer } from './materializer.js';
import { foldToTail } from '../../fold-at-tail.js';
import { readWorkflowStateJson } from './streams.js';

/**
 * Returns the convergence view for a workflow.
 * The handler removes a dimension from `uncheckedDimensions` when `state.reviews.findingsByDimension` has an entry for it.
 * A reviewer can write those findings through `workflow set` with no gate run. The handler does not invent gate results for such a dimension.
 * By default, the result drops the `gateResults` array of each dimension. `detail: true` keeps it.
 */
export async function handleViewConvergence(
  args: {
    workflowId?: string;
    detail?: boolean;
  },
  stateDir: string,
  eventStore: EventStore,
): Promise<ToolResult> {
  try {
    const store = eventStore;
    const materializer = getOrCreateMaterializer(stateDir);
    const streamId = args.workflowId ?? 'default';

    const { view } = await foldToTail<ConvergenceViewState>(store, materializer, streamId, CONVERGENCE_VIEW);

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
    return toViewFailure(err, { tool: 'exarchos_view', action: 'convergence' });
  }
}
