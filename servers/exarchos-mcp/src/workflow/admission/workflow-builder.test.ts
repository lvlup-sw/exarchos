import { describe, expect, it } from 'vitest';

import {
  EdgeConditionCompileError,
  serializeEdgeCondition,
  tryCompileEdgeCondition,
  type EdgeConditionDeclaration,
} from './edge-condition.js';
import {
  all,
  any,
  approval,
  buildEdge,
  compare,
  equals,
  event,
  gate,
  lowerCondition,
  lowerObligation,
  never,
  noObligation,
  not,
  present,
  type ConditionSpec,
} from './workflow-builder.js';
import { adjudicateEdge, defaultTranslationContext } from './legacy-state-translation.js';

// A small, self-contained declaration proving the builder is a GENERAL authoring
// tool, not hard-wired to the built-in fact vocabulary.
const DECL: EdgeConditionDeclaration = {
  fields: {
    'artifacts.plan': 'string',
    'planReview.approved': 'boolean',
    track: 'string',
    'planReview.revisionCount': 'number',
  },
  events: ['synthesize.requested'],
};

const CTX = defaultTranslationContext('2025-01-01T00:00:00.000Z');

describe('workflow-builder leaf combinators lower to the closed AST', () => {
  it('present → factPresent', () => {
    const cond = lowerCondition(present('artifacts.plan'), DECL);
    expect(JSON.parse(serializeEdgeCondition(cond))).toEqual({
      kind: 'factPresent',
      field: 'artifacts.plan',
    });
  });

  it('equals(boolean) → factEquals', () => {
    const cond = lowerCondition(equals('planReview.approved', true), DECL);
    expect(JSON.parse(serializeEdgeCondition(cond))).toEqual({
      kind: 'factEquals',
      field: 'planReview.approved',
      value: true,
    });
  });

  it('equals(string) → factEquals', () => {
    const cond = lowerCondition(equals('track', 'thorough'), DECL);
    expect(JSON.parse(serializeEdgeCondition(cond))).toEqual({
      kind: 'factEquals',
      field: 'track',
      value: 'thorough',
    });
  });

  it('compare → counterCompare', () => {
    const cond = lowerCondition(compare('planReview.revisionCount', 'gte', 1), DECL);
    expect(JSON.parse(serializeEdgeCondition(cond))).toEqual({
      kind: 'counterCompare',
      field: 'planReview.revisionCount',
      op: 'gte',
      value: 1,
    });
  });

  it('event → eventObserved', () => {
    const cond = lowerCondition(event('synthesize.requested'), DECL);
    expect(JSON.parse(serializeEdgeCondition(cond))).toEqual({
      kind: 'eventObserved',
      event: 'synthesize.requested',
    });
  });
});

describe('workflow-builder connectives compose closed subtrees', () => {
  it('all / any / not nest as expected', () => {
    const cond = lowerCondition(
      all(present('artifacts.plan'), not(any(equals('track', 'polish')))),
      DECL,
    );
    expect(JSON.parse(serializeEdgeCondition(cond))).toEqual({
      kind: 'all',
      operands: [
        { kind: 'factPresent', field: 'artifacts.plan' },
        {
          kind: 'not',
          operand: { kind: 'any', operands: [{ kind: 'factEquals', field: 'track', value: 'polish' }] },
        },
      ],
    });
  });

  it('empty all() is the always-legal constant and empty any()/never() is never-legal', () => {
    expect(JSON.parse(serializeEdgeCondition(lowerCondition(all(), DECL)))).toEqual({
      kind: 'all',
      operands: [],
    });
    expect(JSON.parse(serializeEdgeCondition(lowerCondition(never(), DECL)))).toEqual({
      kind: 'any',
      operands: [],
    });
  });
});

describe('workflow-builder round-trips shared IR losslessly (exit-proof a)', () => {
  it('lower → serialize → recompile → serialize is a fixed point', () => {
    const spec = all(
      present('artifacts.plan'),
      any(equals('track', 'thorough'), compare('planReview.revisionCount', 'gte', 1)),
      not(equals('planReview.approved', false)),
    );
    const first = lowerCondition(spec, DECL);
    const json = serializeEdgeCondition(first);

    // Re-compile the serialized wire form and prove it is byte-identical: the
    // lowered AST is exactly what the compiler re-accepts, with no loss.
    const recompiled = tryCompileEdgeCondition(JSON.parse(json), DECL);
    expect(recompiled.ok).toBe(true);
    if (recompiled.ok) {
      expect(serializeEdgeCondition(recompiled.condition)).toBe(json);
    }
  });
});

