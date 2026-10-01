import { countBy, estimateOutputTokens, narrowAffordance, PIPELINE_DEFAULT_ITEM_CAP, resolveOutputTokenThreshold, SUMMARY_FIRST_PAGE_ITEMS } from '../../../dispatch/core/economy.js';
import { toViewFailure } from '../../degraded-result.js';
import { isFeatureStream } from '../../../dispatch/core/infra-streams.js';
import { EventStore } from '../../../events/store.js';
import type { ToolResult } from '../../../format.js';
import type { NextAction } from '../../../next-action.js';
import { deriveRepoKey } from '../../../utils/paths.js';
import type { QualityHintsConfig } from '../../../workflow/capabilities/resolver.js';
import { TERMINAL_PHASES } from '../../../workflow/terminal-phases.js';
import { PROJECTION_LAG_THRESHOLD_MS } from '../../index.js';
import { PIPELINE_VIEW, type PipelineViewState } from '../pipeline-view.js';
import { isSnapshotSafeId } from '../snapshot-store.js';
import { getOrCreateMaterializer } from './materializer.js';
import { foldToTail } from '../../fold-at-tail.js';
import { discoverStreams } from './streams.js';

/**
 * A compact pipeline row. It drops the unbounded `tasksById` map, which the counters already summarize. `detail: true` returns the full row.
 * `hasMore` is the stack eviction flag of the row, not the paging flag of the page.
 */
interface CompactPipelineEntry {
  readonly featureId: string;
  readonly workflowType: string;
  readonly phase: string;
  readonly taskCount: number;
  readonly completedCount: number;
  readonly failedCount: number;
  readonly stackPositions: PipelineViewState['stackPositions'];
  readonly hasMore: boolean;
  readonly _asOf: string;
  readonly repoRoot?: string;
}

/** The compact form of `PipelineSummary`: the same group counts, with compact `firstPage` rows. */
interface CompactPipelineSummary {
  readonly total: number;
  readonly byPhase: Record<string, number>;
  readonly byWorkflowType: Record<string, number>;
  readonly firstPage: CompactPipelineEntry[];
}

/** Reduces a full projection row to a compact entry. It copies `repoRoot` only when the row has one. */
function toCompactEntry(w: PipelineViewState): CompactPipelineEntry {
  const repoRoot = (w as { repoRoot?: string }).repoRoot;
  return {
    featureId: w.featureId,
    workflowType: w.workflowType,
    phase: w.phase,
    taskCount: w.taskCount,
    completedCount: w.completedCount,
    failedCount: w.failedCount,
    stackPositions: w.stackPositions,
    hasMore: w.hasMore,
    _asOf: w._asOf,
    ...(repoRoot !== undefined ? { repoRoot } : {}),
  };
}

/** Paging metadata of the detail and summary branches. */
interface PipelinePage {
  readonly total: number;
  readonly offset: number;
  readonly limit: number;
  readonly hasMore: boolean;
}

/** Builds the `page` envelope. `hasMore` is `offset + shownRows < total`, so the last window does not report more rows. */
export function buildPage(total: number, offset: number, limit: number, shownRows: number): PipelinePage {
  return { total, offset, limit, hasMore: offset + shownRows < total };
}

/**
 * Orders rows by `_asOf` descending, then by `featureId` ascending. Thus consecutive offset windows split one stable sequence.
 * `_asOf` is an ISO-8601 string, so a string compare is chronological.
 */
function comparePipelineRows(a: PipelineViewState, b: PipelineViewState): number {
  if (a._asOf !== b._asOf) return a._asOf < b._asOf ? 1 : -1;
  if (a.featureId !== b.featureId) return a.featureId < b.featureId ? -1 : 1;
  return 0;
}

/**
 * The next action that tells the agent how many workflows the default repo scope hides, with the `--scope all` hint.
 * The handler adds it when `unscopedTotal > page.total`, so it never fires in `scope: "all"` mode.
 * The verb is the view name, so it passes the catch-all next-action schema.
 */
