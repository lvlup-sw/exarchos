/**
 * Deterministic edge selection over compiled edge conditions.
 *
 * Candidate order is priority. The first candidate whose condition is `true` wins.
 * When more than one candidate is `true`, the result sets `multiMatch` and names each match.
 * When the first candidate that is not `false` is `indeterminate`, selection is `blocked`.
 * A `selected` edge is legal to take, but this module does not admit it.
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
       * A caller can report each edge that is legal at the same time.
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
 * Select the legal edge for `facts`. The first `true` candidate wins.
 * A leading `indeterminate` candidate blocks selection. All `false` gives `no-match`.
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
    return {
      outcome: 'blocked',
      edgeId: evaluation.edgeId,
      index: evaluation.index,
    };
  }

  return { outcome: 'no-match' };
}
