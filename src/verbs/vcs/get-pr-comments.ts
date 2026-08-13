// ─── VCS Action: get_pr_comments ────────────────────────────────────────────
//
// Retrieves comments on a pull/merge request via the VCS provider abstraction.
// Read-only — does NOT emit events.
//
// DR-3: thin shim. The window + projection lives in the provider layer
// (`vcs/github.ts` / `windowPrComments`); this handler only reads the
// schema-declared `limit`/`offset`/`fields` (registered by Task 022), calls the
// bounded provider surface, and advertises a narrow affordance when more
// comments remain.

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

    // Prefer the provider's own bounded surface; providers that don't implement
    // it (GitLab/ADO partials) are windowed here via the shared helper over
    // their full feed, so the output shape is identical either way.
    const page = provider.getPrCommentsPage
      ? await provider.getPrCommentsPage(args.prId, opts)
      : windowPrComments(await provider.getPrComments(args.prId), opts);

    if (page.page.hasMore) {
      const nextOffset = page.page.offset + page.page.limit;
      // Carry the projection forward — otherwise page 2 silently returns full
      // comments, defeating the DR-3 field-narrowing the caller asked for.
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
