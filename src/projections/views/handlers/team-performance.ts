import { toViewFailure } from '../../degraded-result.js';
import { EventStore } from '../../../events/store.js';
import type { ToolResult } from '../../../format.js';
import { TEAM_PERFORMANCE_VIEW, type TeamPerformanceViewState } from '../team-performance-view.js';
import { CompactTeammateMetrics, compactTeammate } from './inventory-contract.js';
import { getOrCreateMaterializer } from './materializer.js';
import { foldToTail } from '../../fold-at-tail.js';

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

    const { view } = await foldToTail<TeamPerformanceViewState>(store, materializer, streamId, TEAM_PERFORMANCE_VIEW);

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
    return toViewFailure(err, { tool: 'exarchos_view', action: 'team_performance' });
  }
}
