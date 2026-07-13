// ─── VCS Action: list_prs ───────────────────────────────────────────────────
//
// Lists pull/merge requests via the VCS provider abstraction.
// Read-only — does NOT emit events.
//
// DR-3: applies a default newest-first window so a large open-PR set never dumps
// unbounded. `list_prs` carries no `limit`/`offset` schema params, so the window
// is a fixed default cap here in the handler (internal callers that need the
// full set call `provider.listPrs` directly and are unaffected). `page` metadata
// keeps the total perceivable and a narrow affordance steers to a filter.

import type { DispatchContext } from '../../core/dispatch.js';
import type { ToolResult } from '../../format.js';
import type { PrSummary } from '../../vcs/provider.js';
import { narrowAffordance } from '../../core/economy.js';
import { createVcsProvider } from '../../vcs/factory.js';

/**
 * Default newest-first window applied when `list_prs` is called without a
 * narrowing filter. PR summaries are lighter than comments, but an org repo can
 * carry hundreds of open PRs, so the read is bounded by default.
 */
export const LIST_PRS_DEFAULT_LIMIT = 20;

export interface HandleListPrsArgs {
  readonly state?: 'open' | 'closed' | 'merged' | 'all';
  readonly head?: string;
  readonly base?: string;
}

export async function handleListPrs(
  args: HandleListPrsArgs,
  ctx: DispatchContext,
): Promise<ToolResult> {
  try {
    const provider = await createVcsProvider({ config: ctx.projectConfig });
    const all = await provider.listPrs({
      state: args.state,
      head: args.head,
      base: args.base,
    });

    const total = all.length;
    // Newest-first by PR number so the default window is deterministic
    // regardless of provider list ordering.
    const ordered = [...all].sort((a, b) => b.number - a.number);
    const prs: PrSummary[] = ordered.slice(0, LIST_PRS_DEFAULT_LIMIT);
    const hasMore = prs.length < total;
    const page = { total, offset: 0, limit: LIST_PRS_DEFAULT_LIMIT, hasMore };

    if (hasMore) {
      return {
        success: true,
        data: { prs, page },
        next_actions: [
          narrowAffordance(
            'list_prs',
            prs.length,
            total,
            'list_prs --state open --head <branch>',
          ),
        ],
      };
    }

    return { success: true, data: { prs, page } };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      success: false,
      error: { code: 'VCS_ERROR', message: `list_prs failed: ${message}` },
    };
  }
}
