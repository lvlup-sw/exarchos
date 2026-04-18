// ─── VCS Action: add_pr_comment ─────────────────────────────────────────────
//
// Adds a comment to a pull/merge request via the VCS provider abstraction.
// Emits a `pr.commented` event on success.

import type { DispatchContext } from '../../core/dispatch.js';
import type { ToolResult } from '../../format.js';
import { createVcsProvider } from '../../vcs/factory.js';

export interface HandleAddPrCommentArgs {
  readonly prId: string;
  readonly body: string;
}

export async function handleAddPrComment(
  args: HandleAddPrCommentArgs,
  ctx: DispatchContext,
): Promise<ToolResult> {
  try {
    const provider = await createVcsProvider({ config: ctx.projectConfig });
    await provider.addComment(args.prId, args.body);

    await ctx.eventStore.append('vcs', {
      type: 'pr.commented',
      data: {
        provider: provider.name,
        prId: args.prId,
      },
    });

    return { success: true };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      success: false,
      error: { code: 'VCS_ERROR', message: `add_pr_comment failed: ${message}` },
    };
  }
}
