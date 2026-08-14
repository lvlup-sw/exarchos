import { narrowAffordance } from '../../../dispatch/core/economy.js';
import { EventStore } from '../../../events/store.js';
import type { ToolResult } from '../../../format.js';
import type { NextAction } from '../../../next-action.js';
import type { QualityHint } from '../../quality/hints.js';
import { CODE_QUALITY_VIEW, type CodeQualityViewState } from '../code-quality-view.js';
import { CompactQualityHint, analyticScope, compactQualityHint } from './analytic-contract.js';
import { resolveInventoryWindow } from './inventory-contract.js';
import { getOrCreateMaterializer } from './materializer.js';
import { buildPage } from './pipeline.js';
import { queryDeltaEvents } from './query.js';

// ─── View Quality Hints Handler ─────────────────────────────────────────────

export async function handleViewQualityHints(
  args: {
    workflowId?: string;
    skill?: string;
    // DR-8 (Task 024) — `hints` is a paged list; `detail: true` restores each
    // hint's advisory calibration fields.
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

    const events = await queryDeltaEvents(store, materializer, streamId, CODE_QUALITY_VIEW);
    const view = materializer.materialize<CodeQualityViewState>(
      streamId,
      CODE_QUALITY_VIEW,
      events,
    );

    const { generateQualityHints } = await import('../../quality/hints.js');
    const hints = generateQualityHints(view, args.skill);

    // DR-8 (Task 024) — `hints` is this view's dominant LIST, so page it and
    // report P5 scope for the skill filter. `unscopedTotal` re-generates the
    // unfiltered hint set only when a skill filter is active (mirrors the
    // inventory batch's filtered-only extra fold) so the elided hints stay
    // perceivable. Compact-by-default drops each hint's advisory fields;
    // `detail: true` restores them.
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
    return {
      success: false,
      error: {
        code: 'VIEW_ERROR',
        message: err instanceof Error ? err.message : String(err),
      },
    };
  }
}
