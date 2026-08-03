// ─── P06-03 / Task 017 — Complete requirement-resolution context ─────────────
//
// The INPUT lattice for monotonic requirement resolution. This module names the
// six input dimensions the resolver folds — phase kind, risk, boundary status,
// reliability, declared gates, and policy floor — and, critically, the
// *normalization* that removes the old default-low / default-non-boundary
// coercions.
//
// The single load-bearing rule here (DR-4, and the P06-03 exit proof):
//
//   Absent or malformed danger signals resolve to their MOST-UNCERTAIN member,
//   never to their safest one. Missing risk becomes `'unknown'` (which the
//   resolver treats as at-least-as-strong as `'high'`), NOT `'low'`. Missing
//   boundary status becomes `'indeterminate'` (treated as touching), NOT
//   `'not-touching'`. Missing reliability becomes `'unknown'`, NOT `'reliable'`.
//
// Consuming existing signals, not parallel ones:
//   - risk reuses `RiskTier` from `../verification-policy.js` (widened with
//     `'unknown'`), never a new risk enum;
//   - phase kind reuses `PhaseKind` from `../phase-kind.js`;
//   - gate declarations reuse the `ResolvedGate` vocabulary from `../phase-kind.js`;
//   - reliability is DERIVED from `../../projections/freshness.js`'s
//     `ProjectionFreshness` (the P01-02 degradation verdict), never re-invented.
//
// Pure: no I/O, no clock, no config reads.

import type { RiskTier } from '../verification-policy.js';
import type { PhaseKind, ResolvedGate } from '../phase-kind.js';
import type { DesignDepth } from '../plan-depth-policy.js';
import type { ProjectionFreshness } from '../../projections/freshness.js';

// ─── Risk (widened with the explicit `unknown` top) ─────────────────────────

/**
 * Risk tier as seen by requirement resolution: the three known tiers plus the
 * explicit `'unknown'`. `'unknown'` is NOT a synonym for `'low'`; it sits ABOVE
 * `'high'` in the danger order so an unclassified task can never be admitted on
 * the strength of the lowest tier.
 */
export type ResolvedRiskTier = RiskTier | 'unknown';

/** The risk tiers in ascending danger order (`low < medium < high < unknown`). */
export const RESOLVED_RISK_TIERS = ['low', 'medium', 'high', 'unknown'] as const;

/**
 * Danger rank of each risk tier — the single source of the `low < medium <
 * high < unknown` ordering. `unknown` is the TOP (rank 3): strictly above every
 * known tier, so raising an input toward "we don't know" never lowers strength.
 */
export const RISK_TIER_DANGER_RANK: Readonly<Record<ResolvedRiskTier, number>> =
  Object.freeze({ low: 0, medium: 1, high: 2, unknown: 3 });

/**
 * Normalize an untrusted risk value into a {@link ResolvedRiskTier}.
 *
 * Only the three literal known tiers pass through. Everything else — `undefined`
 * (absent stamp), `null`, a typo like `'low-priority'`, a number — resolves to
 * `'unknown'`. This is the fail-safe direction: a value we cannot trust to be a
 * real tier is treated as the most dangerous, never silently downgraded to
 * `'low'`.
 */
export function normalizeRiskTier(value: unknown): ResolvedRiskTier {
  return value === 'low' || value === 'medium' || value === 'high'
    ? value
    : 'unknown';
}

// ─── Boundary status (widened with the explicit `indeterminate` top) ────────

/**
 * Whether a phase crosses an I/O / schema boundary. `'indeterminate'` is the
 * explicit "we could not decide" state — it is NOT a synonym for
 * `'not-touching'`; it sits ABOVE `'touching'` in the danger order.
 */
export type BoundaryStatus = 'not-touching' | 'touching' | 'indeterminate';

/** Boundary statuses in ascending danger order. */
export const BOUNDARY_STATUSES = [
  'not-touching',
  'touching',
  'indeterminate',
] as const;

/** Danger rank of each boundary status. `indeterminate` is the TOP (rank 2). */
export const BOUNDARY_DANGER_RANK: Readonly<Record<BoundaryStatus, number>> =
  Object.freeze({ 'not-touching': 0, touching: 1, indeterminate: 2 });

/**
 * Normalize an untrusted boundary signal into a {@link BoundaryStatus}.
 *
 * A concrete boolean (or its string form) maps to `'touching'` / `'not-touching'`.
 * Anything we cannot read as a decided boolean — `undefined` (absent stamp),
 * `null`, a malformed string — resolves to `'indeterminate'`, the fail-safe
 * top, never to `'not-touching'`.
 */
export function normalizeBoundaryStatus(value: unknown): BoundaryStatus {
  if (value === true || value === 'true' || value === 'touching') return 'touching';
  if (value === false || value === 'false' || value === 'not-touching') {
    return 'not-touching';
  }
  return 'indeterminate';
}

// ─── Reliability (derived from the P01-02 freshness verdict) ─────────────────

/**
 * The reliability of the signals feeding resolution. `'degraded'` mirrors a
 * `ProjectionFreshness.degraded === true` verdict; `'unknown'` is the absence of
 * any freshness verdict at all. Both are strictly above `'reliable'`, so
 * uncertainty about our own inputs can only ADD obligations.
 */
