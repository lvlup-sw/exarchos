/**
 * Monotonic requirement resolution.
 *
 * `resolveRequirements` folds a `RequirementContext` into one frozen `ResolvedRequirements`.
 * A more dangerous or more uncertain input can only give a set that is at least as strong.
 * Thus `risk: 'unknown'` resolves at least as strong as `'high'`, and never as `'low'`.
 * The resolver is a `joinAll` of contributions that are each monotone.
 * Because `join` is monotone too, the result is monotone by construction.
 * The resolver does no I/O, reads no clock or config, and gives the same set for the same context.
 */

import type { RiskTier } from '../verification-policy.js';
import { resolveGateSet, type ResolveGateSetCtx, type ResolvedGate } from '../phase-kind.js';
import {
  type BoundaryStatus,
  type ReliabilityState,
  type RequirementContext,
  type ResolvedRiskTier,
} from './requirement-context.js';
import {
  BOTTOM_REQUIREMENTS,
  canonicalizeGates,
  deepFreezeRequirements,
  joinAll,
  type FrozenResolvedRequirements,
  type ResolvedRequirements,
} from './requirement-strength.js';

/**
 * The known {@link RiskTier} for the gate resolver.
 * `'unknown'` becomes `'high'`, the strongest known tier, so an unclassified task gets at least the high-tier gates.
 */
export function effectiveRiskTier(risk: ResolvedRiskTier): RiskTier {
  return risk === 'unknown' ? 'high' : risk;
}

/**
 * The boundary-touching flag for the gate resolver.
 * `'indeterminate'` becomes `true`, so an undecided boundary gets at least the boundary-touching gates.
 */
export function effectiveBoundaryTouching(boundary: BoundaryStatus): boolean {
  return boundary !== 'not-touching';
}

/**
 * The approvals and corroboration from the risk tier alone.
 * The values do not decrease along `low`, `medium`, `high`, `unknown`.
 * `unknown` adds corroboration, so it is strictly stronger than every known tier.
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
 * The corroboration from the boundary status alone.
 * `touching` adds none here, because its extra strength is the boundary gate set.
 * `indeterminate` adds corroboration, so it is strictly stronger than `touching`.
 */
const BOUNDARY_CORROBORATION: Readonly<Record<BoundaryStatus, number>> =
  Object.freeze({ 'not-touching': 0, touching: 0, indeterminate: 2 });

/**
 * The corroboration from reliability uncertainty. Reliability only adds corroboration.
 * It never removes a gate or lowers a floor. The values do not decrease along `reliable`, `degraded`, `unknown`.
 */
const RELIABILITY_CORROBORATION: Readonly<Record<ReliabilityState, number>> =
  Object.freeze({ reliable: 0, degraded: 2, unknown: 3 });

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

/**
 * One ActionId-wide require. The type is local, so admission does not import the registry layer.
 * A registry `ActionContract` require is assignable to it.
 */
export type ActionIdRequirement =
  | { readonly family: ResolvedGate['family']; readonly gate: string }
  | { readonly kind: 'approvals'; readonly minimum: number }
  | { readonly kind: 'corroboration'; readonly minimum: number };

export type ActionIdRequires =
  | { readonly kind: 'none'; readonly because: string }
  | { readonly kind: 'declared'; readonly values: readonly ActionIdRequirement[] };

function isResolvedGateFamily(
  family: string,
): family is ResolvedGate['family'] {
  return (
    family === 'ladder' ||
    family === 'plan' ||
    family === 'review' ||
    family === 'synthesis'
  );
}

function asResolvedGate(requirement: ActionIdRequirement): ResolvedGate | undefined {
  if (!('family' in requirement) || !isResolvedGateFamily(requirement.family)) {
    return undefined;
  }
  return { family: requirement.family, gate: requirement.gate } as ResolvedGate;
}

/** Resolves a complete, deeply frozen requirement set from a normalized context. */
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

/**
 * Projects ActionId-wide `requires` into the obligation lattice.
 * It makes no freeze-time ids and adds no IR, phase-kind or HSM-edge obligations.
 * `none` gives the bottom set. Declared requires all apply together.
 */
export function resolveActionIdRequirements(
  requires: ActionIdRequires,
): FrozenResolvedRequirements {
  if (requires.kind === 'none') {
    return BOTTOM_REQUIREMENTS;
  }

  const gates: ResolvedGate[] = [];
  let minimumApprovals = 0;
  let minimumCorroboratingSources = 0;
  for (const requirement of requires.values) {
    const gate = asResolvedGate(requirement);
    if (gate !== undefined) {
      gates.push(gate);
      continue;
    }
    if ('kind' in requirement && requirement.kind === 'approvals') {
      minimumApprovals = Math.max(minimumApprovals, requirement.minimum);
      continue;
    }
    if ('kind' in requirement && requirement.kind === 'corroboration') {
      minimumCorroboratingSources = Math.max(
        minimumCorroboratingSources,
        requirement.minimum,
      );
    }
  }

  return deepFreezeRequirements({
    gates: canonicalizeGates(gates),
    minimumApprovals,
    minimumCorroboratingSources,
    waivable: true,
  });
}

/** Authored discriminants in contract order, empty when the contract abstains. */
export function authoredActionRequirements(
  requires: ActionIdRequires,
): readonly ActionIdRequirement[] {
  return requires.kind === 'none' ? [] : requires.values;
}
