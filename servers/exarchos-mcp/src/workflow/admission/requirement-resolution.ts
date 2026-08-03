// ─── P06-03 / Task 018 — Monotonic requirement resolution ────────────────────
//
// `resolveRequirements(context)` folds the complete input lattice
// (`RequirementContext`) into a single deeply-frozen `ResolvedRequirements`
// lattice point. The whole point is MONOTONICITY: raising any input toward
// "more dangerous / more uncertain" can only produce an at-least-as-strong
// requirement set. Never weaker. In particular `risk: 'unknown'` resolves at
// least as strong as `'high'`, and is NEVER coerced to `'low'`.
//
// Monotonicity is guaranteed BY CONSTRUCTION, not by inspection:
//
//   resolveRequirements(ctx) = joinAll([ c1(ctx), c2(ctx), … ])
//
// where each contribution cᵢ is itself monotone in its input dimension, and
// `join` (the lattice LUB) is monotone in both arguments. A join of monotone
// contributions is monotone — so the resolver cannot silently weaken under a
// raised input, and the property tests confirm it across the lattice.
//
// Contributions:
//   1. phase-kind gate obligations — via `resolveGateSet` (the existing
//      per-kind resolver), fed the EFFECTIVE risk/boundary (unknown⇒high,
//      indeterminate⇒touching), so it is monotone in both danger dimensions;
//   2. explicitly declared gates;
//   3. risk obligations       — approvals + corroboration, by danger rank;
//   4. boundary obligations   — corroboration when the status is indeterminate;
//   5. reliability obligations — corroboration when degraded / unknown
//      (Task 018: "consume reliability only as monotonic corroboration");
//   6. the policy floor        — baseline approvals + waivability.
//
// Pure, total, deterministic: no I/O, no clock, no config reads; every context
// resolves; the same context always yields the same frozen set.

import type { RiskTier } from '../verification-policy.js';
import { resolveGateSet, type ResolveGateSetCtx } from '../phase-kind.js';
import {
  type BoundaryStatus,
  type ReliabilityState,
  type RequirementContext,
  type ResolvedRiskTier,
} from './requirement-context.js';
import {
  BOTTOM_REQUIREMENTS,
  joinAll,
  type FrozenResolvedRequirements,
  type ResolvedRequirements,
} from './requirement-strength.js';

// ─── Effective (gate-facing) projections of the danger dimensions ────────────

/**
 * The known {@link RiskTier} the gate resolver should run at. `'unknown'`
 * projects to `'high'` — the strongest KNOWN tier — so an unclassified task
 * gets at least the high-tier gate set. It is NEVER projected to `'low'`.
 */
export function effectiveRiskTier(risk: ResolvedRiskTier): RiskTier {
  return risk === 'unknown' ? 'high' : risk;
}

/**
 * The boolean boundary-touching flag the gate resolver should run at.
 * `'indeterminate'` projects to `true` (treated as touching) so an undecided
 * boundary gets at least the boundary-touching gate set. It is NEVER projected
 * to `false`.
 */
export function effectiveBoundaryTouching(boundary: BoundaryStatus): boolean {
  return boundary !== 'not-touching';
}

// ─── Per-dimension obligation tables ─────────────────────────────────────────

/**
 * Approvals + corroboration granted by the risk tier alone, keyed by danger
 * rank so the values are non-decreasing along `low ≤ medium ≤ high ≤ unknown`.
 * `unknown` is STRICTLY stronger than `high` (it adds corroboration): an
 * unknown risk cannot resolve equal to — let alone weaker than — a known tier.
 */
const RISK_OBLIGATIONS: Readonly<
  Record<ResolvedRiskTier, { readonly approvals: number; readonly corroboration: number }>
> = Object.freeze({
  low: Object.freeze({ approvals: 0, corroboration: 0 }),
  medium: Object.freeze({ approvals: 0, corroboration: 0 }),
  high: Object.freeze({ approvals: 1, corroboration: 0 }),
  unknown: Object.freeze({ approvals: 1, corroboration: 2 }),
});

/**
 * Corroboration granted by the boundary status alone. `touching` adds no
 * corroboration here — its extra strength is the boundary gate set (via the
 * effective projection). `indeterminate` DOES add corroboration, making it
 * strictly stronger than `touching`.
 */
const BOUNDARY_CORROBORATION: Readonly<Record<BoundaryStatus, number>> =
  Object.freeze({ 'not-touching': 0, touching: 0, indeterminate: 2 });

/**
 * Corroboration granted by reliability uncertainty. Task 018: reliability is
 * consumed ONLY as monotonic corroboration — a degraded or unknown reliability
 * verdict can only ADD corroborating-source obligations, never remove gates or
 * lower any floor. Non-decreasing along `reliable ≤ degraded ≤ unknown`.
 */
const RELIABILITY_CORROBORATION: Readonly<Record<ReliabilityState, number>> =
  Object.freeze({ reliable: 0, degraded: 2, unknown: 3 });

// ─── Contributions ───────────────────────────────────────────────────────────

function gateContribution(ctx: RequirementContext): ResolvedRequirements {
  const gateCtx: ResolveGateSetCtx = {
    riskTier: effectiveRiskTier(ctx.risk),
    boundaryTouching: effectiveBoundaryTouching(ctx.boundary),
    ...(ctx.workflowType !== undefined ? { workflowType: ctx.workflowType } : {}),
    ...(ctx.designDepth !== undefined ? { designDepth: ctx.designDepth } : {}),
  };
  return {
    ...BOTTOM_REQUIREMENTS,
    gates: resolveGateSet(ctx.phaseKind, gateCtx),
  };
}

function declaredGateContribution(ctx: RequirementContext): ResolvedRequirements {
  return { ...BOTTOM_REQUIREMENTS, gates: ctx.declaredGates };
}

function riskContribution(ctx: RequirementContext): ResolvedRequirements {
  const o = RISK_OBLIGATIONS[ctx.risk];
  return {
    ...BOTTOM_REQUIREMENTS,
    minimumApprovals: o.approvals,
    minimumCorroboratingSources: o.corroboration,
  };
}

function boundaryContribution(ctx: RequirementContext): ResolvedRequirements {
  return {
    ...BOTTOM_REQUIREMENTS,
    minimumCorroboratingSources: BOUNDARY_CORROBORATION[ctx.boundary],
  };
}

function reliabilityContribution(ctx: RequirementContext): ResolvedRequirements {
  return {
    ...BOTTOM_REQUIREMENTS,
    minimumCorroboratingSources: RELIABILITY_CORROBORATION[ctx.reliability],
  };
}

function policyContribution(ctx: RequirementContext): ResolvedRequirements {
  return {
    ...BOTTOM_REQUIREMENTS,
    minimumApprovals: ctx.policy.minimumApprovals,
    waivable: ctx.policy.waivable,
  };
}

// ─── The resolver ────────────────────────────────────────────────────────────

/**
 * Resolve a complete, deeply-frozen requirement set from a normalized context.
 *
 * Total (every context resolves), pure (no I/O), deterministic (same context ⇒
 * same result), and monotone in every danger dimension. The returned value is
 * immutable — mutating it throws in strict mode.
 */
export function resolveRequirements(
  context: RequirementContext,
): FrozenResolvedRequirements {
  return joinAll([
    gateContribution(context),
    declaredGateContribution(context),
    riskContribution(context),
    boundaryContribution(context),
    reliabilityContribution(context),
    policyContribution(context),
  ]);
}
