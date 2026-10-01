/**
 * Proposes a `designDepth` from coarse brief signals, so the PLAN phase opens with a default.
 * The module is pure: it reads only its arguments. The state machine freezes the depth.
 *
 * Two invariants apply:
 *  1. Without a strong signal, the proposal is `'standard'`, the behavior-neutral rung.
 *  2. A `'deep'` proposal needs an explicit author override before it freezes.
 *     The cost of the deep rung (a discover bridge and a brainstorm loop) is opt-in.
 */

// RESERVED(issue: #1581, owner: exarchos, expires: 2027-01-31) — dead stub, deleted at expiry if no caller adopts it.

import type { DesignDepth } from './plan-depth-policy.js';

/** Coarse ordinal magnitude for a brief signal. */
export type SignalLevel = 'low' | 'medium' | 'high';

/**
 * The brief signals that the proposal reads.
 * An absent signal counts as its lowest level, so a sparse brief does not propose more depth.
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
  /** True only for a `'deep'` proposal, which needs an explicit author decision before it freezes. */
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
 * Resolve the depth to freeze at PLAN entry.
 * An explicit author choice always wins, because it is the confirmation.
 * Without an override, an unconfirmed `'deep'` proposal freezes as `'standard'`.
 * The planner writes the result to `state.designDepth`.
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
    return 'standard';
  }
  return proposal.proposed;
}
