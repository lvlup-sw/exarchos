// ─── Phase-Kind Obligation Layer (single grant-point) ───────────────────────
//
// A closed `PhaseKind` union and a frozen `KIND_OBLIGATIONS` table — the one
// place where kind-universal obligations are granted. The table is keyed only
// by kind, never by workflow type, phase id, or transition. This is INV-6
// (workload-agnosticism) made type-level: an obligation attaches to the *kind*,
// so it composes across every workflow type — present and future — without new
// playbook code. See `docs/designs/2026-06-16-phase-kind-binding.md` (DR-1).
//
// INV-6 GUARD: no workflow names / phase ids / transitions here — only
// kind-universal obligations. (The resolver wiring lives in later tasks.)

import { resolveVerificationPolicy } from './verification-policy-resolver.js';
import { type GateName, type RiskTier } from './verification-policy.js';
import {
  type DesignDepth,
  type PlanDepthGateName,
  resolvePlanDepthPolicy,
} from './plan-depth-policy.js';
import { getRequiredReviews, type ReviewDimension } from './review-contract.js';
import type { ResolvedProjectConfig } from '../config/resolve.js';

/**
 * The closed set of phase kinds. Adding or removing a member is a breaking
 * change that must be reflected in `KIND_OBLIGATIONS` (enforced by the
 * `satisfies Record<PhaseKind, …>` constraint below).
 */
export type PhaseKind = 'IMPLEMENT' | 'PLAN' | 'REVIEW' | 'SYNTHESIZE' | 'GATHER';

/**
 * The obligations granted to a phase by virtue of its kind.
 *
 * - `gates`  — the gate-resolver binding for this kind, or `null` when the kind
 *   carries no verification gates (e.g. GATHER). The `resolver` is a name the
 *   gate-set resolver dispatches on (wired in a later task); the kind layer
 *   itself holds no resolver logic.
 * - `posture` — the execution posture for the kind. Declared now so the table
 *   shape is stable, but **inert** in this layer: it is not yet wired to a
 *   capability bundle.
 */
/**
 * The closed set of gate-resolver names. Typing `gates.resolver` as this union
 * (not `string`) makes a resolver typo in `KIND_OBLIGATIONS` — or a name with no
 * `GATE_RESOLVERS` entry — a COMPILE error instead of a runtime-only fault, so
 * the table and the resolver registry cannot drift apart silently.
 */
export type GateResolverName =
  | 'verification-ladder'
  | 'plan-structure'
  | 'review-contract'
  | 'synthesis-readiness';

// ─── DR-8: discriminated ResolvedGate union ─────────────────────────────────
//
// A gate-set resolves to a sequence of `ResolvedGate`s tagged by `family`. The
// four families are heterogeneous — ladder gates, plan-structure gates, review
// dimensions, and synthesis-readiness legs are different vocabularies — so they
// are kept as distinct discriminated members rather than flattened into one
// `GateName` namespace. The `family` tag makes downstream dispatch exhaustively
// checkable (a missing arm is a compile error via the `assertNever` helper).

/**
 * Plan-structure gate names (PLAN kind). Sourced from `plan-depth-policy.ts`
 * (`PlanDepthGateName`), the single source of truth for which gates a depth
 * rung may emit — so this type never drifts from the policy table. At the
 * `'standard'` default rung the set is exactly the registry `PLAN_PHASES`
 * actions (decompose → coverage → spec-coverage → provenance → traceability);
 * the `'deep'` rung adds the `check_exploration_depth` obligation (DR-7), which
 * is therefore a member here so the `'plan'` family of {@link ResolvedGate} can
 * carry it. (`check_exploration_depth` has no registry action yet — its gate
 * wiring is DR-7/tasks 016+018; it is reachable only at opt-in `'deep'` depth.)
 */
export type PlanGateName = PlanDepthGateName;

/** Synthesis-readiness legs (SYNTHESIZE kind). */
export type SynthesisLeg = 'task-completion' | 'tests' | 'typecheck' | 'stack';

/**
 * One resolved gate, tagged by its family. `ReviewDimension` is re-exported
 * from `review-contract.ts` (the single source of truth) — the review family
 * carries the dimension string, it does not re-declare the vocabulary.
 */
export type ResolvedGate =
  | { readonly family: 'ladder'; readonly gate: GateName }
  | { readonly family: 'plan'; readonly gate: PlanGateName }
  | { readonly family: 'review'; readonly gate: ReviewDimension }
  | { readonly family: 'synthesis'; readonly gate: SynthesisLeg };

export type { ReviewDimension };