function scopeAllAffordance(hiddenCount: number): NextAction {
  return {
    verb: 'pipeline',
    reason: `${hiddenCount} workflow${hiddenCount === 1 ? '' : 's'} in other repos ${hiddenCount === 1 ? 'is' : 'are'} hidden by the default repo scope — use scope: "all" to include ${hiddenCount === 1 ? 'it' : 'them'}.`,
    hint: 'exarchos vw ls --scope all',
  };
}

/**
 * Lists the pipeline workflows one page at a time. It skips stream ids that are not snapshot-safe, because `materialize` throws on them.
 * A stream with no `workflow.started` gives a row with an empty `featureId`. The handler drops that row before it counts totals.
 *
 * Scope order: `scope: "all"`, the `repoRoot` argument, then `callerRepoKey`. `scope: "repo"` with no key fails with `SCOPE_UNRESOLVABLE`.
 * A row with no `repoRoot` matches only unscoped queries.
 *
 * When the page exceeds the output-token threshold, the handler returns a counts-by-group summary. A `null` threshold gives the plain page.
 * @param args - `scope` shares one registration field with `ps`. The handler rejects the `ps` scopes `workflow` and `worktree` with `INVALID_INPUT`.
 * @param config - The `.exarchos.yml` slice that holds `qualityHints.outputTokenThreshold`.
 * @param callerRepoKey - The repo key of the caller. A direct call omits it, and the result is then unscoped.
 */
