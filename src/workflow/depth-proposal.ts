// ─── Design-Depth Proposal (DR-3, epic #1581) ───────────────────────────────
//
// Proposes a `designDepth` from coarse brief signals so the author opens the
// PLAN phase with a sensible default already filled in — the depth-axis analog
// of how a planner stamps `riskTier` per task. This module is PURE: it reads
// only the signals it is handed (no I/O, no config, no event store) and returns
// a recommendation. The resolve-then-freeze single source (state-machine.ts,
// task 005) does the actual freezing; this module only feeds the *resolve* half
// by recommending a value the author can accept or override.
//
// ── Two load-bearing invariants (DR-3) ──────────────────────────────────────
//  1. CONSERVATIVE DEFAULT — absent any strong signal the proposal is
//     `'standard'`, the behavior-neutral rung. A sparse / unknown brief never
//     pushes a feature off the default path.
//  2. NO SILENT ESCALATION TO `'deep'` — strong signals may *propose* `'deep'`
//     (the DR-7 divergent-loop rung), but a deep proposal is flagged
//     `requiresAuthorConfirmation` and is NEVER frozen without an explicit
//     author override. `resolveFrozenDepth` falls back to `'standard'` for an
//     unconfirmed deep proposal — the escalation cost (a discover bridge +
//     brainstorming loop) is opt-in, never automatic.
// ────────────────────────────────────────────────────────────────────────────

// RESERVED(issue: #1581, owner: exarchos, expires: 2027-01-31) — reserved dead stub; deletion at expiry if unadopted (DR-7 module-intent gate)

import type { DesignDepth } from './plan-depth-policy.js';

/** Coarse ordinal magnitude for a brief signal. */
export type SignalLevel = 'low' | 'medium' | 'high';

/**
 * The brief signals the proposal reads. All optional — an absent signal is
 * treated as its lowest magnitude, so a sparse brief degrades to the
 * conservative `'standard'`/`'thin'` end rather than over-proposing depth.
 */
export interface DepthSignals {
  /** How under-specified / open-ended the brief is. */
  readonly uncertainty?: SignalLevel;
  /** Breadth of cross-cutting impact the work is expected to have. */
  readonly blastRadius?: SignalLevel;
  /** Estimated number of tasks the work decomposes into (0 ⇒ unknown). */
  readonly taskCount?: number;
}

/** A depth recommendation surfaced to the author before the PLAN-entry freeze. */
export interface DepthProposal {
  /** The recommended planning depth. */
  readonly proposed: DesignDepth;
  /** Human-readable reason, surfaced alongside the proposal. */
  readonly rationale: string;
  /**
   * True iff freezing `proposed` requires an explicit author decision — set
   * ONLY for a `'deep'` proposal (invariant 2). `'thin'`/`'standard'` are
   * non-escalating and may be frozen directly.
   */
  readonly requiresAuthorConfirmation: boolean;
}

/** A `'deep'`-triggering threshold on the estimated task count. */
const DEEP_TASK_COUNT = 15;
/** Upper bound (inclusive) on task count for a `'thin'` proposal. */
const THIN_TASK_COUNT = 3;

/**
 * Propose a planning depth from brief signals. Pure and total.
 *
 * - Any HIGH signal (uncertainty, blast radius) or a large task count proposes
 *   `'deep'` — but flagged `requiresAuthorConfirmation` (no silent escalation).
 * - An all-low, small-scope brief proposes `'thin'` (minimal preamble).
 * - Everything else falls to the conservative `'standard'` default.
 */
export function proposeDesignDepth(signals: DepthSignals): DepthProposal {
  const uncertainty = signals.uncertainty ?? 'low';
  const blastRadius = signals.blastRadius ?? 'low';
  const taskCount = signals.taskCount ?? 0;

  if (uncertainty === 'high' || blastRadius === 'high' || taskCount >= DEEP_TASK_COUNT) {
    return {
      proposed: 'deep',
      rationale:
        'High uncertainty, broad blast radius, or large task count — a divergent ' +
        'exploration rung is recommended. Requires explicit author confirmation.',
      requiresAuthorConfirmation: true,
    };
  }

  if (
    uncertainty === 'low' &&
    blastRadius === 'low' &&
    taskCount > 0 &&
    taskCount <= THIN_TASK_COUNT
  ) {
    return {
      proposed: 'thin',
      rationale: 'Low uncertainty, narrow blast radius, few tasks — a thin spec suffices.',
      requiresAuthorConfirmation: false,
    };
  }

  return {
    proposed: 'standard',
    rationale: 'No strong signal either way — the standard rung (behavior-neutral default).',
    requiresAuthorConfirmation: false,
  };
}

/**
 * Resolve the depth to FREEZE at PLAN entry from the author override and the
 * proposal. The author's explicit choice always wins (it IS the confirmation);
 * absent an override, a `'deep'` proposal is NOT frozen — it degrades to the
 * conservative `'standard'` (invariant 2). `'thin'`/`'standard'` proposals
 * freeze directly. This is the value the planner patches onto `state.designDepth`
 * for the task-005 freeze to read.
 *
 * @param authorOverride the author's explicit depth choice, if any
 * @param proposal       the auto-proposal surfaced to the author
 * @returns the depth to freeze
 */
export function resolveFrozenDepth(
  authorOverride: DesignDepth | undefined,
  proposal: DepthProposal,
): DesignDepth {
  if (authorOverride) {
    return authorOverride;
  }
  if (proposal.proposed === 'deep') {
    // No silent escalation: an unconfirmed deep proposal freezes 'standard'.
    return 'standard';
  }
  return proposal.proposed;
}
