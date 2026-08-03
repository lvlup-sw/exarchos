/**
 * Exit-proof tests for P06-02 — deterministic edge (route) selection
 * (Transition task 010).
 *
 * Proves:
 *   (d) route selection is deterministic and explicit for zero-match and
 *       multi-match, and fails closed on a leading indeterminate.
 */
import { describe, expect, it } from 'vitest';
import {
  compileEdgeCondition,
  type EdgeConditionDeclaration,
} from './edge-condition.js';
import { type EdgeConditionFacts } from './edge-condition-evaluate.js';
import {
  evaluateEdgeCandidates,
  selectEdge,
  type EdgeCandidate,
} from './edge-condition-select.js';

const declaration = {
  fields: {
    phaseKind: 'string',
    boundaryClear: 'boolean',
  },
} as const satisfies EdgeConditionDeclaration;

const compile = (raw: unknown) => compileEdgeCondition(raw, declaration);

// Against facts { phaseKind: 'review' } (boundaryClear absent):
const facts: EdgeConditionFacts = { fields: { phaseKind: 'review' }, events: [] };
const trueCond = compile({ kind: 'factEquals', field: 'phaseKind', value: 'review' });
const falseCond = compile({ kind: 'factEquals', field: 'phaseKind', value: 'plan' });
const indetCond = compile({ kind: 'factEquals', field: 'boundaryClear', value: true });

const edge = (edgeId: string, condition: EdgeCandidate['condition']): EdgeCandidate => ({
  edgeId,
  condition,
});

describe('single-match selection', () => {
  it('selects the only true edge and reports no ambiguity', () => {
    const result = selectEdge(
      [edge('to-plan', falseCond), edge('to-review', trueCond)],
      facts,
    );
    expect(result).toEqual({ outcome: 'selected', edgeId: 'to-review', index: 1, multiMatch: false });
  });
});

describe('(d) zero-match is explicit and deterministic', () => {
  it('returns no-match when every candidate is false', () => {
    const result = selectEdge([edge('a', falseCond), edge('b', falseCond)], facts);
    expect(result).toEqual({ outcome: 'no-match' });
  });

  it('returns no-match for an empty candidate list', () => {
    expect(selectEdge([], facts)).toEqual({ outcome: 'no-match' });
  });
});

describe('(d) multi-match is deterministic (first in order wins) and explicit', () => {
  it('selects the first true candidate and flags multiMatch', () => {
    const result = selectEdge(
      [edge('first', trueCond), edge('second', trueCond)],
      facts,
    );
    expect(result).toEqual({ outcome: 'selected', edgeId: 'first', index: 0, multiMatch: true });
  });

  it('selection depends only on order, not on identity', () => {
    const forward = selectEdge([edge('first', trueCond), edge('second', trueCond)], facts);
    const reversed = selectEdge([edge('second', trueCond), edge('first', trueCond)], facts);
    expect(forward).toMatchObject({ edgeId: 'first', index: 0 });
    expect(reversed).toMatchObject({ edgeId: 'second', index: 0 });
  });

  it('is stable across repeated evaluations', () => {
    const candidates = [edge('first', trueCond), edge('second', trueCond)];
    const first = selectEdge(candidates, facts);
    for (let i = 0; i < 50; i += 1) {
      expect(selectEdge(candidates, facts)).toEqual(first);
    }
  });
});

describe('(d) fail-closed on indeterminate (DR-9)', () => {
  it('blocks when the highest-priority non-false candidate is indeterminate', () => {
    const result = selectEdge(
      [edge('skip', falseCond), edge('unknown', indetCond), edge('legal', trueCond)],
      facts,
    );
    expect(result).toEqual({ outcome: 'blocked', edgeId: 'unknown', index: 1 });
  });

  it('does not fall through a leading indeterminate to a later true edge', () => {
    const result = selectEdge([edge('unknown', indetCond), edge('legal', trueCond)], facts);
    expect(result).toEqual({ outcome: 'blocked', edgeId: 'unknown', index: 0 });
  });

  it('skips earlier false edges before selecting a true edge', () => {
    const result = selectEdge([edge('no', falseCond), edge('yes', trueCond)], facts);
    expect(result).toEqual({ outcome: 'selected', edgeId: 'yes', index: 1, multiMatch: false });
  });

  it('does not treat a trailing indeterminate as blocking a higher-priority true edge', () => {
    const result = selectEdge([edge('yes', trueCond), edge('unknown', indetCond)], facts);
    expect(result).toEqual({ outcome: 'selected', edgeId: 'yes', index: 0, multiMatch: false });
  });
});

describe('evaluateEdgeCandidates', () => {
  it('returns one ordered outcome per candidate', () => {
    const evaluations = evaluateEdgeCandidates(
      [edge('a', trueCond), edge('b', falseCond), edge('c', indetCond)],
      facts,
    );
    expect(evaluations).toEqual([
      { edgeId: 'a', index: 0, outcome: 'true' },
      { edgeId: 'b', index: 1, outcome: 'false' },
      { edgeId: 'c', index: 2, outcome: 'indeterminate' },
    ]);
  });
});
