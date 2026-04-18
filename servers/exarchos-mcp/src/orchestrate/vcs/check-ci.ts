// ─── VCS Action: check_ci ───────────────────────────────────────────────────
//
// Checks CI status for a pull/merge request via the VCS provider abstraction.
// Read-only — does NOT emit events.

import type { DispatchContext } from '../../core/dispatch.js';
import type { ToolResult } from '../../format.js';
import { createVcsProvider } from '../../vcs/factory.js';

export interface HandleCheckCiArgs {
  readonly prId: string;
}

export async function handleCheckCi(
  args: HandleCheckCiArgs,
  ctx: DispatchContext,
): Promise<ToolResult> {
  try {
    const provider = await createVcsProvider({ config: ctx.projectConfig });
    const result = await provider.checkCi(args.prId);

    return { success: true, data: result };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      success: false,
      error: { code: 'VCS_ERROR', message: `check_ci failed: ${message}` },
    };
  }
}