describe('workflow-builder obligation combinators', () => {
  it('noObligation lowers to { kind: "none" }', () => {
    expect(lowerObligation(noObligation, DECL)).toEqual({ kind: 'none' });
  });

  it('gate lowers to a gate obligation carrying a compiled presence probe', () => {
    const obl = lowerObligation(gate('plan-artifact', present('artifacts.plan')), DECL);
    expect(obl.kind).toBe('gate');
    if (obl.kind === 'gate') {
      expect(obl.gateId).toBe('plan-artifact');
      expect(JSON.parse(serializeEdgeCondition(obl.presence))).toEqual({
        kind: 'factPresent',
        field: 'artifacts.plan',
      });
    }
  });

  it('approval lowers with class + minimumApprovals + compiled presence', () => {
    const obl = lowerObligation(
      approval('plan-review', equals('planReview.approved', true), 2),
      DECL,
    );
    expect(obl.kind).toBe('approval');
    if (obl.kind === 'approval') {
      expect(obl.approvalClass).toBe('plan-review');
      expect(obl.minimumApprovals).toBe(2);
      expect(JSON.parse(serializeEdgeCondition(obl.presence))).toEqual({
        kind: 'factEquals',
        field: 'planReview.approved',
        value: true,
      });
    }
  });
});

describe('workflow-builder enforces closure at lowering time (exit-proof c, runtime leg)', () => {
  it('rejects a smuggled string-expression escape hatch (double-cast bypass)', () => {
    // A caller who defeats the type system with a double cast still cannot get
    // an escape hatch past `compileEdgeCondition`: the extra `expression`
    // property is an UNKNOWN_PROPERTY the closed-node validator rejects — and
    // rejected for THAT reason (the escape hatch), not incidentally.
    const smuggled = {
      kind: 'factEquals',
      field: 'track',
      value: 'thorough',
      expression: 'track === "thorough" && sideEffect()',
    } as unknown as ConditionSpec;

    const err = tryCompileEdgeConditionThrow(() => lowerCondition(all(smuggled), DECL));
    expect(err).toBeInstanceOf(EdgeConditionCompileError);
    if (err instanceof EdgeConditionCompileError) {
      expect(err.code).toBe('UNKNOWN_PROPERTY');
    }
  });

  it('rejects a smuggled function-valued node', () => {
    const smuggled = { kind: 'custom', run: () => true } as unknown as ConditionSpec;
    const err = tryCompileEdgeConditionThrow(() => lowerCondition(smuggled, DECL));
    expect(err).toBeInstanceOf(EdgeConditionCompileError);
  });

  it('rejects a reference to an undeclared field', () => {
    // The declaration is data, so authoring against a field the projector cannot
    // populate is caught at lower time, not silently admitted.
    expect(() => lowerCondition(present('not.a.declared.field'), DECL)).toThrow(
      EdgeConditionCompileError,
    );
  });
});

function tryCompileEdgeConditionThrow(fn: () => unknown): unknown {
  try {
    fn();
    return undefined;
  } catch (err) {
    return err;
  }
}

describe('buildEdge produces a WorkflowEdgeIR the translation consumes', () => {
  it('an authored edge is accepted by adjudicateEdge and yields a definite verdict', () => {
    const edge = buildEdge({
      workflowType: 'feature',
      from: 'plan',
      to: 'plan-review',
      toPhaseKind: 'PLAN',
      category: 'admission-requirement',
      legacyGuardId: 'plan-artifact-exists',
      obligation: gate('plan-artifact', any(present('artifacts.plan'), present('plan'))),
    });

    // Consumed by an IR consumer (adjudicateEdge) without adaptation.
    const allowVerdict = adjudicateEdge(
      edge,
      { artifacts: { plan: 'docs/specs/feature.md' } },
      CTX,
    );
    const denyVerdict = adjudicateEdge(edge, {}, CTX);

    expect(allowVerdict).toBe('allow');
    expect(denyVerdict).toBe('deny');
  });

  it('defaults an omitted route to the always-legal condition', () => {
    const edge = buildEdge({
      workflowType: 'feature',
      from: 'plan',
      to: 'plan-review',
      toPhaseKind: 'PLAN',
      category: 'admission-requirement',
      legacyGuardId: null,
      obligation: noObligation,
    });
    expect(JSON.parse(serializeEdgeCondition(edge.routeCondition))).toEqual({
      kind: 'all',
      operands: [],
    });
  });
});
