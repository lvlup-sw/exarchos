// A closed `PhaseKind` union and the frozen `KIND_OBLIGATIONS` table. The table is the one place
// that grants obligations to a phase kind. Its key is the kind only, never a workflow type, a phase
// id, or a transition. An obligation attaches to the kind, so it applies to every workflow type
// without new playbook code. The table must hold no workflow name, phase id, or transition.

import {
  resolveVerificationPolicy,
  reviewRosterTier,
  type ResolvedRiskTier,
} from './verification-policy-resolver.js';
import { type GateName } from './verification-policy.js';
import {
  type DesignDepth,
  type PlanDepthGateName,
  resolvePlanDepthPolicy,
} from './plan-depth-policy.js';
import { getRequiredReviews, type ReviewDimension } from './review-contract.js';
import type { ResolvedProjectConfig } from '../config/resolve.js';

/** The closed set of phase kinds. Each member must have a row in `KIND_OBLIGATIONS`, and the compiler enforces it. */
export type PhaseKind = 'IMPLEMENT' | 'PLAN' | 'REVIEW' | 'SYNTHESIZE' | 'MERGE' | 'GATHER';

/**
 * The closed set of gate-resolver names.
 * A typo in `KIND_OBLIGATIONS`, or a name with no `GATE_RESOLVERS` entry, is a compile error.
 */
export type GateResolverName =
  | 'verification-ladder'
  | 'plan-structure'
  | 'review-contract'
  | 'synthesis-readiness';

/**
 * Plan-structure gate names for the PLAN kind. The type comes from the policy table in
 * `plan-depth-policy.ts`, so it cannot drift from it. `check_exploration_depth` runs only at the opt-in `'deep'` depth.
 */
export type PlanGateName = PlanDepthGateName;

/**
 * Synthesis-readiness legs for the SYNTHESIZE kind, in obligation order. `prepare-synthesis.ts` evaluates each leg.
 * When the changeset touches a doc-bearing surface, the `'document'` leg requires changed docs. Otherwise it waives itself.
 * It comes before `'stack'`, so a docs gap shows together with the build legs.
 */
export type SynthesisLeg = 'task-completion' | 'tests' | 'typecheck' | 'document' | 'stack';

/** One resolved gate, tagged by its family. The four families use different vocabularies, so each stays a separate member. */
export type ResolvedGate =
  | { readonly family: 'ladder'; readonly gate: GateName }
  | { readonly family: 'plan'; readonly gate: PlanGateName }
  | { readonly family: 'review'; readonly gate: ReviewDimension }
  | { readonly family: 'synthesis'; readonly gate: SynthesisLeg };

export type { ReviewDimension };

/**
 * Returns the ladder gates of a resolved gate-set in order, and drops the other families.
 * The IMPLEMENT kind yields only ladder gates, so the per-task dispatch path loses nothing.
 */
export function ladderGateNames(gates: readonly ResolvedGate[]): readonly GateName[] {
  return gates
    .filter((g): g is Extract<ResolvedGate, { family: 'ladder' }> => g.family === 'ladder')
    .map((g) => g.gate);
}

/**
 * The obligations that a phase gets from its kind.
 * `gates` names the gate resolver, or is `null` when the kind has no verification gates.
 * `mintCapabilitiesForKind` mints the capability bundle from `posture`.
 */
export interface PhaseObligations {
  readonly gates: { readonly resolver: GateResolverName } | null;
  readonly posture: 'read-only' | 'task-isolated' | 'shared-mutating';
}

/** The single grant point: one obligation row for each phase kind. The `satisfies` clause makes a missing row a compile error. */
export const KIND_OBLIGATIONS = {
  IMPLEMENT: { gates: { resolver: 'verification-ladder' }, posture: 'task-isolated' },
  PLAN: { gates: { resolver: 'plan-structure' }, posture: 'read-only' },
  REVIEW: { gates: { resolver: 'review-contract' }, posture: 'read-only' },
  SYNTHESIZE: { gates: { resolver: 'synthesis-readiness' }, posture: 'shared-mutating' },
  /**
   * The autonomous-merge substate (`merge-pending`). Its work is event-driven merge orchestration, so it has no gate-set.
   * It is a separate kind, so the boundary does not freeze the synthesis-readiness legs onto it. It writes the shared integration branch.
   */
  MERGE: { gates: null, posture: 'shared-mutating' },
  GATHER: { gates: null, posture: 'read-only' },
} as const satisfies Record<PhaseKind, PhaseObligations>;

/** Context a gate resolver needs to compute the sequence for a phase. */
export interface ResolveGateSetCtx {
  /**
   * The blast-radius tier of the task, or `'unknown'` when no trustworthy claim exists.
   * The kind layer passes `'unknown'` through, because its two readers fail safe in opposite directions.
   * The verification ladder escalates to the strongest cell. The review roster makes no tier claim.
   */
  readonly riskTier: ResolvedRiskTier;
  readonly boundaryTouching: boolean;
  readonly config?: ResolvedProjectConfig | undefined;
  /** The workflow type of the phase. The REVIEW resolver selects its dimension roster from it. */
  readonly workflowType?: string;
  /**
   * The planning depth of the feature. PLAN `phase.entered` resolves and freezes it once.
   * The `'plan-structure'` resolver selects its gate sequence from it, and uses `'standard'` when it is absent.
   */
  readonly designDepth?: DesignDepth;
}

