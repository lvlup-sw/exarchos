/**
 * Handler for the `merge_pr` action. It merges a pull request through the VCS provider.
 * It appends `pr.merged` only when the merge succeeds. A declined merge, such as one that a required check blocks, is a successful call with no event.
 */

import type { DispatchContext } from '../../dispatch/core/dispatch.js';
import type { ToolResult } from '../../format.js';
import { createVcsProvider } from '../../vcs/factory.js';

export interface HandleMergePrArgs {
  readonly prId: string;
  readonly strategy: 'squash' | 'rebase' | 'merge';
}

/**
 * Merges the PR and records `pr.merged`.
 * When the merge lands but the append fails, it returns `PR_MERGED_EVENT_UNRECORDED` and not success.
 * A remote merge with no durable record is the most destructive failure, so the handler does not swallow the append error.
 * The merge result stays on `error.mergeResult`, because a failed envelope has no top-level `data`.
 */
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
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        error: {
          code: 'PR_MERGED_EVENT_UNRECORDED',
          message:
            `merge_pr: the merge succeeded and its result is preserved on ` +
            `\`error.mergeResult\` — what failed is the durable \`pr.merged\` record. ` +
            `Do NOT retry: retrying would repeat a merge that already landed. ` +
            `Underlying error: ${message}`,
          mergeResult: result,
        },
      };
    }
  }

  return { success: true, data: result };
}
