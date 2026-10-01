/**
 * Handler for the `list_prs` action. It lists pull requests through the VCS provider and emits no events.
 * It returns at most `LIST_PRS_DEFAULT_LIMIT` PRs, newest first, because the action has no `limit` or `offset` parameter.
 * The `page` metadata shows the total, and a narrow affordance suggests a filter.
 * Internal callers that need the full set call `provider.listPrs` directly.
 */

import type { DispatchContext } from '../../dispatch/core/dispatch.js';
import type { ToolResult } from '../../format.js';
import type { PrSummary } from '../../vcs/provider.js';
import { narrowAffordance } from '../../dispatch/core/economy.js';
import { createVcsProvider } from '../../vcs/factory.js';

/** Maximum number of PRs that `list_prs` returns. A repository can hold hundreds of open PRs. */
export const LIST_PRS_DEFAULT_LIMIT = 20;

export interface HandleListPrsArgs {
  readonly state?: 'open' | 'closed' | 'merged' | 'all';
  readonly head?: string;
  readonly base?: string;
}

/** Sorts by PR number, newest first, so the window does not depend on the provider order. */
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