export type ReliabilityState = 'reliable' | 'degraded' | 'unknown';

/** Reliability states in ascending uncertainty order. */
export const RELIABILITY_STATES = ['reliable', 'degraded', 'unknown'] as const;

/** Uncertainty rank of each reliability state. `unknown` is the TOP (rank 2). */
export const RELIABILITY_UNCERTAINTY_RANK: Readonly<
  Record<ReliabilityState, number>
> = Object.freeze({ reliable: 0, degraded: 1, unknown: 2 });

/**
 * Derive a {@link ReliabilityState} from the P01-02 projection-freshness verdict.
 *
 * A present, non-degraded verdict is `'reliable'`; a degraded verdict (behind or
 * ahead of the tail) is `'degraded'`; the ABSENCE of a verdict — we never
 * assessed freshness — is `'unknown'`, never `'reliable'`. This is the only
 * supported way to feed reliability into a context: resolution consumes the
 * existing degradation signal rather than a parallel one.
 */
export function reliabilityFromFreshness(
  freshness: ProjectionFreshness | undefined,
): ReliabilityState {
  if (freshness === undefined) return 'unknown';
  return freshness.degraded ? 'degraded' : 'reliable';
}

// ─── Policy floor ────────────────────────────────────────────────────────────

/**
 * The baseline obligations a policy imposes independently of the task's danger
 * profile — a floor the resolved requirement set can only rise above. Ordered by
 * strength componentwise: more approvals is stronger, and `waivable: false`
 * (cannot be waived away) is stronger than `waivable: true`.
 */
export interface RequirementPolicyFloor {
  /** Minimum approvals the policy demands regardless of tier. `>= 0`. */
  readonly minimumApprovals: number;
  /** Whether the policy permits an authorized waiver to discharge obligations. */
  readonly waivable: boolean;
}

/** The weakest policy floor: no approvals, fully waivable. */
export const OPEN_POLICY_FLOOR: RequirementPolicyFloor = Object.freeze({
  minimumApprovals: 0,
  waivable: true,
});

// ─── The resolution context ──────────────────────────────────────────────────

/**
 * The complete, normalized input to {@link resolveRequirements}. Every danger
 * dimension is already a decided lattice member (no `undefined`, no coercion
 * left to do) — {@link buildRequirementContext} is the only supported way to
 * reach this shape from untrusted input.
 */
export interface RequirementContext {
  readonly phaseKind: PhaseKind;
  readonly risk: ResolvedRiskTier;
  readonly boundary: BoundaryStatus;
  readonly reliability: ReliabilityState;
  /** Additional gate obligations declared explicitly (planner / policy). */
  readonly declaredGates: readonly ResolvedGate[];
  readonly policy: RequirementPolicyFloor;
  /** Workflow type — threaded to the REVIEW gate resolver. Optional. */
  readonly workflowType?: string;
  /** Frozen planning depth — threaded to the PLAN gate resolver. Optional. */
  readonly designDepth?: DesignDepth;
}

/**
 * The untrusted / partial input accepted by {@link buildRequirementContext}. The
 * danger fields are deliberately `unknown`: the normalizers, not the caller's
 * type, decide what an absent or malformed value means.
 */
export interface RequirementContextInput {
  readonly phaseKind: PhaseKind;
  readonly risk?: unknown;
  readonly boundary?: unknown;
  readonly reliability?: ReliabilityState | ProjectionFreshness | undefined;
  readonly declaredGates?: readonly ResolvedGate[];
  readonly policy?: RequirementPolicyFloor;
  readonly workflowType?: string;
  readonly designDepth?: DesignDepth;
}

function normalizeReliability(
  value: ReliabilityState | ProjectionFreshness | undefined,
): ReliabilityState {
  if (value === undefined) return 'unknown';
  if (value === 'reliable' || value === 'degraded' || value === 'unknown') {
    return value;
  }
  // A ProjectionFreshness verdict.
  return reliabilityFromFreshness(value);
}

/**
 * Build a complete {@link RequirementContext} from partial / untrusted input,
 * applying the fail-safe normalizers. This is where the removed coercions live:
 *
 *   - absent / malformed risk       → `'unknown'` (NOT `'low'`)
 *   - absent / malformed boundary    → `'indeterminate'` (NOT `'not-touching'`)
 *   - absent reliability / no verdict → `'unknown'` (NOT `'reliable'`)
 *   - absent policy floor            → {@link OPEN_POLICY_FLOOR}
 *   - absent declarations            → `[]`
 *
 * Total and pure: every input produces a context, and the same input always
 * produces the same context.
 */
export function buildRequirementContext(
  input: RequirementContextInput,
): RequirementContext {
  return {
    phaseKind: input.phaseKind,
    risk: normalizeRiskTier(input.risk),
    boundary: normalizeBoundaryStatus(input.boundary),
    reliability: normalizeReliability(input.reliability),
    declaredGates: input.declaredGates ?? [],
    policy: input.policy ?? OPEN_POLICY_FLOOR,
    ...(input.workflowType !== undefined ? { workflowType: input.workflowType } : {}),
    ...(input.designDepth !== undefined ? { designDepth: input.designDepth } : {}),
  };
}
