import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { evaluateLeaf, evaluateTree } from './check-evaluator.js';
import type { CheckLeaf, CheckNode } from './invariant-schema.js';

const grep = (pattern: string, extra: Partial<CheckLeaf> = {}): CheckLeaf => ({
  kind: 'grep',
  pattern,
  ...extra,
});

describe('evaluateLeaf', () => {
  // A grep leaf delegates to check-catalog leaf-execution: a pattern match
  // over the diff produces exactly one finding; no match produces [].
  it('EvaluateLeaf_GrepKind_DelegatesToCheckCatalogExecution', () => {
    const diff = '+ const x = 1; // TODO: refactor\n+ const y = 2;\n';

    const hit = evaluateLeaf(grep('TODO'), diff);
    expect(hit).toHaveLength(1);
    expect(hit[0].message).toContain('TODO');

    const miss = evaluateLeaf(grep('NOPE'), diff);
    expect(miss).toEqual([]);
  });

  // structural/heuristic = threshold over match count: a finding only when
  // the number of matches exceeds the threshold.
  it('EvaluateLeaf_StructuralKind_FiresOnlyAboveThreshold', () => {
    const diff = '+ a\n+ a\n+ a\n+ a\n';
    const leaf: CheckLeaf = { kind: 'structural', pattern: 'a', threshold: 3 };
    expect(evaluateLeaf(leaf, diff)).toHaveLength(1);

    const below: CheckLeaf = { kind: 'structural', pattern: 'a', threshold: 10 };
    expect(evaluateLeaf(below, diff)).toEqual([]);
  });
});

// Reference boolean-algebra: a leaf "passes" when it produces no findings.
const passes = (node: CheckNode, diff: string): boolean =>
  evaluateTree(node, diff).length === 0;

const ALWAYS_PASS: CheckLeaf = grep('zzz-never-present');
const ALWAYS_FAIL: CheckLeaf = grep('present');
const DIFF = '+ present\n';

describe('evaluateTree', () => {
  it('EvaluateTree_AllOf_PassesOnlyWhenAllChildrenPass', () => {
    expect(passes({ 'all-of': [ALWAYS_PASS, ALWAYS_PASS] }, DIFF)).toBe(true);
    expect(passes({ 'all-of': [ALWAYS_PASS, ALWAYS_FAIL] }, DIFF)).toBe(false);
  });

  it('EvaluateTree_AnyOf_PassesWhenAnyChildPasses', () => {
    expect(passes({ 'any-of': [ALWAYS_FAIL, ALWAYS_PASS] }, DIFF)).toBe(true);
    expect(passes({ 'any-of': [ALWAYS_FAIL, ALWAYS_FAIL] }, DIFF)).toBe(false);
  });

  it('EvaluateTree_Not_Inverts', () => {
    // A passing child becomes a finding; a failing child passes.
    expect(passes({ not: ALWAYS_PASS }, DIFF)).toBe(false);
    expect(passes({ not: ALWAYS_FAIL }, DIFF)).toBe(true);
  });

  it('EvaluateTree_Scope_NarrowsFileGlob', () => {
    // scope injects a fileGlob into a leaf that does not specify one; the
    // subtree evaluates under the narrowed scope.
    const node: CheckNode = {
      scope: { fileGlob: '*.md' },
      node: grep('present'),
    };
    // Leaf inherits *.md scope but the diff has no file context, so the
    // narrowed glob restricts where the match counts. Behaviour asserted in
    // the implementation; here we assert scope is honoured by comparing to a
    // leaf that already carries the same glob.
    const direct = evaluateTree(grep('present', { fileGlob: '*.md' }), DIFF);
    expect(evaluateTree(node, DIFF)).toEqual(direct);
  });

  // REFACTOR (T-06): a randomly generated boolean tree of always-pass /
  // always-fail leaves evaluates equal to a reference boolean-algebra
  // evaluation over the same tree. `passes` ≡ "no findings".
  it('EvaluateTree_RandomBooleanTree_MatchesReferenceAlgebra', () => {
    // Tagged tree the generator builds; PASS/FAIL leaves map to combinator
    // leaves that respectively never/always match the diff.
    type BoolTree =
      | { t: 'leaf'; pass: boolean }
      | { t: 'all'; kids: BoolTree[] }
      | { t: 'any'; kids: BoolTree[] }
      | { t: 'not'; kid: BoolTree };

    // Reference boolean algebra over the tagged tree.
    const refPasses = (tree: BoolTree): boolean => {
      switch (tree.t) {
        case 'leaf':
          return tree.pass;
        case 'all':
          return tree.kids.every(refPasses);
        case 'any':
          return tree.kids.some(refPasses);
        case 'not':
          return !refPasses(tree.kid);
      }
    };

    // Map the tagged tree to a real CheckNode over a fixed diff.
    const toNode = (tree: BoolTree): CheckNode => {
      switch (tree.t) {
        case 'leaf':
          // pass ⇒ pattern absent from diff; fail ⇒ pattern present.
          return grep(tree.pass ? 'absent-token' : 'present');
        case 'all':
          return { 'all-of': tree.kids.map(toNode) };
        case 'any':
          return { 'any-of': tree.kids.map(toNode) };
        case 'not':
          return { not: toNode(tree.kid) };
      }
    };

    const { tree: treeArb } = fc.letrec<{ tree: BoolTree }>((rec) => ({
      tree: fc.oneof(
        { depthSize: 'small', withCrossShrink: true },
        fc.record({ t: fc.constant('leaf' as const), pass: fc.boolean() }),
        fc.record({
          t: fc.constant('all' as const),
          kids: fc.array(rec('tree'), { minLength: 1, maxLength: 3 }),
        }),
        fc.record({
          t: fc.constant('any' as const),
          kids: fc.array(rec('tree'), { minLength: 1, maxLength: 3 }),
        }),
        fc.record({ t: fc.constant('not' as const), kid: rec('tree') }),
      ),
    }));

    fc.assert(
      fc.property(treeArb, (tree) => {
        const findings = evaluateTree(toNode(tree), DIFF);
        return findings.length === 0 ? refPasses(tree) : !refPasses(tree);
      }),
      { numRuns: 300 },
    );
  });
});
