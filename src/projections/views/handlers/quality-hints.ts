import { narrowAffordance } from '../../../dispatch/core/economy.js';
import { toViewFailure } from '../../degraded-result.js';
import { EventStore } from '../../../events/store.js';
import type { ToolResult } from '../../../format.js';
import type { NextAction } from '../../../next-action.js';
import type { QualityHint } from '../../quality/hints.js';
import { CODE_QUALITY_VIEW, type CodeQualityViewState } from '../code-quality-view.js';
import { CompactQualityHint, analyticScope, compactQualityHint } from './analytic-contract.js';
import { resolveInventoryWindow } from './inventory-contract.js';
import { getOrCreateMaterializer } from './materializer.js';
import { buildPage } from './pipeline.js';
import { foldToTail } from '../../fold-at-tail.js';

/**
 * Return the quality hints of a workflow as a paged list. Each hint omits `affectedPromptPaths`
 * and `confidenceLevel` unless the caller sets `detail: true`. With a `skill` filter,
 * `unscopedTotal` counts the hints without the filter, so the hidden hints stay visible.
 */
export async function handleViewQualityHints(
  args: {
    workflowId?: string;
    skill?: string;
    limit?: number;
    offset?: number;
    detail?: boolean;
  },
  stateDir: string,
  eventStore: EventStore,
): Promise<ToolResult> {
  try {
    const store = eventStore;
    const materializer = getOrCreateMaterializer(stateDir);
    const streamId = args.workflowId ?? 'default';

    const { view } = await foldToTail<CodeQualityViewState>(store, materializer, streamId, CODE_QUALITY_VIEW);

    const { generateQualityHints } = await import('../../quality/hints.js');
    const hints = generateQualityHints(view, args.skill);

    const filterActive = args.skill !== undefined;
    const unscopedTotal = filterActive
      ? generateQualityHints(view).length
      : hints.length;
    const { start, effectiveLimit } = resolveInventoryWindow(args);
    const windowed = hints.slice(start, start + effectiveLimit);
    const rows: Array<QualityHint | CompactQualityHint> = args.detail
      ? windowed
      : windowed.map(compactQualityHint);
    const page = buildPage(hints.length, start, effectiveLimit, windowed.length);
    const s = analyticScope('quality_hints', filterActive, unscopedTotal, hints.length);
    const nextActions: NextAction[] = [];
    if (page.hasMore) {
      nextActions.push(
        narrowAffordance('quality_hints', windowed.length, hints.length, 'exarchos vw quality_hints --limit 20 --offset 0'),
      );
    }
    nextActions.push(...s.nextActions);

    return {
      success: true,
      data: {
        hints: rows,
        generatedAt: new Date().toISOString(),
        page,
        scope: s.scope,
        unscopedTotal: s.unscopedTotal,
      },
      ...(nextActions.length > 0 ? { next_actions: nextActions } : {}),
    };
  } catch (err) {
    return toViewFailure(err, { tool: 'exarchos_view', action: 'quality_hints' });
  }
}
