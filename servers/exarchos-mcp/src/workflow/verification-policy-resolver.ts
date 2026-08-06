// ─── Verification Policy Resolver (config-over-builtin composer) ─────────────
//
// This module is the ONE AND ONLY place that composes `.exarchos.yml`
// verification overrides with the frozen built-in policy table in
// `workflow/verification-policy.ts`. Every consumer that needs "which gates run
// for a task" — the delegation stamp, gate self-skip, the phase playbooks —
// MUST import `resolveVerificationPolicy` from THIS module and NEVER call
// `resolveVerificationSequence` directly. The base table (slice 1) is config-
// blind by design; the override layer composes ON TOP of it here. A sibling
// repo-conformance guard test enforces the "import the resolver, not the table"
// rule across the codebase.
//
// ── Resolution semantics (cell-wise FULL replacement, NO delta merging) ─────
// A task profile is one of six cells: (riskTier ∈ {low,medium,high}) ×
// (boundaryTouching ∈ {false,true}). For each cell, resolution is all-or-
// nothing:
//   - `boundaryTouching === false` selects `policy[riskTier]`;
//     `boundaryTouching === true` selects `policy.boundary?.[riskTier]`.
//   - If that cell is PRESENT in config — INCLUDING an explicit empty array,
//     which is the legitimate "run nothing for this cell" override — its value
//     is returned verbatim (frozen), `source: 'config'`. The base table's
//     sequence for that cell is fully REPLACED, never merged.
//   - If the cell is unset (or there is no config / no `verification` block),
//     resolution delegates to `resolveVerificationSequence(...)` and reports
//     `source: 'builtin'`.
//
// The function is synchronous, pure, and does NO I/O: it reads no filesystem
// and loads no config — the caller resolves and passes `ResolvedProjectConfig`
// in. The returned `sequence` is ALWAYS frozen and is never aliased to a
// caller-mutable array.
// ────────────────────────────────────────────────────────────────────────────

import {
  resolveVerificationSequence,
  type GateName,
  type RiskTier,
} from './verification-policy.js';
import type { ResolvedProjectConfig } from '../config/resolve.js';

/** Where a resolved verification sequence came from. */
export type VerificationPolicySource = 'builtin' | 'config';

// ─── DR-10 (T-14): monotonic, fail-safe requirement resolution ──────────────
//
// Requirement resolution must be MONOTONIC: an unresolved input can only ever
// select a STRONGER obligation, never a weaker one. Before this, `tools.ts`
// collapsed an absent or malformed `riskTier` to the literal `'low'` and
// hardcoded `boundaryTouching: false` — the two WEAKEST coordinates of the
// six-cell ladder. That is unsound in the exact way the ladder exists to
// prevent: a task whose blast radius is UNKNOWN was verified as though it were
// known to be trivial. It is worse than a silent default, because `'low'` is a
// positive claim that a project's `.exarchos.yml` can bind to an empty cell
// (`verification.policy.low: []` is the legitimate "run nothing here"
// override) — so an unknown tier could resolve to ZERO gates.
//
// The fix introduces `'unknown'` as a first-class, non-tier value so the
// absence of a claim is representable and can never masquerade as `low`.

/**
 * A risk tier resolved from untrusted state: a real tier, or the explicit
 * `'unknown'` when no trustworthy claim exists. `'unknown'` is deliberately NOT
 * a member of {@link RiskTier} — it is the absence of a tier claim, and the
 * type system forces every consumer to say what it does with that absence.
 */
export type ResolvedRiskTier = RiskTier | 'unknown';

/**
 * The risk tiers in ascending DANGER order (`low < medium < high < unknown`).
 * `'unknown'` is the top: raising an input toward "we do not know" never lowers
 * strength.
 */
export const RESOLVED_RISK_TIERS = ['low', 'medium', 'high', 'unknown'] as const;

/**
 * Danger rank of each risk tier — the single source of the
 * `low < medium < high < unknown` ordering, and the only ordering any consumer
 * may use to compare two tier claims.
 */
export const RISK_TIER_DANGER_RANK: Readonly<Record<ResolvedRiskTier, number>> =
  Object.freeze({ low: 0, medium: 1, high: 2, unknown: 3 });

