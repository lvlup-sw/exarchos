/**
 * P06-02 — Deterministic edge (route) selection over closed edge conditions
 * (Transition task 010; DR-1, DR-9).
 *
 * Given an ordered list of candidate edges, each carrying a compiled edge
 * condition, {@link selectEdge} deterministically chooses the legal edge to
 * take. Ordering is priority: the FIRST candidate whose condition is `true`
 * wins. Both boundary cases are explicit and total, not accidental:
 *
 *   - **zero-match** — every candidate is `false` ⇒ `{ outcome: 'no-match' }`.
 *   - **multi-match** — more than one candidate is `true`; the first in order
 *     is selected and the result flags `multiMatch: true` (and names every
 *     colliding candidate in `matchedEdgeIds`) so the ambiguity is surfaced
 *     rather than hidden.
 *
 * Selection also fails closed (DR-9): if the highest-priority non-`false`
 * candidate is `indeterminate`, routing is `blocked` — the evaluator refuses to
 * skip an edge whose legality is unknown and silently fall through to a
 * lower-priority edge.
 *
 * This module performs no admission: a `selected` edge is *legal to take*, not
 * *admitted*. Evidence-backed admission is evaluated separately downstream.
 */
import type { CompiledEdgeCondition } from './edge-condition.js';
import {
  evaluateEdgeCondition,
  type EdgeConditionFacts,
  type EdgeConditionOutcome,
} from './edge-condition-evaluate.js';

/** A candidate edge carrying the compiled condition that gates it. */
export interface EdgeCandidate {
  readonly edgeId: string;
  readonly condition: CompiledEdgeCondition;
}

/** The per-candidate outcome, preserving input order via `index`. */
export interface EdgeEvaluation {
  readonly edgeId: string;
  readonly index: number;
  readonly outcome: EdgeConditionOutcome;
}

/** The deterministic result of route selection. */
export type EdgeSelection =
  | {
      readonly outcome: 'selected';
      readonly edgeId: string;
      readonly index: number;
      /** True when more than one candidate condition evaluated to `true`. */
      readonly multiMatch: boolean;
      /**
       * Every candidate whose condition evaluated to `true`, in priority order.
       * `matchedEdgeIds.length > 1` is exactly `multiMatch` — the colliding
       * candidates are named, not merely counted, so a caller can REPORT which
       * outbound edges are simultaneously legal instead of silently resolving
       * the ambiguity to whichever edge it happened to ask about.
       */
      readonly matchedEdgeIds: readonly string[];
    }
  | {
      readonly outcome: 'blocked';
      readonly edgeId: string;
      readonly index: number;
    }
  | { readonly outcome: 'no-match' };

/** Evaluate every candidate in order. Total: one entry per candidate. */
export function evaluateEdgeCandidates(
  candidates: readonly EdgeCandidate[],
  facts: EdgeConditionFacts,
): readonly EdgeEvaluation[] {
  return candidates.map((candidate, index) => ({
    edgeId: candidate.edgeId,
    index,
    outcome: evaluateEdgeCondition(candidate.condition, facts),
  }));
}

/**
 * Deterministically select the legal edge for `facts`. First `true` in order
 * wins; a leading `indeterminate` blocks (fail closed); all `false` is no-match.
 */
export function selectEdge(
  candidates: readonly EdgeCandidate[],
  facts: EdgeConditionFacts,
): EdgeSelection {
  const evaluations = evaluateEdgeCandidates(candidates, facts);
  const matchedEdgeIds = evaluations
    .filter((evaluation) => evaluation.outcome === 'true')
    .map((evaluation) => evaluation.edgeId);

  for (const evaluation of evaluations) {
    if (evaluation.outcome === 'false') continue;
    if (evaluation.outcome === 'true') {
      return {
        outcome: 'selected',
        edgeId: evaluation.edgeId,
        index: evaluation.index,
        multiMatch: matchedEdgeIds.length > 1,
        matchedEdgeIds,
      };
    }
    // First non-false candidate is indeterminate: fail closed.
    return {
      outcome: 'blocked',
      edgeId: evaluation.edgeId,
      index: evaluation.index,
    };
  }

  return { outcome: 'no-match' };
}
