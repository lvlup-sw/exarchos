// ─── VCS Action: list_prs ───────────────────────────────────────────────────
//
// Lists pull/merge requests via the VCS provider abstraction.
// Read-only — does NOT emit events.

import type { DispatchContext } from '../../core/dispatch.js';
import type { ToolResult } from '../../format.js';
import { createVcsProvider } from '../../vcs/factory.js';

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
    const provider = createVcsProvider(ctx.projectConfig);
    const result = await provider.listPrs({
      state: args.state,
      head: args.head,
      base: args.base,
    });

    return { success: true, data: result };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      success: false,
      error: { code: 'VCS_ERROR', message: `list_prs failed: ${message}` },
    };
  }
}
