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

import type { PhaseKind, ResolvedGate } from '../phase-kind.js';
import type { DesignDepth } from '../plan-depth-policy.js';
import type { ProjectionFreshness } from '../../projections/freshness.js';
import {
  BOUNDARY_DANGER_RANK,
  BOUNDARY_STATUSES,
  boundaryStatusTouches,
  normalizeBoundaryStatus,
  RESOLVED_RISK_TIERS,
  RISK_TIER_DANGER_RANK,
  resolveRiskTier,
  type BoundaryStatus,
  type ResolvedRiskTier,
} from '../verification-policy-resolver.js';

// ─── Risk / boundary: ONE authority, re-exported (DR-10 / T-15) ─────────────
//
// The normalization of an untrusted risk stamp and an untrusted boundary signal
// used to exist TWICE — here and in `verification-policy-resolver.ts` — with
// subtly different string handling. Two authorities for one normalization is a
// latent divergence, so the pair is consolidated with the RESOLVER as the
// canonical home and this module importing from it.
//
// The direction is forced by the import graph, not preference: `phase-kind.ts`
// value-imports the resolver, and this module is (transitively) reachable from
// phase-kind's consumers — so a resolver → requirement-context edge would close
// the cycle `phase-kind → verification-policy-resolver → admission/
// requirement-context → phase-kind`.
//
// What is preserved here is the vocabulary: the three-valued `BoundaryStatus`
// lattice is strictly richer than the ladder's boolean, so the lattice moved to
// the resolver INTACT and the boolean is derived from it there
// (`boundaryStatusTouches`), never the reverse.

export {
  BOUNDARY_DANGER_RANK,
  BOUNDARY_STATUSES,
  RESOLVED_RISK_TIERS,
  RISK_TIER_DANGER_RANK,
  normalizeBoundaryStatus,
  type BoundaryStatus,
  type ResolvedRiskTier,
};

/**
 * Normalize an untrusted risk value into a {@link ResolvedRiskTier}.
 *
 * The admission-layer name for {@link resolveRiskTier} — the single
 * implementation, not a second one. Only the three literal known tiers pass
 * through; everything else (absent stamp, `null`, a typo, a number) resolves to
 * `'unknown'`, never to `'low'`.
 */
export const normalizeRiskTier = resolveRiskTier;

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

// ─── DR-10 (T-15): the monotone same-call floor ──────────────────────────────
//
// The remaining half of DR-10's defect statement is that the tier is
// "re-resolved on every attempt from post-update `mutableState`". `handleSet`
// applies this call's `updates` BEFORE evaluating the transition, so a call
// shaped `{ phase: 'review', updates: { riskTier: 'low' } }` evaluates the
// transition — and freezes its obligation — against a tier the workflow did not
// have when the call began. Stamping a WEAKER tier therefore weakened the very
// transition being admitted.
//
// The rule this section encodes: a same-call update may only ever RAISE the
// obligations of the transition it accompanies. The stamp still lands and still
// governs every LATER call; it simply cannot retroactively lower the bar it is
// currently being measured against.
//
// The floor is computed on the danger COORDINATE, using the existing rank
// tables (`RISK_TIER_DANGER_RANK`, `BOUNDARY_DANGER_RANK`,
// `RELIABILITY_UNCERTAINTY_RANK`) — no new ordering is invented.

/**
 * A resolved point on the two danger axes: the tier claim and the boundary
 * status. This is the unit the same-call floor and the frozen-record readback
 * both operate on, so both use one ordering.
 */
export interface DangerCoordinate {
  readonly risk: ResolvedRiskTier;
  readonly boundary: BoundaryStatus;
}

/** Normalize an untrusted `(risk, boundary)` pair into a {@link DangerCoordinate}. */
export function resolveDangerCoordinate(raw: {
  readonly risk?: unknown;
  readonly boundary?: unknown;
}): DangerCoordinate {
  return {
    risk: normalizeRiskTier(raw.risk),
    boundary: normalizeBoundaryStatus(raw.boundary),
  };
}

