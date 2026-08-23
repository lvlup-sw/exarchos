import { EventStore } from '../../../events/store.js';
import type { ToolResult } from '../../../format.js';
import { GATE_RELIABILITY_VIEW, type GateReliabilityViewState } from '../gate-reliability-view.js';
import { getOrCreateMaterializer } from './materializer.js';
import { queryDeltaEvents } from './query.js';

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

    const events = await queryDeltaEvents(store, materializer, streamId, GATE_RELIABILITY_VIEW);
    const view = materializer.materialize<GateReliabilityViewState>(
      streamId,
      GATE_RELIABILITY_VIEW,
      events,
    );

    if (args.detail) {
      return { success: true, data: view };
    }
    const { _foldEvents: _ignoredFoldEvents, ...publicView } = view;
    return { success: true, data: publicView };
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
