import { EventStore } from '../../../events/store.js';
import { toViewFailure } from '../../degraded-result.js';
import type { ToolResult } from '../../../format.js';
import { GATE_RELIABILITY_VIEW, type GateReliabilityViewState } from '../gate-reliability-view.js';
import { getOrCreateMaterializer } from './materializer.js';
import { foldToTail } from '../../fold-at-tail.js';

// ─── View Gate Reliability Handler ─────────────────────────────────────────
//
// BASE-002 (structural-closure Wave 0): the gate-reliability read model is a
// production view action, not a dead module. It stays diagnostic-only — no
// admission or transition authority — but it is now reachable through the
// registered `gate_reliability` action and folded through the same production
// materializer as every other projection.

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
