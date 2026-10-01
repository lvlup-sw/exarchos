import { EventStore } from '../../../events/store.js';
import { toViewFailure } from '../../degraded-result.js';
import type { ToolResult } from '../../../format.js';
import { GATE_RELIABILITY_VIEW, type GateReliabilityViewState } from '../gate-reliability-view.js';
import { getOrCreateMaterializer } from './materializer.js';
import { foldToTail } from '../../fold-at-tail.js';

/**
 * Handles the `gate_reliability` view. The view is diagnostic only, with no admission or
 * transition authority. The response omits `_foldEvents` unless `detail` is true.
 */
export async function handleViewGateReliability(
  args: {
    workflowId?: string;
    /** Restores the raw fold inputs retained for arrival-order recomputation. */
    detail?: boolean;
  },
  stateDir: string,
  eventStore: EventStore,
): Promise<ToolResult> {
  try {
    const store = eventStore;
    const materializer = getOrCreateMaterializer(stateDir);
    const streamId = args.workflowId ?? 'default';

    const { view } = await foldToTail<GateReliabilityViewState>(store, materializer, streamId, GATE_RELIABILITY_VIEW);

    if (args.detail) {
      return { success: true, data: view };
    }
    const { _foldEvents: _ignoredFoldEvents, ...publicView } = view;
    return { success: true, data: publicView };
  } catch (err) {
    return toViewFailure(err, { tool: 'exarchos_view', action: 'gate_reliability' });
  }
}
