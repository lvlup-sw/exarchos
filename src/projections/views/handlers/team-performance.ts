import { toViewFailure } from '../../degraded-result.js';
import { EventStore } from '../../../events/store.js';
import type { ToolResult } from '../../../format.js';
import { TEAM_PERFORMANCE_VIEW, type TeamPerformanceViewState } from '../team-performance-view.js';
import { CompactTeammateMetrics, compactTeammate } from './inventory-contract.js';
import { getOrCreateMaterializer } from './materializer.js';
import { foldToTail } from '../../fold-at-tail.js';

/**
 * Returns the team performance view. With `detail: true` it returns the full projection.
 * The compact default keeps the core metrics of each teammate and drops the heavier
 * `modules` and `teamSizing` roll-ups and the `moduleExpertise` list of each teammate.
 */
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
