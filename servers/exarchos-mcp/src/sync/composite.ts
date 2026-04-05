// ─── Composite Sync Handler ─────────────────────────────────────────────────
//
// Routes `action` to the appropriate sync handler, replacing the stub
// `exarchos_sync` entry point with a real implementation.

import type { ToolResult } from '../format.js';
import type { DispatchContext } from '../core/dispatch.js';
import { handleSyncNow } from './sync-handler.js';

/**
 * Composite handler that dispatches to sync handlers
 * based on the `action` field in args.
 */
export async function handleSync(
  args: Record<string, unknown>,
  ctx: DispatchContext,
): Promise<ToolResult> {
  const { stateDir } = ctx;
  const { action } = args;

  switch (action) {
    case 'now':
      return handleSyncNow(stateDir, ctx.outbox);

    default:
      return {
        success: false,
        error: {
          code: 'UNKNOWN_ACTION',
          message: `Unknown sync action: ${String(action)}`,
          validTargets: ['now'] as const,
        },
      };
  }
}
