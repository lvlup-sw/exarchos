// ─── VCS Action: merge_pr ───────────────────────────────────────────────────
//
// Merges a pull/merge request via the VCS provider abstraction. Appends
// `pr.merged` only when the merge succeeds — a declined merge (the remote
// reports no merge, e.g. blocked by a required check) is a successful call
// with nothing to record. A merge that DID land but whose append then fails
// is a different case: the handler refuses to report success rather than let
// the durable record silently go missing. See the handler for why.

import type { DispatchContext } from '../../dispatch/core/dispatch.js';
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
    // The append is NOT swallowed. A merge nobody can find a durable record
    // of is the family's most destructive failure shape — a remote mutation
    // already committed, with no row anywhere to say so and no signal to any
    // observer that the drift happened. Withholding the success carrier on a
    // failed append (rather than reporting success with a silently missing
    // row) mirrors `requireGateEvent`'s shape elsewhere in this lane: the
    // merge's own result still rides on `data`, because the effect happened
    // and is worth reading, but `success` reflects whether the durable record
    // of it does too.
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
        data: result,
        error: {
          code: 'PR_MERGED_EVENT_UNRECORDED',
          message:
            `merge_pr: the merge succeeded and its result is preserved on \`data\` — ` +
            `what failed is the durable \`pr.merged\` record. Do NOT retry: retrying ` +
            `would repeat a merge that already landed. Underlying error: ${message}`,
        },
      };
    }
  }

  return { success: true, data: result };
}
