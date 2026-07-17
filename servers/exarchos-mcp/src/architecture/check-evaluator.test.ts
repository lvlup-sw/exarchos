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
    expect(hit[0]!.message).toContain('TODO');

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

  it('EvaluateLeaf_MultiFileGitDiff_AttributesHeadersToOwningFile', () => {
    // A file's header lines (`diff --git a/…`, `index …`, `--- a/…`) must be
    // attributed to THAT file's section, not leaked into the previous file's.
    // Regression guard: a token that appears only in beta.ts's headers/body
    // must not match when the leaf is scoped to alpha.ts.
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

    // `beta` lives only in beta.ts; scoped to alpha.ts it must NOT match
    // (before the fix, beta.ts's `diff --git`/`--- a/beta.ts` headers leaked
    // into alpha.ts's section and produced a false positive).
    expect(evaluateLeaf(grep('beta', { fileGlob: 'alpha.ts' }), diff)).toEqual([]);
    // Scoped to its own file, it fires.
    expect(evaluateLeaf(grep('beta', { fileGlob: 'beta.ts' }), diff)).toHaveLength(1);
    // And alpha is correctly confined to alpha.ts.
    expect(evaluateLeaf(grep('alpha', { fileGlob: 'beta.ts' }), diff)).toEqual([]);
    expect(evaluateLeaf(grep('alpha', { fileGlob: 'alpha.ts' }), diff)).toHaveLength(1);
  });

  it('EvaluateTree_ScopePhase_SkipsSubtreeOutOfPhase', () => {
    // A `scope.phase` declares the subtree applies only during that phase. An
    // ALWAYS_FAIL leaf scoped to `delegate` must NOT fire when the gate runs
    // at `review` — the subtree is out of scope and therefore passes.
    const node: CheckNode = {
      scope: { phase: 'delegate' },
      node: ALWAYS_FAIL,
    };
    expect(evaluateTree(node, DIFF, 'review')).toEqual([]);
  });

  it('EvaluateTree_ScopePhase_EvaluatesSubtreeInPhase', () => {
    // When the current phase matches the scoped phase, the subtree applies and
    // the failing leaf fires as usual.
    const node: CheckNode = {
      scope: { phase: 'review' },
      node: ALWAYS_FAIL,
    };
    expect(evaluateTree(node, DIFF, 'review').length).toBeGreaterThan(0);
  });

  it('EvaluateTree_ScopePhase_InertWhenCurrentPhaseOmitted', () => {
    // Backward-compatibility: a phase-agnostic caller (no currentPhase) cannot
    // evaluate the gate, so the subtree applies unconditionally.
    const node: CheckNode = {
      scope: { phase: 'delegate' },
      node: ALWAYS_FAIL,
    };
    expect(evaluateTree(node, DIFF).length).toBeGreaterThan(0);
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