/**
 * The gate resolvers, keyed by the `gates.resolver` name in `KIND_OBLIGATIONS`.
 * A new gate-bearing kind adds one entry here and does not change `resolveGateSet`.
 */
const GATE_RESOLVERS: Readonly<
  Record<GateResolverName, (ctx: ResolveGateSetCtx) => readonly ResolvedGate[]>
> = Object.freeze({
  'verification-ladder': (ctx) =>
    resolveVerificationPolicy(ctx.riskTier, ctx.boundaryTouching, ctx.config).sequence.map(
      (gate): ResolvedGate => ({ family: 'ladder', gate }),
    ),
  /**
   * Membership is the obligation. The severity binding sets the mode of each gate.
   * `generate_traceability` is advisory, but it stays in the sequence.
   */
  'plan-structure': (ctx) =>
    resolvePlanDepthPolicy(ctx.designDepth ?? 'standard', ctx.config).sequence.map(
      (gate): ResolvedGate => ({ family: 'plan', gate }),
    ),
  /** An `'unknown'` tier becomes no tier claim and does not escalate, so an unstamped workflow does not get `mutation-adequacy`. */
  'review-contract': (ctx) =>
    getRequiredReviews(ctx.workflowType ?? '', reviewRosterTier(ctx.riskTier)).map(
      (gate): ResolvedGate => ({ family: 'review', gate }),
    ),
  /** The `prepare_synthesis` legs, in obligation order. `prepare-synthesis.ts` evaluates them. */
  'synthesis-readiness': () =>
    (['task-completion', 'tests', 'typecheck', 'document', 'stack'] as const).map(
      (gate): ResolvedGate => ({ family: 'synthesis', gate }),
    ),
});

/** The result of a gate-set resolution at a phase boundary. A resolver throw gives `{ ok: false }`, and the caller appends `phase.blocked`. */
export type PhaseObligationOutcome =
  | { readonly ok: true; readonly gates: readonly ResolvedGate[] }
  | { readonly ok: false; readonly reason: string };

/** Resolves the gate-set of a phase kind and turns a resolver throw into `{ ok: false }`. A caller can inject `resolver`. */
export function resolveGateSetFailClosed(
  kind: PhaseKind,
  ctx: ResolveGateSetCtx,
  resolver: (k: PhaseKind, c: ResolveGateSetCtx) => readonly ResolvedGate[] = resolveGateSet,
): PhaseObligationOutcome {
  try {
    return { ok: true, gates: resolver(kind, ctx) };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Returns the ordered gate sequence for a phase kind, or `[]` when the kind has no gates.
 * It does no I/O. The verification ladder reads configuration only from `ctx.config`.
 * @throws when the `gates.resolver` name has no `GATE_RESOLVERS` entry.
 */
export function resolveGateSet(kind: PhaseKind, ctx: ResolveGateSetCtx): readonly ResolvedGate[] {
  const gates = KIND_OBLIGATIONS[kind].gates;
  if (gates === null) {
    return [];
  }

  const resolver = GATE_RESOLVERS[gates.resolver];
  if (resolver === undefined) {
    throw new Error(`resolveGateSet: unknown resolver '${gates.resolver}'`);
  }
  return resolver(ctx);
}

/** The plan-review adversarial rungs, ordered light ⊂ standard ⊂ panel. */
export type PlanReviewRungName = 'light' | 'standard' | 'panel';

/** A resolved plan-review rung: its name and the number of independent adversarial voters. */
export interface PlanReviewRung {
  readonly name: PlanReviewRungName;
  readonly voters: number;
}

/** The plan-review rung for each design depth. The voter count grows with the depth. */
const PLAN_REVIEW_RUNG_BY_DEPTH: Readonly<Record<DesignDepth, PlanReviewRung>> = Object.freeze({
  thin: Object.freeze({ name: 'light', voters: 1 }),
  standard: Object.freeze({ name: 'standard', voters: 2 }),
  deep: Object.freeze({ name: 'panel', voters: 3 }),
});

/**
 * Maps the frozen `designDepth` to its plan-review rung. `prepare-review.ts` builds the dispatch payload from it.
 * An absent or unknown depth gives the `'standard'` rung. Plan-review provisioning is advisory, so it never throws.
 */
export function resolvePlanReviewDepth(designDepth: DesignDepth | undefined): PlanReviewRung {
  return PLAN_REVIEW_RUNG_BY_DEPTH[designDepth ?? 'standard'] ?? PLAN_REVIEW_RUNG_BY_DEPTH.standard;
}