const RISK_TIERS: ReadonlySet<string> = new Set<RiskTier>(['low', 'medium', 'high']);

/**
 * Resolve a risk tier from an untrusted value (workflow state is
 * `.passthrough()`, so the stamp may be absent, the wrong type, or a typo).
 *
 * ABSENT OR MALFORMED NEVER RESOLVES TO `'low'` — that is the DR-10 acceptance
 * criterion. It resolves to `'unknown'`, which each consumer must then project
 * onto its own fail-safe.
 *
 * DR-10 (T-15): this is the SINGLE authority for the normalization.
 * `admission/requirement-context.ts` re-exports it as `normalizeRiskTier`
 * rather than carrying a second implementation — the direction is fixed by the
 * import graph (`phase-kind → verification-policy-resolver`, so the reverse
 * edge would close a cycle).
 */
export function resolveRiskTier(raw: unknown): ResolvedRiskTier {
  return typeof raw === 'string' && RISK_TIERS.has(raw)
    ? (raw as RiskTier)
    : 'unknown';
}

// ─── Boundary status: the three-valued lattice (DR-10 / T-15) ───────────────
//
// The boundary axis has TWO vocabularies in this codebase, and only one of them
// is expressive enough to be canonical:
//
//   - the three-valued `BoundaryStatus` lattice, which can say
//     `'indeterminate'` — "no decided claim" — as a first-class member;
//   - the `boolean` the six-cell verification ladder consumes.
//
// The lattice is strictly richer, so IT is canonical and the boolean is DERIVED
// from it (`boundaryStatusTouches`), never the other way round. Collapsing to
// the boolean first would erase the distinction between "decided: no boundary"
// and "we never established one" — the exact erasure DR-10 exists to undo.

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
 * Exactly two kinds of value are BELIEVED:
 *   - a decided `boolean`, and
 *   - a literal member of the lattice's own vocabulary (`'touching'` /
 *     `'not-touching'`), which is a caller restating a decided status.
 *
 * Everything else — absent, `null`, a number, and notably the STRINGIFIED
 * booleans `'true'` / `'false'` — resolves to `'indeterminate'`. A stringified
 * boolean is a malformed boolean, not a decided one; believing it is the same
 * "assert the weakest coordinate on no evidence" move DR-10 removes. This is
 * the strictness the ladder-facing `resolveBoundaryTouching` has always had,
 * now applied at the single normalization authority.
 */
export function normalizeBoundaryStatus(raw: unknown): BoundaryStatus {
  if (raw === true || raw === 'touching') return 'touching';
  if (raw === false || raw === 'not-touching') return 'not-touching';
  return 'indeterminate';
}

/**
 * Project a {@link BoundaryStatus} onto the ladder-facing boolean. Only a
 * decided `'not-touching'` clears the flag; `'indeterminate'` selects the
 * boundary ladder, because "we do not know whether this crosses a boundary"
 * must resolve to the stronger cell.
 */
export function boundaryStatusTouches(status: BoundaryStatus): boolean {
  return status !== 'not-touching';
}

/**
 * Resolve `boundaryTouching` from an untrusted value, failing SAFE.
 *
 * Defined as the composition of the two functions above, so the boolean form
 * can never drift from the lattice: normalize into the three-valued status,
 * then project. Absent / malformed ⇒ `'indeterminate'` ⇒ `true`. The previous
 * hardcoded `false` asserted the opposite on no evidence at all.
 */
export function resolveBoundaryTouching(raw: unknown): boolean {
  return boundaryStatusTouches(normalizeBoundaryStatus(raw));
}

/** A concrete six-cell ladder coordinate. */
export interface VerificationProfile {
  readonly riskTier: RiskTier;
  readonly boundaryTouching: boolean;
}

/**
 * Project a possibly-unknown tier onto the ladder coordinate it must be
 * VERIFIED at — the strongest cell (`high`, boundary-touching) when the tier is
 * unknown, and the stated cell otherwise.
 *
 * This is the fail-safe for the "which gates RUN" consumer, where the hazard is
 * UNDER-verification. Note that it also routes an unknown tier away from every
 * weaker config cell: the resolved cell is `policy.boundary.high`, so a
 * `policy.low: []` override can never apply to a task whose tier nobody
 * established.
 */
