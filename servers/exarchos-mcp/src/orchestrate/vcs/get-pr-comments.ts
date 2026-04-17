// ─── VCS Action: get_pr_comments ────────────────────────────────────────────
//
// Retrieves comments on a pull/merge request via the VCS provider abstraction.
// Read-only — does NOT emit events.

import type { DispatchContext } from '../../core/dispatch.js';
import type { ToolResult } from '../../format.js';
import { createVcsProvider } from '../../vcs/factory.js';

export interface HandleGetPrCommentsArgs {
  readonly prId: string;
}

export async function handleGetPrComments(
  args: HandleGetPrCommentsArgs,
  ctx: DispatchContext,
): Promise<ToolResult> {
  try {
    const provider = createVcsProvider(ctx.projectConfig);
    const result = await provider.getPrComments(args.prId);

    return { success: true, data: result };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      success: false,
      error: { code: 'VCS_ERROR', message: `get_pr_comments failed: ${message}` },
    };
  }
}
