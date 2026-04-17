// ─── VCS Action: create_pr ──────────────────────────────────────────────────
//
// Creates a pull/merge request via the VCS provider abstraction.
// Emits a `pr.created` event on success.

import type { DispatchContext } from '../../core/dispatch.js';
import type { ToolResult } from '../../format.js';
import { createVcsProvider } from '../../vcs/factory.js';

export interface HandleCreatePrArgs {
  readonly title: string;
  readonly body: string;
  readonly base: string;
  readonly head: string;
  readonly draft?: boolean;
  readonly labels?: string[];
}

export async function handleCreatePr(
  args: HandleCreatePrArgs,
  ctx: DispatchContext,
): Promise<ToolResult> {
  try {
    const provider = createVcsProvider(ctx.projectConfig);
    const result = await provider.createPr({
      title: args.title,
      body: args.body,
      baseBranch: args.base,
      headBranch: args.head,
      draft: args.draft,
      labels: args.labels,
    });

    await ctx.eventStore.append('vcs', {
      type: 'pr.created',
      data: {
        provider: provider.name,
        prNumber: result.number,
        url: result.url,
        base: args.base,
        head: args.head,
      },
    });

    return { success: true, data: result };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      success: false,
      error: { code: 'VCS_ERROR', message: `create_pr failed: ${message}` },
    };
  }
}