export function failSafeVerificationProfile(
  riskTier: ResolvedRiskTier,
  boundaryTouching: boolean,
): VerificationProfile {
  if (riskTier === 'unknown') return { riskTier: 'high', boundaryTouching: true };
  return { riskTier, boundaryTouching };
}

/**
 * Project a possibly-unknown tier onto the tier argument for the REVIEW
 * dimension roster (`review-contract.ts::getRequiredReviews`).
 *
 * The fail-safe direction here is NOT the same as
 * {@link failSafeVerificationProfile}, and the difference is deliberate rather
 * than an oversight — the two consumers have opposite failure modes:
 *
 *   - the verification LADDER decides which gates RUN, so an unknown tier must
 *     select the strongest cell; running an extra gate is recoverable.
 *   - the REVIEW ROSTER decides which review dimensions must be PRESENT AND
 *     PASSING before the review→synthesize guard opens. Fabricating a `'high'`
 *     claim there would inject the tier-coupled `mutation-adequacy` dimension
 *     into every workflow that was never tier-stamped, and no producer would
 *     ever satisfy it — a permanent deadlock, which is strictly worse than the
 *     base roster.
 *
 * So an unknown tier yields `undefined`: NO tier claim, hence no tier-coupled
 * dimensions. Critically this is not the same as claiming `'low'` — the roster
 * makes no positive assertion about blast radius, and there is no config cell
 * for it to bind an empty override to.
 */
export function reviewRosterTier(riskTier: ResolvedRiskTier): RiskTier | undefined {
  return riskTier === 'unknown' ? undefined : riskTier;
}

/** A resolved verification sequence plus its provenance. */
export interface ResolvedVerificationPolicy {
  /** Ordered, frozen gate sequence for the requested task profile. */
  readonly sequence: readonly GateName[];
  /** `'config'` if an `.exarchos.yml` cell won; `'builtin'` if the base table did. */
  readonly source: VerificationPolicySource;
}

/**
 * Resolve the verification gate sequence for a `(riskTier, boundaryTouching)`
 * task profile, layering the project config overlay over the frozen built-in
 * table. See the module header for the full cell-wise replacement semantics.
 *
 * DR-10: `riskTier` accepts `'unknown'`, which resolves through
 * {@link failSafeVerificationProfile} to the strongest cell rather than being
 * collapsed to `'low'` by the caller. Callers holding a real {@link RiskTier}
 * are unaffected — `'unknown'` was previously unrepresentable, so no existing
 * resolution changes.
 *
 * @param riskTier         the task's blast-radius tier, or `'unknown'`
 * @param boundaryTouching whether the task crosses an I/O / schema boundary
 * @param config           the resolved project config (overlay source); omit
 *                         (or pass a config whose cell is unset) to fall through
 *                         to the built-in table
 * @returns the frozen, ordered gate sequence plus its `source` provenance
 */
export function resolveVerificationPolicy(
  riskTier: ResolvedRiskTier,
  boundaryTouching: boolean,
  config?: ResolvedProjectConfig,
): ResolvedVerificationPolicy {
  const profile = failSafeVerificationProfile(riskTier, boundaryTouching);
  // Optional-chain through `verification` too: a present-but-partial config
  // object (one predating the `verification` overlay) must behave as no-config
  // rather than throw. `config?.verification.policy` would TypeError when
  // `verification` is absent; `config?.verification?.policy` degrades to the
  // built-in table. (task 004)
  const policy = config?.verification?.policy;
  const cell = profile.boundaryTouching
    ? policy?.boundary?.[profile.riskTier]
    : policy?.[profile.riskTier];

  // Cell PRESENT (including an explicit empty array) → full replacement.
  // Copy before freezing so the returned sequence is never aliased to the
  // caller's overlay array.
  if (cell !== undefined) {
    return { sequence: Object.freeze([...cell]), source: 'config' };
  }

  // Cell unset / no config → the built-in table (already frozen by slice 1).
  return {
    sequence: resolveVerificationSequence(profile.riskTier, profile.boundaryTouching),
    source: 'builtin',
  };
}
