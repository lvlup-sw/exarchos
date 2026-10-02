/**
 * Compose `.exarchos.yml` verification overrides with the built-in policy table.
 *
 * Each consumer that needs the gates for a task must call `resolveVerificationPolicy`
 * and must not call `resolveVerificationSequence` directly. A guard test enforces this.
 * A task profile is one of six cells: three risk tiers times two boundary values.
 * A config cell that is present, also an empty array, fully replaces the built-in
 * cell. An unset cell uses the built-in table. The module is pure and does no I/O.
 */

import {
  resolveVerificationSequence,
  type GateName,
  type RiskTier,
} from './verification-policy.js';
import type { ResolvedProjectConfig } from '../config/resolve.js';

/** Where a resolved verification sequence came from. */
export type VerificationPolicySource = 'builtin' | 'config';

/**
 * A risk tier resolved from untrusted state: a real tier, or `unknown` when no
 * trusted claim exists. Resolution is monotonic, so a missing claim can only select
 * a stronger obligation. `unknown` is not a {@link RiskTier}, so each consumer must
 * handle it, and it never counts as `low`.
 */
export type ResolvedRiskTier = RiskTier | 'unknown';

/** The risk tiers in ascending danger order. `unknown` is the most dangerous. */
export const RESOLVED_RISK_TIERS = ['low', 'medium', 'high', 'unknown'] as const;

/** The danger rank of each risk tier, with `unknown` at the top. */
export const RISK_TIER_DANGER_RANK: Readonly<Record<ResolvedRiskTier, number>> =
  Object.freeze({ low: 0, medium: 1, high: 2, unknown: 3 });

const RISK_TIERS: ReadonlySet<string> = new Set<RiskTier>(['low', 'medium', 'high']);

/**
 * Resolve a risk tier from an untrusted value. An absent or malformed value gives
 * `unknown`, never `low`. This is the single normalization authority.
 * `admission/requirement-context.ts` re-exports it as `normalizeRiskTier`.
 */
export function resolveRiskTier(raw: unknown): ResolvedRiskTier {
  return typeof raw === 'string' && RISK_TIERS.has(raw)
    ? (raw as RiskTier)
    : 'unknown';
}

/**
 * Whether a phase crosses an I/O or schema boundary. This three-valued status is
 * canonical, and the ladder boolean derives from it. `indeterminate` means no
 * decision, and it ranks above `touching` in danger.
 */
export type BoundaryStatus = 'not-touching' | 'touching' | 'indeterminate';

/** Boundary statuses in ascending danger order. */
export const BOUNDARY_STATUSES = [
  'not-touching',
  'touching',
  'indeterminate',
] as const;

/** The danger rank of each boundary status. `indeterminate` is the top. */
export const BOUNDARY_DANGER_RANK: Readonly<Record<BoundaryStatus, number>> =
  Object.freeze({ 'not-touching': 0, touching: 1, indeterminate: 2 });

/**
 * Normalize an untrusted boundary signal into a {@link BoundaryStatus}. Only a
 * `boolean`, `touching`, or `not-touching` is a decided value. Each other value
 * gives `indeterminate`, also the strings `'true'` and `'false'`.
 */
export function normalizeBoundaryStatus(raw: unknown): BoundaryStatus {
  if (raw === true || raw === 'touching') return 'touching';
  if (raw === false || raw === 'not-touching') return 'not-touching';
  return 'indeterminate';
}

/**
 * Project a {@link BoundaryStatus} onto the ladder boolean. Only `not-touching`
 * clears the flag. `indeterminate` selects the stronger boundary cell.
 */
export function boundaryStatusTouches(status: BoundaryStatus): boolean {
  return status !== 'not-touching';
}

/**
 * Resolve `boundaryTouching` from an untrusted value. It normalizes, then projects,
 * so an absent or malformed value gives `true`.
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
 * The ladder cell at which to verify a task. An `unknown` tier gives the strongest
 * cell, `high` and boundary-touching. Thus a `policy.low: []` override never
 * applies to a task with no tier claim.
 */
export function failSafeVerificationProfile(
  riskTier: ResolvedRiskTier,
  boundaryTouching: boolean,
): VerificationProfile {
  if (riskTier === 'unknown') return { riskTier: 'high', boundaryTouching: true };
  return { riskTier, boundaryTouching };
}

/**
 * The tier argument for the review roster in `getRequiredReviews`. An `unknown`
 * tier gives `undefined`, so no tier-coupled dimension applies.
 *
 * This direction is the opposite of {@link failSafeVerificationProfile} on purpose.
 * An `unknown` tier that became `high` adds `mutation-adequacy` to a workflow without a
 * tier stamp. No producer satisfies that dimension there, so the review guard deadlocks.
 */
export function reviewRosterTier(riskTier: ResolvedRiskTier): RiskTier | undefined {
  return riskTier === 'unknown' ? undefined : riskTier;
}

/** A resolved verification sequence plus its provenance. */
export interface ResolvedVerificationPolicy {
  /** Ordered, frozen gate sequence for the requested task profile. */
  readonly sequence: readonly GateName[];
  /** `config` when an `.exarchos.yml` cell applies, `builtin` when the base table applies. */
  readonly source: VerificationPolicySource;
}

/**
 * Resolve the gate sequence for a task profile. The config cell applies over the
 * built-in table. An `unknown` tier resolves through {@link failSafeVerificationProfile}.
 * A config without a `verification` block acts as no config. The returned sequence
 * is frozen and never aliases the config array.
 *
 * @param riskTier         the blast-radius tier of the task, or `'unknown'`
 * @param boundaryTouching whether the task crosses an I/O or schema boundary
 * @param config           the resolved project config. Omit it to use the built-in table.
 * @returns the frozen, ordered gate sequence and its `source`
 */
export function resolveVerificationPolicy(
  riskTier: ResolvedRiskTier,
  boundaryTouching: boolean,
  config?: ResolvedProjectConfig,
): ResolvedVerificationPolicy {
  const profile = failSafeVerificationProfile(riskTier, boundaryTouching);
  const policy = config?.verification?.policy;
  const cell = profile.boundaryTouching
    ? policy?.boundary?.[profile.riskTier]
    : policy?.[profile.riskTier];

  if (cell !== undefined) {
    return { sequence: Object.freeze([...cell]), source: 'config' };
  }

  return {
    sequence: resolveVerificationSequence(profile.riskTier, profile.boundaryTouching),
    source: 'builtin',
  };
}
