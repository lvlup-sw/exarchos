// ─── VCS Action: merge_pr ───────────────────────────────────────────────────
//
// Merges a pull/merge request via the VCS provider abstraction.
// Emits a `pr.merged` event only when the merge succeeds.

import type { DispatchContext } from '../../core/dispatch.js';
import type { ToolResult } from '../../format.js';
import { createVcsProvider } from '../../vcs/factory.js';

export interface HandleMergePrArgs {
  readonly prId: string;
  readonly strategy: 'squash' | 'rebase' | 'merge';
}

export async function handleMergePr(
  args: HandleMergePrArgs,
  ctx: DispatchContext,
): Promise<ToolResult> {
  const provider = await createVcsProvider({ config: ctx.projectConfig });

  let result;
  try {
    result = await provider.mergePr(args.prId, args.strategy);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      success: false,
      error: { code: 'VCS_ERROR', message: `merge_pr failed: ${message}` },
    };
  }

  if (result.merged) {
    try {
      await ctx.eventStore.append('vcs', {
        type: 'pr.merged',
        data: {
          provider: provider.name,
          prId: args.prId,
          strategy: args.strategy,
          merged: result.merged,
          sha: result.sha,
        },
      });
    } catch {
      // Event emission is best-effort — merge already succeeded
    }
  }

  return { success: true, data: result };
}
