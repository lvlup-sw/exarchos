// The input lattice for monotonic requirement resolution.
// It names six inputs: phase kind, risk, boundary status, reliability, declared gates and policy floor.
// An absent or malformed danger signal resolves to its most uncertain member, never to its safest one.
// Thus risk and reliability become `'unknown'`, and boundary becomes `'indeterminate'`.
//
// The module reuses `RiskTier`, `PhaseKind`, `ResolvedGate` and `ProjectionFreshness`.
// The risk and boundary normalizers live in `verification-policy-resolver.ts`, and this module re-exports them.
// An import in the other direction closes a cycle through `phase-kind.ts`.
// The module is pure: no I/O, no clock, no config reads.

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
 * The admission-layer name for {@link resolveRiskTier}. Only the three known tiers pass.
 * Every other value, such as an absent stamp or a typo, resolves to `'unknown'`, never to `'low'`.
 */
export const normalizeRiskTier = resolveRiskTier;

/**
 * The reliability of the resolution inputs. `'degraded'` is a degraded freshness verdict, and `'unknown'` is no verdict.
 * Both rank above `'reliable'`, so uncertain inputs can only add obligations.
 */
export type ReliabilityState = 'reliable' | 'degraded' | 'unknown';

/** Reliability states in ascending uncertainty order. */
export const RELIABILITY_STATES = ['reliable', 'degraded', 'unknown'] as const;

/** Uncertainty rank of each reliability state. `unknown` is the TOP (rank 2). */
export const RELIABILITY_UNCERTAINTY_RANK: Readonly<
  Record<ReliabilityState, number>
> = Object.freeze({ reliable: 0, degraded: 1, unknown: 2 });

/** Derives a {@link ReliabilityState} from a projection freshness verdict. No verdict gives `'unknown'`, never `'reliable'`. */
export function reliabilityFromFreshness(
  freshness: ProjectionFreshness | undefined,
): ReliabilityState {
  if (freshness === undefined) return 'unknown';
  return freshness.degraded ? 'degraded' : 'reliable';
}

/**
 * The baseline obligations of a policy, independent of the danger profile. The resolved set can only rise above it.
 * More approvals are stronger, and `waivable: false` is stronger than `waivable: true`.
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

/**
 * The complete, normalized input to {@link resolveRequirements}. Each danger dimension is a decided lattice member.
 * Use {@link buildRequirementContext} to make it from untrusted input.
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
 * The partial, untrusted input of {@link buildRequirementContext}.
 * The danger fields are `unknown`, so the normalizers decide what an absent or malformed value means.
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
  return reliabilityFromFreshness(value);
}

/**
 * Builds a complete {@link RequirementContext} from partial, untrusted input. The function is total and pure.
 * - An absent or malformed risk gives `'unknown'`, not `'low'`.
 * - An absent or malformed boundary gives `'indeterminate'`, not `'not-touching'`.
 * - An absent reliability gives `'unknown'`, not `'reliable'`.
 * - An absent policy floor gives {@link OPEN_POLICY_FLOOR}.
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

/** A resolved point on the two danger axes, risk and boundary. */
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
 * Joins two tier claims by {@link RISK_TIER_DANGER_RANK}: `low < medium < high < unknown`.
 * `resolveRequirements` is monotone in this order, because `effectiveRiskTier` resolves an unknown tier to `'high'`.
 */
export function joinRiskTier(
  a: ResolvedRiskTier,
  b: ResolvedRiskTier,
): ResolvedRiskTier {
  return RISK_TIER_DANGER_RANK[a] >= RISK_TIER_DANGER_RANK[b] ? a : b;
}

/**
 * The componentwise join of two danger coordinates on the obligation lattice. It is not the full same-call floor.
 * The ladder escalates `'unknown'` to the strongest cell, but the review roster reads it as no tier claim.
 * Thus no single coordinate dominates both resolvers.
 * `executeTransition` unites the gate sets resolved at each coordinate, and joins the coordinates with this function.
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
 * Joins two resolution contexts into the context of one transition.
 * It joins each danger axis, unites the declared gates, and keeps the stronger policy floor.
 * `resolveRequirements` is monotone in each input, so the join resolves a set at least as strong as either input gives.
 * Both contexts must name the same `phaseKind`. The kind and optional fields of `a`, the incumbent, win.
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
