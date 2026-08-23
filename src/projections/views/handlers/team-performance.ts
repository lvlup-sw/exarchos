import { EventStore } from '../../../events/store.js';
import type { ToolResult } from '../../../format.js';
import { TEAM_PERFORMANCE_VIEW, type TeamPerformanceViewState } from '../team-performance-view.js';
import { CompactTeammateMetrics, compactTeammate } from './inventory-contract.js';
import { getOrCreateMaterializer } from './materializer.js';
import { queryDeltaEvents } from './query.js';

// ─── View Team Performance Handler ──────────────────────────────────────────

export async function handleViewTeamPerformance(
  args: { workflowId?: string; detail?: boolean },
  stateDir: string,
  eventStore: EventStore,
): Promise<ToolResult> {
  try {
    const store = eventStore;
    const materializer = getOrCreateMaterializer(stateDir);
    const streamId = args.workflowId ?? 'default';

    const events = await queryDeltaEvents(store, materializer, streamId, TEAM_PERFORMANCE_VIEW);
    const view = materializer.materialize<TeamPerformanceViewState>(
      streamId,
      TEAM_PERFORMANCE_VIEW,
      events,
    );

    // DR-8 — `detail: true` returns the full projection (teammates + modules +
    // sizing). The compact default keeps the per-teammate CORE metrics (the
    // headline the agent reads) but strips the heavier `modules` / `teamSizing`
    // roll-ups and each teammate's `moduleExpertise` list, which drive the bulk
    // of the payload on a large team.
    if (args.detail) {
      return { success: true, data: view };
    }
    const teammates: Record<string, CompactTeammateMetrics> = {};
    for (const [name, metrics] of Object.entries(view.teammates)) {
      teammates[name] = compactTeammate(metrics);
    }
    return { success: true, data: { teammates } };
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
