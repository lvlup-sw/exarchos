/**
 * The shared fail-fast preflight of the per-task and post-merge gate handlers.
 * It refuses a miswired `eventStore`, an absent `featureId`, and an absent `taskId` when the gate asks for one.
 * Then it resolves the worktree-aware `repoRoot`, and returns the resolver's own `INVALID_INPUT` for an unresolvable `'auto'`.
 */

import type { ToolResult } from '../../format.js';
import type { EventStore } from '../../events/store.js';
import { resolveRepoRoot } from '../gates/gate-utils.js';

/** Outcome of {@link runGatePreflight}: the resolved repoRoot, or a ready-to-return error. */
export type GatePreflightOutcome =
  | { readonly ok: true; readonly repoRoot: string }
  | { readonly ok: false; readonly result: ToolResult };

export interface GatePreflightParams {
  /** The feature/stream id — absent → INVALID_INPUT. */
  readonly featureId?: string | undefined;
  /** The task id. The `'auto'` repoRoot resolver reads it. It is required only when {@link requireTaskId} is true. */
  readonly taskId?: string | undefined;
  /** `repoRoot` input: a literal path, `'auto'`, or undefined (→ process.cwd()). */
  readonly repoRoot?: string | undefined;
  /** Explicit worktree path — preferred resolver seam for `repoRoot:'auto'`. */
  readonly worktreePath?: string | undefined;
  /** The handler name in the MISWIRED_CONTEXT message, for example `'handleContractDrift'`. */
  readonly handlerName: string;
  /** When true, an absent `taskId` is an INVALID_INPUT — the per-task gate contract. */
  readonly requireTaskId?: boolean;
}

/**
 * Runs the shared gate preflight and keeps the original error envelope of each handler:
 *   - miswired `eventStore` → `MISWIRED_CONTEXT: '<handlerName>: eventStore is required'`
 *   - absent `featureId`   → `INVALID_INPUT: 'featureId is required'`
 *   - absent `taskId` (when `requireTaskId`) → `INVALID_INPUT: 'taskId is required'`
 *   - unresolvable repoRoot → `INVALID_INPUT` carrying the resolver's message
 *
 * On success, it returns `{ ok: true, repoRoot }`. The checks run in the order `eventStore`, `featureId`, `taskId`.
 */
export async function runGatePreflight(
  params: GatePreflightParams,
  eventStore: EventStore,
): Promise<GatePreflightOutcome> {
  if (!eventStore) {
    return {
      ok: false,
      result: {
        success: false,
        error: { code: 'MISWIRED_CONTEXT', message: `${params.handlerName}: eventStore is required` },
      },
    };
  }
  if (!params.featureId) {
    return {
      ok: false,
      result: { success: false, error: { code: 'INVALID_INPUT', message: 'featureId is required' } },
    };
  }
  if (params.requireTaskId && !params.taskId) {
    return {
      ok: false,
      result: { success: false, error: { code: 'INVALID_INPUT', message: 'taskId is required' } },
    };
  }

  const resolved = await resolveRepoRoot(
    {
      repoRoot: params.repoRoot,
      worktreePath: params.worktreePath,
      featureId: params.featureId,
      taskId: params.taskId,
    },
    eventStore,
  );
  if (!resolved.ok) {
    return {
      ok: false,
      result: { success: false, error: { code: 'INVALID_INPUT', message: resolved.error } },
    };
  }
  return { ok: true, repoRoot: resolved.repoRoot };
}