export async function handleViewPipeline(
  args: {
    limit?: number;
    offset?: number;
    includeCompleted?: boolean;
    detail?: boolean;
    repoRoot?: string;
    scope?: 'repo' | 'all' | 'workflow' | 'worktree';
  },
  stateDir: string,
  eventStore: EventStore,
  config?: QualityHintsConfig,
  callerRepoKey?: string,
): Promise<ToolResult> {
  try {
    if (args.scope !== undefined && args.scope !== 'repo' && args.scope !== 'all') {
      const outOfSubset = args.scope;
      const isPsScope = outOfSubset === 'workflow' || outOfSubset === 'worktree';
      return {
        success: false,
        error: {
          code: 'INVALID_INPUT',
          message:
            `pipeline: scope '${outOfSubset}' is not a pipeline axis — pipeline scopes are 'repo' | 'all'.` +
            (isPsScope
              ? ` ('workflow' | 'worktree' are ps-only scopes — use ps for those.)`
              : ''),
          validTargets: ['repo', 'all'],
          ...(isPsScope
            ? {
                suggestedFix: {
                  tool: 'exarchos_view',
                  params: { action: 'ps', scope: outOfSubset },
                },
              }
            : {}),
        },
      };
    }

    const store = eventStore;
    const materializer = getOrCreateMaterializer(stateDir);

    const streamIds = (await discoverStreams(stateDir, store))
      .filter(isFeatureStream)
      .filter(isSnapshotSafeId);
    const allWorkflows: PipelineViewState[] = [];

    for (const streamId of streamIds) {
      const { view } = await foldToTail<PipelineViewState>(store, materializer, streamId, PIPELINE_VIEW);
      allWorkflows.push(view);
    }

    const real = allWorkflows.filter((w) => w.featureId !== '');

    const filtered = args.includeCompleted
      ? real
      : real.filter((w) => !(TERMINAL_PHASES as readonly string[]).includes(w.phase));

    const unscopedTotal = filtered.length;

    let scoped: PipelineViewState[];
    let effectiveScope: 'repo' | 'all';
    if (args.scope === 'all') {
      scoped = filtered;
      effectiveScope = 'all';
    } else if (args.repoRoot !== undefined) {
      const key = deriveRepoKey(args.repoRoot);
      scoped = filtered.filter((w) => w.repoRoot === key);
      effectiveScope = 'repo';
    } else if (callerRepoKey !== undefined) {
      scoped = filtered.filter((w) => w.repoRoot === callerRepoKey);
      effectiveScope = 'repo';
    } else if (args.scope === 'repo') {
      return {
        success: false,
        error: {
          code: 'SCOPE_UNRESOLVABLE',
          message:
            'scope: "repo" requested but no repo identity is resolvable ' +
            '(no explicit repoRoot argument and no caller repo key). Pass an ' +
            'explicit repoRoot, or use scope: "all" to view the full ' +
            'cross-repo inventory.',
          suggestedFix: {
            tool: 'exarchos_view',
            params: { action: 'pipeline', scope: 'all' },
          },
        },
      };
    } else {
      scoped = filtered;
      effectiveScope = 'all';
    }

    const sorted = [...scoped].sort(comparePipelineRows);

    const total = sorted.length;

    const start = args.offset ?? 0;
    const explicitLimit = args.limit !== undefined;
    const effectiveLimit = explicitLimit ? (args.limit as number) : PIPELINE_DEFAULT_ITEM_CAP;
    const end = start + effectiveLimit;
    const windowed = sorted.slice(start, end);
    const workflows: Array<PipelineViewState | CompactPipelineEntry> = args.detail
      ? windowed
      : windowed.map(toCompactEntry);

    const page = buildPage(total, start, effectiveLimit, windowed.length);

    let projectionAsOf: string | undefined;
    for (const w of allWorkflows) {
      if (w._asOf && (!projectionAsOf || w._asOf > projectionAsOf)) {
        projectionAsOf = w._asOf;
      }
    }
    let meta: Record<string, unknown> | undefined;
    if (projectionAsOf !== undefined) {
      meta = { projectionAsOf };
      const asOfMs = Date.parse(projectionAsOf);
      if (Number.isFinite(asOfMs)) {
        const lag = Date.now() - asOfMs;
        if (lag > PROJECTION_LAG_THRESHOLD_MS) {
          meta = { ...meta, projectionLag: lag };
        }
      }
    }

    const detailData = { workflows, total, unscopedTotal, page, scope: effectiveScope };
    const threshold = resolveOutputTokenThreshold(config);
    const narrowHint = 'exarchos vw ls --limit 20 --offset 0';
    if (threshold !== null && estimateOutputTokens(detailData) > threshold) {
      const firstPage = windowed.slice(0, SUMMARY_FIRST_PAGE_ITEMS).map(toCompactEntry);
      const summary: CompactPipelineSummary = {
        total,
        byPhase: countBy(sorted, (w) => w.phase),
        byWorkflowType: countBy(sorted, (w) => w.workflowType),
        firstPage,
      };
      const summaryPage = buildPage(total, start, effectiveLimit, windowed.length);
      const summaryNextActions: NextAction[] = [
        narrowAffordance('pipeline', firstPage.length, total, narrowHint),
      ];
      if (unscopedTotal > total) {
        summaryNextActions.push(scopeAllAffordance(unscopedTotal - total));
      }
      return {
        success: true,
        data: { summary, total, unscopedTotal, page: summaryPage, scope: effectiveScope, truncated: true },
        next_actions: summaryNextActions,
        ...(meta ? { _meta: meta } : {}),
      };
    }

    const nextActions: NextAction[] = [];
    if (page.hasMore) {
      nextActions.push(narrowAffordance('pipeline', windowed.length, total, narrowHint));
    }
    if (unscopedTotal > total) {
      nextActions.push(scopeAllAffordance(unscopedTotal - total));
    }
    return {
      success: true,
      data: detailData,
      ...(nextActions.length > 0 ? { next_actions: nextActions } : {}),
      ...(meta ? { _meta: meta } : {}),
    };
  } catch (err) {
    return toViewFailure(err, { tool: 'exarchos_view', action: 'pipeline' });
  }
}
