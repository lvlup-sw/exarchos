/**
 * Exit-proof tests for P06-02 — pure, total, three-valued edge-condition
 * evaluation (Transition task 010).
 *
 * Proves:
 *   (c) the evaluator performs no I/O and is total (deterministic, never
 *       throws, mutates nothing); an unknown or malformed fact is
 *       `indeterminate`; and De Morgan's laws hold under Kleene K3.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { fc } from '@fast-check/vitest';
import {
  compileEdgeCondition,
  type EdgeConditionDeclaration,
} from './edge-condition.js';
import {
  evaluateEdgeCondition,
  type EdgeConditionFacts,
  type EdgeConditionOutcome,
} from './edge-condition-evaluate.js';

const declaration = {
  fields: {
    phaseKind: 'string',
    reviewPasses: 'number',
    boundaryClear: 'boolean',
    fieldA: 'string',
    fieldB: 'string',
  },
  events: ['gate.passed', 'gate.failed'],
} as const satisfies EdgeConditionDeclaration;

const compile = (raw: unknown) => compileEdgeCondition(raw, declaration);

describe('leaf truth tables', () => {
  it('eventObserved is a total two-valued test', () => {
    const cond = compile({ kind: 'eventObserved', event: 'gate.passed' });
    expect(evaluateEdgeCondition(cond, { fields: {}, events: ['gate.passed'] })).toBe('true');
    expect(evaluateEdgeCondition(cond, { fields: {}, events: ['gate.failed'] })).toBe('false');
    expect(evaluateEdgeCondition(cond, { fields: {}, events: [] })).toBe('false');
  });

  it('factPresent is a total two-valued test', () => {
    const cond = compile({ kind: 'factPresent', field: 'phaseKind' });
    expect(evaluateEdgeCondition(cond, { fields: { phaseKind: 'review' }, events: [] })).toBe('true');
    expect(evaluateEdgeCondition(cond, { fields: {}, events: [] })).toBe('false');
  });

  it('factEquals compares present values and is indeterminate when absent', () => {
    const cond = compile({ kind: 'factEquals', field: 'phaseKind', value: 'review' });
    expect(evaluateEdgeCondition(cond, { fields: { phaseKind: 'review' }, events: [] })).toBe('true');
    expect(evaluateEdgeCondition(cond, { fields: { phaseKind: 'plan' }, events: [] })).toBe('false');
    expect(evaluateEdgeCondition(cond, { fields: {}, events: [] })).toBe('indeterminate');
  });

  it('counterCompare honours each operator and is indeterminate when absent', () => {
    const gte = compile({ kind: 'counterCompare', field: 'reviewPasses', op: 'gte', value: 2 });
    expect(evaluateEdgeCondition(gte, { fields: { reviewPasses: 2 }, events: [] })).toBe('true');
    expect(evaluateEdgeCondition(gte, { fields: { reviewPasses: 1 }, events: [] })).toBe('false');
    expect(evaluateEdgeCondition(gte, { fields: {}, events: [] })).toBe('indeterminate');

    const lt = compile({ kind: 'counterCompare', field: 'reviewPasses', op: 'lt', value: 2 });
    expect(evaluateEdgeCondition(lt, { fields: { reviewPasses: 1 }, events: [] })).toBe('true');
    const eq = compile({ kind: 'counterCompare', field: 'reviewPasses', op: 'eq', value: 2 });
    expect(evaluateEdgeCondition(eq, { fields: { reviewPasses: 2 }, events: [] })).toBe('true');
    const gt = compile({ kind: 'counterCompare', field: 'reviewPasses', op: 'gt', value: 2 });
    expect(evaluateEdgeCondition(gt, { fields: { reviewPasses: 2 }, events: [] })).toBe('false');
    const lte = compile({ kind: 'counterCompare', field: 'reviewPasses', op: 'lte', value: 2 });
    expect(evaluateEdgeCondition(lte, { fields: { reviewPasses: 2 }, events: [] })).toBe('true');
  });

  it('counterCompare is indeterminate when the present value is malformed (not a number)', () => {
    const cond = compile({ kind: 'counterCompare', field: 'reviewPasses', op: 'gt', value: 1 });
    const malformed = { fields: { reviewPasses: 'oops' }, events: [] } as unknown as EdgeConditionFacts;
    expect(evaluateEdgeCondition(cond, malformed)).toBe('indeterminate');
  });
});

describe('Kleene connectives', () => {
  it('empty all is true and empty any is false', () => {
    expect(evaluateEdgeCondition(compile({ kind: 'all', operands: [] }), { fields: {}, events: [] })).toBe('true');
    expect(evaluateEdgeCondition(compile({ kind: 'any', operands: [] }), { fields: {}, events: [] })).toBe('false');
  });

  it('all short-circuits to false, any short-circuits to true, indeterminate otherwise', () => {
    const facts: EdgeConditionFacts = { fields: {}, events: [] }; // both leaves indeterminate
    const present = compile({ kind: 'factEquals', field: 'phaseKind', value: 'review' });
    const alwaysFalse = compile({ kind: 'any', operands: [] });
    const alwaysTrue = compile({ kind: 'all', operands: [] });

    expect(
      evaluateEdgeCondition(
        compile({ kind: 'all', operands: [{ kind: 'any', operands: [] }, { kind: 'factEquals', field: 'phaseKind', value: 'review' }] }),
        facts,
      ),
    ).toBe('false'); // a false makes all false even though sibling is indeterminate
    expect(
      evaluateEdgeCondition(
        compile({ kind: 'any', operands: [{ kind: 'all', operands: [] }, { kind: 'factEquals', field: 'phaseKind', value: 'review' }] }),
        facts,
      ),
    ).toBe('true'); // a true makes any true even though sibling is indeterminate
    expect(evaluateEdgeCondition(present, facts)).toBe('indeterminate');
    void alwaysFalse;
    void alwaysTrue;
  });
});

// Deterministic leaves that realise each three-valued outcome from facts alone.
type Sel = 'true' | 'false' | 'absent';
const SELECTORS: readonly Sel[] = ['true', 'false', 'absent'];

function factsFor(a: Sel, b: Sel): EdgeConditionFacts {
  const fields: Record<string, string> = {};
  if (a !== 'absent') fields['fieldA'] = a === 'true' ? 'X' : 'Y';
  if (b !== 'absent') fields['fieldB'] = b === 'true' ? 'X' : 'Y';
  return { fields, events: [] };
}

describe('De Morgan consistency under Kleene K3', () => {
  const A = { kind: 'factEquals', field: 'fieldA', value: 'X' };
  const B = { kind: 'factEquals', field: 'fieldB', value: 'X' };
  const notAllAB = compile({ kind: 'not', operand: { kind: 'all', operands: [A, B] } });
  const anyNotANotB = compile({ kind: 'any', operands: [{ kind: 'not', operand: A }, { kind: 'not', operand: B }] });
  const notAnyAB = compile({ kind: 'not', operand: { kind: 'any', operands: [A, B] } });
  const allNotANotB = compile({ kind: 'all', operands: [{ kind: 'not', operand: A }, { kind: 'not', operand: B }] });

  it('holds for every combination of the three-valued domain', () => {
    for (const a of SELECTORS) {
      for (const b of SELECTORS) {
        const facts = factsFor(a, b);
        expect(evaluateEdgeCondition(notAllAB, facts)).toBe(evaluateEdgeCondition(anyNotANotB, facts));
        expect(evaluateEdgeCondition(notAnyAB, facts)).toBe(evaluateEdgeCondition(allNotANotB, facts));
      }
    }
  });
});

describe('determinism, totality, and no mutation', () => {
  const condition = compile({
    kind: 'all',
    operands: [
      { kind: 'eventObserved', event: 'gate.passed' },
      { kind: 'counterCompare', field: 'reviewPasses', op: 'gte', value: 2 },
      { kind: 'not', operand: { kind: 'factEquals', field: 'phaseKind', value: 'plan' } },
    ],
  });

  it('EvaluateCondition_EquivalentInputs_ReturnSameResult: equal facts yield equal outcomes', () => {
    const factsOne: EdgeConditionFacts = { fields: { reviewPasses: 3, phaseKind: 'review' }, events: ['gate.passed'] };
    const factsTwo: EdgeConditionFacts = { fields: { reviewPasses: 3, phaseKind: 'review' }, events: ['gate.passed'] };
    const first = evaluateEdgeCondition(condition, factsOne);
    for (let i = 0; i < 100; i += 1) {
      expect(evaluateEdgeCondition(condition, factsOne)).toBe(first);
      expect(evaluateEdgeCondition(condition, factsTwo)).toBe(first);
    }
    expect(first).toBe('true');
  });

  it('does not mutate the facts or condition', () => {
    const fields = Object.freeze({ reviewPasses: 3, phaseKind: 'review' });
    const events = Object.freeze(['gate.passed']);
    const facts: EdgeConditionFacts = Object.freeze({ fields, events });
    const snapshot = JSON.stringify(facts);
    expect(() => evaluateEdgeCondition(condition, facts)).not.toThrow();
    expect(JSON.stringify(facts)).toBe(snapshot);
  });

  it('is total over arbitrary fact snapshots (never throws, always a valid outcome)', () => {
    const arbFacts: fc.Arbitrary<EdgeConditionFacts> = fc.record({
      fields: fc.dictionary(
        fc.constantFrom('phaseKind', 'reviewPasses', 'boundaryClear', 'unrelated', 'fieldA'),
        fc.oneof(fc.string(), fc.integer(), fc.boolean()),
      ),
      events: fc.array(fc.constantFrom('gate.passed', 'gate.failed', 'noise')),
    });
    fc.assert(
      fc.property(arbFacts, (facts) => {
        const outcome = evaluateEdgeCondition(condition, facts);
        return outcome === 'true' || outcome === 'false' || outcome === 'indeterminate';
      }),
      { numRuns: 300 },
    );
  });
});

describe('(c) the evaluator source performs no I/O', () => {
  it('imports no filesystem, process, clock, or randomness source', () => {
    const source = readFileSync(new URL('./edge-condition-evaluate.ts', import.meta.url), 'utf8');
    // Strip the block-comment header so documentation prose is not scanned.
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '');
    expect(code).not.toMatch(/from\s+['"](node:)?(fs|child_process|process|os|net|http|https)['"]/);
    expect(code).not.toMatch(/require\s*\(/);
    expect(code).not.toMatch(/Math\.random/);
    expect(code).not.toMatch(/Date\.(now|parse)|new Date\b/);
    expect(code).not.toMatch(/\basync\b|\bawait\b/);
  });
});

function assertOutcomeType(value: EdgeConditionOutcome): void {
  void value;
}
assertOutcomeType('true');