/**
 * Exhaustiveness guard for `ResolvedGate.family` dispatch: a `switch` over
 * `family` whose `default` calls `assertNever(g)` becomes a COMPILE error the
 * moment a new family is added without a handling arm.
 */
export function assertNever(value: never): never {
  throw new Error(`Unhandled ResolvedGate family: ${JSON.stringify(value)}`);
}

/**
 * Extract the ordered ladder `GateName` sequence from a resolved gate-set,
 * dropping any non-ladder family. The IMPLEMENT kind only ever yields ladder
 * gates, so this is the lossless adapter the per-task dispatch path uses to keep
 * `verificationSequence: readonly GateName[]` (and its event schema) stable.
 */
export function ladderGateNames(gates: readonly ResolvedGate[]): readonly GateName[] {
  return gates
    .filter((g): g is Extract<ResolvedGate, { family: 'ladder' }> => g.family === 'ladder')
    .map((g) => g.gate);
}

export interface PhaseObligations {
  readonly gates: { readonly resolver: GateResolverName } | null;
  readonly posture: 'read-only' | 'task-isolated' | 'shared-mutating';
}

/**
 * The single grant-point: one obligation row per phase kind.
 *
 * `satisfies Record<PhaseKind, PhaseObligations>` is load-bearing — removing a
 * kind row (or adding a kind without a row) is a COMPILE error, which keeps the
 * union and the table exhaustively in lock-step.
 */
export const KIND_OBLIGATIONS = {
  IMPLEMENT: { gates: { resolver: 'verification-ladder' }, posture: 'task-isolated' },
  PLAN: { gates: { resolver: 'plan-structure' }, posture: 'read-only' },
  REVIEW: { gates: { resolver: 'review-contract' }, posture: 'read-only' },
  SYNTHESIZE: { gates: { resolver: 'synthesis-readiness' }, posture: 'shared-mutating' },
  GATHER: { gates: null, posture: 'read-only' },
} as const satisfies Record<PhaseKind, PhaseObligations>;

// ─── Gate-Set Resolver (kind → ordered gate sequence) ───────────────────────
//
// Behavior-neutral dispatch from a phase kind to its ordered gate sequence. The
// kind layer holds no gate logic of its own: it reads the kind's `gates.resolver`
// name from `KIND_OBLIGATIONS` and dispatches to a named resolver. In this slice
// only `'verification-ladder'` (IMPLEMENT) is wired — it delegates verbatim to
// `resolveVerificationPolicy`, so an IMPLEMENT boundary resolves to EXACTLY the
// same sequence it does today (proven cell-by-cell in the test). The remaining
// resolver names are registered but inert; wiring them is deferred to S3.

/** Context a gate resolver needs to compute the sequence for a phase. */
export interface ResolveGateSetCtx {
  readonly riskTier: RiskTier;
  readonly boundaryTouching: boolean;
  readonly config?: ResolvedProjectConfig;
  /**
   * The workflow type of the phase being resolved (e.g. `'feature'`). The
   * REVIEW resolver keys its dimension roster off this (review dimensions vary
   * by workflow type — INV-6 binds by *kind*, the resolver output may depend on
   * ctx, exactly as the IMPLEMENT ladder depends on `riskTier`). Absent ⇒ the
   * review roster falls back to the empty base, never throws.
   */
  readonly workflowType?: string;
  /**
   * The feature's frozen planning depth (thin ⊂ standard ⊂ deep). The
   * `'plan-structure'` resolver keys its gate sequence off this (the depth-axis
   * twin of how the IMPLEMENT ladder keys off `riskTier`), resolved once at PLAN
   * `phase.entered` and frozen (task 005), never re-derived here. This field is
   * the *carrier* on the resolution ctx (DR-1); task 003 graduates the resolver
   * to read it. Absent ⇒ `'standard'` at the resolver — the behavior-neutral
   * default that preserves today's static 5-gate plan-structure binding for
   * every pre-existing call site, never throws.
   */
  readonly designDepth?: DesignDepth;
}

/**
 * Named gate-resolver registry, keyed by the `gates.resolver` string in
 * `KIND_OBLIGATIONS`. Centralising dispatch here keeps the kind layer
 * extensible for S3: wiring a deferred kind is replacing its thrower entry,
 * not editing `resolveGateSet`'s control flow.
 *
 * The inert entries fail LOUD on purpose — they are never reached at an
 * IMPLEMENT boundary in S1/S2, so any call is a wiring mistake, not a valid
 * runtime path.
 */
const GATE_RESOLVERS: Readonly<
  Record<GateResolverName, (ctx: ResolveGateSetCtx) => readonly ResolvedGate[]>
