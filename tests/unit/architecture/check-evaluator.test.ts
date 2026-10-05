import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { evaluateLeaf, evaluateTree } from '../../../src/architecture/check-evaluator.js';
import type { CheckLeaf, CheckNode } from '../../../src/architecture/invariant-schema.js';

const grep = (pattern: string, extra: Partial<CheckLeaf> = {}): CheckLeaf => ({
  kind: 'grep',
  pattern,
  ...extra,
});

describe('evaluateLeaf', () => {
  /** A `grep` leaf gives exactly one finding when the pattern matches the diff, and `[]` when it does not. */
  it('EvaluateLeaf_GrepKind_DelegatesToCheckCatalogExecution', () => {
    const diff = '+ const x = 1; // TODO: refactor\n+ const y = 2;\n';

    const hit = evaluateLeaf(grep('TODO'), diff);
    expect(hit).toHaveLength(1);
    expect(hit[0].message).toContain('TODO');

    const miss = evaluateLeaf(grep('NOPE'), diff);
    expect(miss).toEqual([]);
  });

  /** A `structural` leaf gives a finding only when the match count is more than the threshold. */
  it('EvaluateLeaf_StructuralKind_FiresOnlyAboveThreshold', () => {
    const diff = '+ a\n+ a\n+ a\n+ a\n';
    const leaf: CheckLeaf = { kind: 'structural', pattern: 'a', threshold: 3 };
    expect(evaluateLeaf(leaf, diff)).toHaveLength(1);

    const below: CheckLeaf = { kind: 'structural', pattern: 'a', threshold: 10 };
    expect(evaluateLeaf(below, diff)).toEqual([]);
  });
});

/** A node passes when it produces no findings. */
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

  /** A child that passes gives a finding. A child that fails gives none. */
  it('EvaluateTree_Not_Inverts', () => {
    expect(passes({ not: ALWAYS_PASS }, DIFF)).toBe(false);
    expect(passes({ not: ALWAYS_FAIL }, DIFF)).toBe(true);
  });

  /**
   * A `scope` node gives its `fileGlob` to a leaf that has none. `DIFF` has no file headers, so the
   * glob excludes no match. The test compares the result with a leaf that holds the same glob.
   */
  it('EvaluateTree_Scope_NarrowsFileGlob', () => {
    const node: CheckNode = {
      scope: { fileGlob: '*.md' },
      node: grep('present'),
    };
    const direct = evaluateTree(grep('present', { fileGlob: '*.md' }), DIFF);
    expect(evaluateTree(node, DIFF)).toEqual(direct);
  });

  /**
   * The header lines of a file (`diff --git`, `index`, `--- a/`) belong to the section of that file,
   * not to the section before it. `beta` is only in the headers and body of `beta.ts`, so a leaf
   * with the glob `alpha.ts` must not match it.
   */
  it('EvaluateLeaf_MultiFileGitDiff_AttributesHeadersToOwningFile', () => {
    const diff = [
      'diff --git a/alpha.ts b/alpha.ts',
      'index 1111111..2222222 100644',
      '--- a/alpha.ts',
      '+++ b/alpha.ts',
      '@@ -1 +1 @@',
      '+const alpha = 1;',
      'diff --git a/beta.ts b/beta.ts',
      'index 3333333..4444444 100644',
      '--- a/beta.ts',
      '+++ b/beta.ts',
      '@@ -1 +1 @@',
      '+const beta = 2;',
      '',
    ].join('\n');

    expect(evaluateLeaf(grep('beta', { fileGlob: 'alpha.ts' }), diff)).toEqual([]);
    expect(evaluateLeaf(grep('beta', { fileGlob: 'beta.ts' }), diff)).toHaveLength(1);
    expect(evaluateLeaf(grep('alpha', { fileGlob: 'beta.ts' }), diff)).toEqual([]);
    expect(evaluateLeaf(grep('alpha', { fileGlob: 'alpha.ts' }), diff)).toHaveLength(1);
  });

  /** A subtree with `scope.phase` applies only in that phase. In a different phase it passes. */
  it('EvaluateTree_ScopePhase_SkipsSubtreeOutOfPhase', () => {
    const node: CheckNode = {
      scope: { phase: 'delegate' },
      node: ALWAYS_FAIL,
    };
    expect(evaluateTree(node, DIFF, 'review')).toEqual([]);
  });

  it('EvaluateTree_ScopePhase_EvaluatesSubtreeInPhase', () => {
    const node: CheckNode = {
      scope: { phase: 'review' },
      node: ALWAYS_FAIL,
    };
    expect(evaluateTree(node, DIFF, 'review').length).toBeGreaterThan(0);
  });

  /** A caller that gives no current phase cannot evaluate the phase gate, so the subtree applies. */
  it('EvaluateTree_ScopePhase_InertWhenCurrentPhaseOmitted', () => {
    const node: CheckNode = {
      scope: { phase: 'delegate' },
      node: ALWAYS_FAIL,
    };
    expect(evaluateTree(node, DIFF).length).toBeGreaterThan(0);
  });

  /**
   * A random boolean tree of pass leaves and fail leaves must evaluate the same as a reference
   * boolean algebra, where a pass is zero findings. `refPasses` is that reference.
   * `toNode` maps the tagged tree to a `CheckNode`. A pass leaf has a pattern that is absent from
   * `DIFF`, and a fail leaf has a pattern that is present.
   */
  it('EvaluateTree_RandomBooleanTree_MatchesReferenceAlgebra', () => {
    type BoolTree =
      | { t: 'leaf'; pass: boolean }
      | { t: 'all'; kids: BoolTree[] }
      | { t: 'any'; kids: BoolTree[] }
      | { t: 'not'; kid: BoolTree };

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

    const toNode = (tree: BoolTree): CheckNode => {
      switch (tree.t) {
        case 'leaf':
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
