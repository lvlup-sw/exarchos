// ─── gate-preflight — shared gate preflight + policy-skip emission (DR-10) ────
//
// Two pieces of boilerplate were byte-repeated across the per-task / post-merge
// gate handlers (contract-drift, mock-boundary, test-adequacy,
// check-integration-suite, static-analysis). This leaf collapses BOTH into one
// module WITHOUT changing behavior — each handler's observable result and each
// emitted `gate.executed` shape stays identical (DR-10: pure dedup):
//
//   1. PREFLIGHT ({@link runGatePreflight}) — the fail-fast validation every
//      gate handler opened with: reject a miswired `eventStore`
//      (MISWIRED_CONTEXT, named per handler), an absent `featureId`
//      (INVALID_INPUT), an absent `taskId` for the per-task gates (opt-in via
//      `requireTaskId`), then resolve the worktree-aware `repoRoot` (#1330) —
//      returning the resolver's own INVALID_INPUT on an unresolvable `'auto'`.
//
//   2. POLICY-SKIP ({@link emitPolicySkipIfNeeded}) — the FIX-1a verification-
//      ladder self-routing shared by the three per-task gates: consult
//      `resolvePolicySkip` on the stamped profile and, when the gate is not in
//      the resolved sequence, emit the skip `gate.executed` and report the
//      reason. The emitted event's `gateName` / `layer` / `phase` differ PER
//      gate, so those are parameters — the emitter preserves each handler's
//      exact shape rather than coalescing them. The RETURN carrier (which also
//      differs per gate) stays in the handler; this helper only owns the shared
//      emission + the skip decision.
// ────────────────────────────────────────────────────────────────────────────

import type { ToolResult } from '../../format.js';
import type { EventStore } from '../../event-store/store.js';
import type { ResolvedProjectConfig } from '../../config/resolve.js';
import type { GateName, RiskTier } from '../../workflow/verification-policy.js';
import {
  emitGateEvent,
  resolvePolicySkip,
  resolveRepoRoot,
  SKIPPED_BY_POLICY,
} from '../gate-utils.js';

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

// ─── Policy-skip emission (FIX-1a) ───────────────────────────────────────────

export interface PolicySkipParams {
  readonly eventStore: EventStore;
  readonly featureId: string;
  readonly taskId: string;
  /** The task branch — emitted into `details.branch` only when present. */
  readonly branch?: string | undefined;
  /** Idempotency key for the emission (INV-8). */
  readonly operationId?: string | undefined;

  // ── the stamped verification profile consulted by resolvePolicySkip ────────
  readonly riskTier?: RiskTier | undefined;
  readonly boundaryTouching?: boolean | undefined;
  readonly projectConfig?: ResolvedProjectConfig | undefined;

  // ── per-gate emission shape (preserved, NOT coalesced) ─────────────────────
  /** Gate name resolvePolicySkip checks against the resolved sequence (e.g. `'check_contract_drift'`). */
  readonly policyGateName: GateName;
  /** Gate name stamped on the emitted `gate.executed` (e.g. `'contract-drift'`). */
  readonly emitGateName: string;
  /** Workflow layer stamped on the emission (e.g. `'delegate'` | `'testing'`). */
  readonly layer: string;
  /** Phase stamped into `details.phase` (e.g. `'delegate'` | a caller-supplied override). */
  readonly phase: string;
}

/**
 * The FIX-1a verification-ladder self-routing shared by the per-task gates.
 *
 * Consults {@link resolvePolicySkip} on the stamped `riskTier`/`boundaryTouching`
 * profile (config-aware). When the gate is NOT in the resolved sequence it emits
 * the skip `gate.executed` (fire-and-forget — an emission failure never breaks
 * the verdict) and returns the skip `reason` so the handler can build its own
 * advisory carrier. When the gate IS in the sequence (or the profile is
 * unstamped) it returns `null` and the handler runs the gate unconditionally.
 *
 * The emitted event's `details` shape is byte-identical to the three handlers'
 * pre-dedup emissions: `{ dimension:'D1', phase, taskId, [branch], skipped:true,
 * discriminant:SKIPPED_BY_POLICY, reason }`. The differing `gateName` / `layer` /
 * `phase` are parameters, so no per-handler difference is unified away.
 */
export async function emitPolicySkipIfNeeded(
  params: PolicySkipParams,
): Promise<{ readonly reason: string } | null> {
  const policySkip = resolvePolicySkip({
    gateName: params.policyGateName,
    riskTier: params.riskTier,
    boundaryTouching: params.boundaryTouching,
    config: params.projectConfig,
  });
  if (!policySkip) return null;

  try {
    await emitGateEvent(
      params.eventStore,
      params.featureId,
      params.emitGateName,
      params.layer,
      true,
      {
        dimension: 'D1',
        phase: params.phase,
        taskId: params.taskId,
        ...(params.branch ? { branch: params.branch } : {}),
        skipped: true,
        discriminant: SKIPPED_BY_POLICY,
        reason: policySkip.reason,
      },
      params.operationId,
    );
  } catch {
    /* fire-and-forget */
  }

  return { reason: policySkip.reason };
}
