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
 * @param riskTier         the task's blast-radius tier
 * @param boundaryTouching whether the task crosses an I/O / schema boundary
 * @param config           the resolved project config (overlay source); omit
 *                         (or pass a config whose cell is unset) to fall through
 *                         to the built-in table
 * @returns the frozen, ordered gate sequence plus its `source` provenance
 */
export function resolveVerificationPolicy(
  riskTier: RiskTier,
  boundaryTouching: boolean,
  config?: ResolvedProjectConfig,
): ResolvedVerificationPolicy {
  const policy = config?.verification.policy;
  const cell = boundaryTouching ? policy?.boundary?.[riskTier] : policy?.[riskTier];

  // Cell PRESENT (including an explicit empty array) → full replacement.
  // Copy before freezing so the returned sequence is never aliased to the
  // caller's overlay array.
  if (cell !== undefined) {
    return { sequence: Object.freeze([...cell]), source: 'config' };
  }

  // Cell unset / no config → the built-in table (already frozen by slice 1).
  return {
    sequence: resolveVerificationSequence(riskTier, boundaryTouching),
    source: 'builtin',
  };
}
