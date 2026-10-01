/**
 * `get_pr_comments` handler. It reads the comments on a pull or merge request through the VCS
 * provider and emits no events. The window and the field projection live in the provider layer.
 */

import type { DispatchContext } from '../../dispatch/core/dispatch.js';
import type { ToolResult } from '../../format.js';
import type { GetPrCommentsOptions } from '../../vcs/provider.js';
import { windowPrComments } from '../../vcs/provider.js';
import { narrowAffordance } from '../../dispatch/core/economy.js';
import { createVcsProvider } from '../../vcs/factory.js';

export interface HandleGetPrCommentsArgs {
  readonly prId: string;
  readonly limit?: number;
  readonly offset?: number;
  readonly fields?: readonly string[];
}

/**
 * Returns one window of PR comments. A provider without `getPrCommentsPage` gets the shared
 * `windowPrComments` helper over its full feed, so the output shape is the same. The next-page
 * affordance carries `--fields` forward, so the next page keeps the caller's projection.
 */
export async function handleGetPrComments(
  args: HandleGetPrCommentsArgs,
  ctx: DispatchContext,
): Promise<ToolResult> {
  try {
    const provider = await createVcsProvider({ config: ctx.projectConfig });
    const opts: GetPrCommentsOptions = {
      limit: args.limit,
      offset: args.offset,
      fields: args.fields,
    };

    const page = provider.getPrCommentsPage
      ? await provider.getPrCommentsPage(args.prId, opts)
      : windowPrComments(await provider.getPrComments(args.prId), opts);

    if (page.page.hasMore) {
      const nextOffset = page.page.offset + page.page.limit;
      const fieldsArg =
        args.fields && args.fields.length > 0
          ? ` --fields ${args.fields.join(',')}`
          : '';
      return {
        success: true,
        data: page,
        next_actions: [
          narrowAffordance(
            'get_pr_comments',
            page.comments.length,
            page.page.total,
            `get_pr_comments --pr ${args.prId} --offset ${nextOffset} --limit ${page.page.limit}${fieldsArg}`,
          ),
        ],
      };
    }

    return { success: true, data: page };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      success: false,
      error: { code: 'VCS_ERROR', message: `get_pr_comments failed: ${message}` },
    };
  }
}
