// ─── gate-preflight — the shared gate preflight (DR-10) ──────────────────────
//
// {@link runGatePreflight} is the fail-fast validation every per-task /
// post-merge gate handler opened with (contract-drift, mock-boundary,
// test-adequacy, check-integration-suite, static-analysis), collapsed into one
// module WITHOUT changing behavior: reject a miswired `eventStore`
// (MISWIRED_CONTEXT, named per handler), an absent `featureId` (INVALID_INPUT),
// an absent `taskId` for the per-task gates (opt-in via `requireTaskId`), then
// resolve the worktree-aware `repoRoot` (#1330) — returning the resolver's own
// INVALID_INPUT on an unresolvable `'auto'`.
//
// A second helper, `emitPolicySkipIfNeeded`, lived here and is DELETED rather
// than left standing. It owned the FIX-1a policy-skip emission until the durable
// gate runner took that over: `appendGateExecutedSignal` now mints the skip row
// from the SAME persisted evidence the verdict is derived from, which is what
// closed the gap where "the policy routed this gate out" and "the gate ran" were
// indistinguishable in the durable log (see gate-runner.ts, DR-7). No handler
// has called the old emitter since; its only caller was its own test, so the
// module-intent gate could not see it — a dead EXPORT inside a live module is
// below that gate's resolution. Removing it is the disposition its own retirement
// note already recorded.
// ────────────────────────────────────────────────────────────────────────────

import type { ToolResult } from '../../format.js';
import type { EventStore } from '../../events/store.js';
import { resolveRepoRoot } from '../gates/gate-utils.js';

// ─── Preflight ───────────────────────────────────────────────────────────────

/** Outcome of {@link runGatePreflight}: the resolved repoRoot, or a ready-to-return error. */
export type GatePreflightOutcome =
  | { readonly ok: true; readonly repoRoot: string }
  | { readonly ok: false; readonly result: ToolResult };

export interface GatePreflightParams {
  /** The feature/stream id — absent → INVALID_INPUT. */
  readonly featureId?: string | undefined;
  /** The task id — forwarded to the `'auto'` repoRoot resolver; required only when {@link requireTaskId}. */
  readonly taskId?: string | undefined;
  /** `repoRoot` input: a literal path, `'auto'`, or undefined (→ process.cwd()). */
  readonly repoRoot?: string | undefined;
  /** Explicit worktree path — preferred resolver seam for `repoRoot:'auto'`. */
  readonly worktreePath?: string | undefined;
  /** Handler name stamped into the MISWIRED_CONTEXT message (e.g. `'handleContractDrift'`). */
  readonly handlerName: string;
  /** When true, an absent `taskId` is an INVALID_INPUT — the per-task gate contract. */
  readonly requireTaskId?: boolean;
}

/**
 * Run the shared gate preflight: validate the DispatchContext + inputs and
 * resolve the worktree-aware repoRoot (#1330). Byte-preserves each handler's
 * original error envelopes:
 *   - miswired `eventStore` → `MISWIRED_CONTEXT: '<handlerName>: eventStore is required'`
 *   - absent `featureId`   → `INVALID_INPUT: 'featureId is required'`
 *   - absent `taskId` (when `requireTaskId`) → `INVALID_INPUT: 'taskId is required'`
 *   - unresolvable repoRoot → `INVALID_INPUT` carrying the resolver's message
 *
 * On success returns `{ ok: true, repoRoot }`; the handler proceeds. The
 * eventStore/featureId/taskId order matches every migrated handler exactly.
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
