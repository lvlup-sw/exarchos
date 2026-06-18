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
  Record<GateResolverName, (ctx: ResolveGateSetCtx) => readonly GateName[]>
> = Object.freeze({
  'verification-ladder': (ctx) =>
    resolveVerificationPolicy(ctx.riskTier, ctx.boundaryTouching, ctx.config).sequence,
  'plan-structure': () => {
    throw new Error("resolveGateSet: resolver 'plan-structure' is not wired yet (deferred to S3)");
  },
  'review-contract': () => {
    throw new Error("resolveGateSet: resolver 'review-contract' is not wired yet (deferred to S3)");
  },
  'synthesis-readiness': () => {
    throw new Error(
      "resolveGateSet: resolver 'synthesis-readiness' is not wired yet (deferred to S3)",
    );
  },
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
export function resolveGateSet(kind: PhaseKind, ctx: ResolveGateSetCtx): readonly GateName[] {
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