> = Object.freeze({
  'verification-ladder': (ctx) =>
    resolveVerificationPolicy(ctx.riskTier, ctx.boundaryTouching, ctx.config).sequence.map(
      (gate): ResolvedGate => ({ family: 'ladder', gate }),
    ),
  // The plan-structure gate-set (DR-2), resolved off the feature's frozen
  // `designDepth` — the depth-axis twin of how `'verification-ladder'` resolves
  // off `riskTier`. The ordered sequence is owned by `plan-depth-policy.ts`
  // (`resolvePlanDepthPolicy`, the single source of truth); this resolver names
  // no gates of its own. `designDepth` absent ⇒ `'standard'`, whose sequence is
  // exactly the registry's `PLAN_PHASES`-bound gates in plan-validation order
  // (decompose → coverage → provenance → traceability) — the behavior-neutral
  // default pinned by `PlanStructureResolver_StandardDepth_MatchesRegistryPlanPhasesBinding`,
  // so graduating to ctx-reading changes nothing at the default depth. `deep`
  // adds the `check_exploration_depth` obligation (DR-7). Membership is the
  // obligation; per-gate severity (`generate_traceability` is advisory) is the
  // resolved *mode*, handled at the severity binding, not by excluding it.
  'plan-structure': (ctx) =>
    resolvePlanDepthPolicy(ctx.designDepth ?? 'standard', ctx.config).sequence.map(
      (gate): ResolvedGate => ({ family: 'plan', gate }),
    ),
  // The review-contract gate-set (DR-9). Resolves verbatim from
  // `getRequiredReviews` so the dimension vocabulary stays owned by
  // `review-contract.ts` (the single source of truth, pinned by the
  // `MatchesReviewContractSoT` test) — never re-listed here. The roster is the
  // workflow-type base plus tier-coupled dimensions (e.g. `mutation-adequacy`
  // at HIGH tier), keyed off the resolution `ctx`.
  'review-contract': (ctx) =>
    getRequiredReviews(ctx.workflowType ?? '', ctx.riskTier).map(
      (gate): ResolvedGate => ({ family: 'review', gate }),
    ),
  // The synthesis-readiness gate-set (DR-9): the four `prepare_synthesis` legs
  // in evaluation order — task completion gates the build legs (tests, typecheck,
  // stack). Readiness derivation (which source the task-completion leg folds) is
  // owned by `prepare-synthesis.ts`; this resolver names the obligation order.
  'synthesis-readiness': () =>
    (['task-completion', 'tests', 'typecheck', 'stack'] as const).map(
      (gate): ResolvedGate => ({ family: 'synthesis', gate }),
    ),
});

/**
 * Resolve the ordered gate sequence a phase of the given `kind` must run.
 *
 * Pure and synchronous: it does NO I/O. The verification ladder reads config
 * from the `ResolvedProjectConfig` the caller threads through `ctx`, never the
 * filesystem.
 *
 * @param kind the phase kind whose obligations to resolve
 * @param ctx  the task profile (risk tier, boundary-touching) plus optional
 *             resolved project config for the verification overlay
 * @returns the ordered gate sequence, or `[]` for a kind with no gates (GATHER)
 */
/**
 * Fail-closed outcome of a phase-boundary gate-set resolution (DR-10). A
 * resolver fault (an unwired future kind, a malformed config) must never fail
 * the transition OPEN — the boundary resolves to `{ ok: false }` and the caller
 * appends `phase.blocked` rather than proceeding silently.
 */
export type PhaseObligationOutcome =
  | { readonly ok: true; readonly gates: readonly ResolvedGate[] }
  | { readonly ok: false; readonly reason: string };

/**
 * Resolve a phase kind's gate-set, converting any resolver throw into a
 * fail-closed `{ ok: false }` outcome. The `resolver` parameter defaults to
 * {@link resolveGateSet}; it is injectable so the fail-closed branch is directly
 * testable (no valid kind throws today — the guard is for future unwired kinds).
 */
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

export function resolveGateSet(kind: PhaseKind, ctx: ResolveGateSetCtx): readonly ResolvedGate[] {
  const gates = KIND_OBLIGATIONS[kind].gates;
  if (gates === null) {
    return [];
  }

  const resolver = GATE_RESOLVERS[gates.resolver];
  if (resolver === undefined) {
    // Defensive default: a `gates.resolver` name with no registry entry is a
    // table/registry desync, not a valid runtime state.
    throw new Error(`resolveGateSet: unknown resolver '${gates.resolver}'`);
  }
  return resolver(ctx);
}