/** Project a coordinate onto the ladder-facing boolean boundary flag. */
export function dangerBoundaryTouching(coordinate: DangerCoordinate): boolean {
  return boundaryStatusTouches(coordinate.boundary);
}

function strongerBoundary(a: BoundaryStatus, b: BoundaryStatus): BoundaryStatus {
  return BOUNDARY_DANGER_RANK[a] >= BOUNDARY_DANGER_RANK[b] ? a : b;
}

/**
 * Join two tier claims by the existing danger rank — `low < medium < high <
 * unknown`. No second ordering is introduced: this is
 * {@link RISK_TIER_DANGER_RANK} read as the lattice it already is, and it is
 * the ordering `resolveRequirements` is monotone in (an unknown tier resolves
 * through `effectiveRiskTier` to `'high'`, so it dominates every known tier).
 */
export function joinRiskTier(
  a: ResolvedRiskTier,
  b: ResolvedRiskTier,
): ResolvedRiskTier {
  return RISK_TIER_DANGER_RANK[a] >= RISK_TIER_DANGER_RANK[b] ? a : b;
}

/**
 * The componentwise join of two danger coordinates — the least coordinate at
 * least as dangerous as both on the requirement lattice.
 *
 * This is a join for the OBLIGATION lattice, and deliberately not the whole
 * same-call floor. The live gate resolvers do not agree on where `'unknown'`
 * sits: the verification ladder escalates it to the strongest cell, while the
 * review roster reads it as "no tier claim" and therefore emits FEWER
 * dimensions than `'high'` would (see `verification-policy-resolver.ts` — the
 * two fail-safes point in opposite directions on purpose). So no single
 * coordinate dominates both projections, and the caller that needs a true
 * floor over the live resolvers takes the union of the gate sets resolved AT
 * each coordinate instead (`executeTransition`'s `TransitionObligationFloor`).
 * This function supplies the coordinate that is recorded alongside that union.
 */
export function joinDangerCoordinates(
  a: DangerCoordinate,
  b: DangerCoordinate,
): DangerCoordinate {
  return {
    risk: joinRiskTier(a.risk, b.risk),
    boundary: strongerBoundary(a.boundary, b.boundary),
  };
}

/** Join two reliability verdicts by uncertainty rank (`unknown` is the top). */
function joinReliability(
  a: ReliabilityState,
  b: ReliabilityState,
): ReliabilityState {
  return RELIABILITY_UNCERTAINTY_RANK[a] >= RELIABILITY_UNCERTAINTY_RANK[b] ? a : b;
}

/**
 * Join two resolution contexts into the one a transition must be evaluated at:
 * componentwise on every danger axis, union of declared gates, and the stronger
 * policy floor (more approvals, less waivable).
 *
 * `resolveRequirements` is monotone in each of those inputs, so the requirement
 * set resolved from the join is at least as strong as the set resolved from
 * EITHER input — which is exactly the "a same-call update can only raise
 * obligations" guarantee, obtained from the resolver's existing monotonicity
 * rather than from a special case.
 *
 * Both contexts must name the same `phaseKind` (the join is per-transition);
 * `a`'s kind and optional carriers win, since `a` is the incumbent.
 */
export function joinRequirementContexts(
  a: RequirementContext,
  b: RequirementContext,
): RequirementContext {
  const coordinate = joinDangerCoordinates(
    { risk: a.risk, boundary: a.boundary },
    { risk: b.risk, boundary: b.boundary },
  );
  const workflowType = a.workflowType ?? b.workflowType;
  const designDepth = a.designDepth ?? b.designDepth;
  return {
    phaseKind: a.phaseKind,
    risk: coordinate.risk,
    boundary: coordinate.boundary,
    reliability: joinReliability(a.reliability, b.reliability),
    declaredGates: [...a.declaredGates, ...b.declaredGates],
    policy: {
      minimumApprovals: Math.max(
        a.policy.minimumApprovals,
        b.policy.minimumApprovals,
      ),
      waivable: a.policy.waivable && b.policy.waivable,
    },
    ...(workflowType !== undefined ? { workflowType } : {}),
    ...(designDepth !== undefined ? { designDepth } : {}),
  };
}
