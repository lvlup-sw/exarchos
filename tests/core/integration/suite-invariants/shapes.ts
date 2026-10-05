// The covered assertion shapes.
//
// A test file that matches one of these shapes must declare its authorities.
// The shapes make that duty decidable without a dataflow analysis.
//
// The shapes alone decide scope. The `@oracle-sources` annotation must not
// decide it. Otherwise, a person deletes the annotation, the file leaves scope
// and the guard passes. The annotation is an input to compliance only.
//
// Each matcher runs against the code view of the file (see `source-view.ts`),
// so comments and string bodies do not count.
//
// `registry.ts` holds a floor for the corpus match count of each shape. A
// matcher that matches nothing fails that floor.

import { sourceViews } from './source-view.js';

export interface ShapeDefinition {
  /** A stable id. The ratchet in `registry.ts` refers to it. */
  readonly id: string;
  /** The suite property that this shape is evidence of. */
  readonly property: 'containment' | 'drift' | 'parity' | 'census-closure' | 'coverage';
  /** The reason that the shape is covered. */
  readonly why: string;
  /** The matcher. It runs against the code view of the file. */
  readonly pattern: RegExp;
  /**
   * An optional second stage. `pattern` finds candidate files, and `refine`
   * returns false for a file whose matches are not the property. The floor in
   * `registry.ts` applies to the refined count, so it also catches a `refine`
   * that rejects all files.
   */
  readonly refine?: (source: string, code: string) => boolean;
}

/**
 * Nouns that mark a collection as a census difference.
 * `expect(items).toEqual([])` is an ordinary assertion.
 * `expect(missingIds).toEqual([])` claims closure over a population.
 */
const CENSUS_DIFF_NOUN = String.raw`(?:missing|extra|unregistered|uncovered|undeclared|unmatched|orphan\w*|drift\w*|diffs?|differences|stale|absent|unknowns?|leaked|violations?|offenders?|gaps?|unreferenced|dangling|mismatch\w*|unaccounted|untested|unused|notFound|notInRegistry|onlyIn\w*|breaking|regressions?|conflicts?)`;

export const COVERED_SHAPES: readonly ShapeDefinition[] = Object.freeze([
  {
    id: 'empty-census-diff',
    property: 'census-closure',
    why: 'asserts a census difference is empty — the population and the reference must be two authorities',
    pattern: new RegExp(
      String.raw`expect\s*\(\s*[^;]{0,240}?\b${CENSUS_DIFF_NOUN}\b[^;]{0,240}?\)\s*(?:\.\s*[a-zA-Z]+\s*)*\.\s*(?:toEqual|toStrictEqual)\s*\(\s*\[\s*\]\s*\)` +
        '|' +
        String.raw`expect\s*\(\s*[^;]{0,240}?\b${CENSUS_DIFF_NOUN}\b[^;]{0,240}?\)\s*(?:\.\s*[a-zA-Z]+\s*)*\.\s*toHaveLength\s*\(\s*0\s*\)`,
    ),
  },
  {
    id: 'set-equality',
    property: 'containment',
    why: 'asserts two populations are the same set — both sides must not come from one read',
    pattern:
      /expect\s*\(\s*(?:new\s+Set|\[\s*\.\.\.)[\s\S]{0,320}?\)\s*\.\s*(?:toEqual|toStrictEqual)\s*\(\s*(?:new\s+Set|\[\s*\.\.\.)/,
  },
  {
    id: 'sorted-parity',
    property: 'parity',
    why: 'compares two order-normalised lists — the classic parity assertion',
    pattern: /\.\s*sort\s*\([^)]*\)\s*\)\s*\.\s*(?:toEqual|toStrictEqual)\s*\(/,
  },
  {
    id: 'snapshot-drift',
    property: 'drift',
    why: 'a snapshot is a drift guard; the snapshot and the producer must be independent',
    pattern: /\.\s*(?:toMatchSnapshot|toMatchInlineSnapshot|toMatchFileSnapshot)\s*\(/,
  },
  {
    id: 'every-quantified',
    property: 'coverage',
    why: 'universally quantifies a predicate over a population — vacuously true on an empty population',
    pattern:
      /expect\s*\([\s\S]{0,420}?\.\s*every\s*\([\s\S]{0,420}?\)\s*\.\s*(?:toBe\s*\(\s*true\s*\)|toBeTruthy\s*\(\s*\))/,
  },
  {
    id: 'pinned-cardinality',
    property: 'census-closure',
    why: 'pins a denominator; the count and the thing counted must not share a source',
    pattern:
      /expect\s*\([^;]{0,240}?\.\s*(?:length|size)\s*\)\s*\.\s*(?:toBe|toEqual|toStrictEqual)\s*\(\s*\d{2,}\s*\)|\.\s*toHaveLength\s*\(\s*\d{2,}\s*\)/,
  },
  {
    id: 'fs-corpus-sweep',
    property: 'coverage',
    why: 'derives its subject population from the filesystem — a coverage claim over a corpus',
    pattern: /\b(?:readdirSync|readdir\s*\(|globSync|fastGlob|\bfg\s*\(|glob\s*\()/,
  },
  {
    id: 'golden-artifact-compare',
    property: 'drift',
    why: 'compares live output against a committed golden — a two-authority claim by construction',
    pattern:
      /expect\s*\([^;]{0,240}?\)\s*(?:\.\s*[a-zA-Z]+\s*)*\.\s*(?:toEqual|toStrictEqual|toBe)\s*\(\s*\w*(?:GOLDEN|Golden|golden|BASELINE|Baseline|baseline|CANONICAL|Canonical|canonical|EXPECTED_|Expected[A-Z]|expectedManifest|MANIFEST|Manifest)\w*\s*[,)]/,
  },
  /**
   * Covers a comparison of two computed values, such as
   * `expect(normalizedCli).toEqual(normalizedMcp)` in
   * `tests/unit/verbs/gates/contract-drift.parity.test.ts`. The shape itself
   * does not show if the two values come from one read or from two.
   *
   * `refine` drops a match when the file binds one side to a literal. The
   * person who wrote the literal is the second authority. Without `refine`,
   * the pattern also matches an ordinary `expect(result).toEqual(expected)`
   * assertion.
   */
  {
    id: 'derived-pair-parity',
    property: 'parity',
    why: 'compares two computed values against each other with no hand-written expectation on either side — nothing in the shape proves they came from two reads',
    pattern:
      /expect\s*\(\s*[A-Za-z_$][\w$.]*(?:\s*\([^()]{0,80}\))?\s*\)\s*\.\s*(?:toEqual|toStrictEqual)\s*\(\s*[A-Za-z_$][\w$.]*(?:\s*\([^()]{0,80}\))?\s*\)/,
    refine: (_source, code) => {
      DERIVED_PAIR_RE.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = DERIVED_PAIR_RE.exec(code)) !== null) {
        const left = rootIdent(m[1] ?? '');
        const right = rootIdent(m[2] ?? '');
        if (!left || !right) continue;
        if (isLiteralAnchored(code, left) || isLiteralAnchored(code, right)) continue;
        return true;
      }
      return false;
    },
  },
]);

const DERIVED_PAIR_RE =
  /expect\s*\(\s*([A-Za-z_$][\w$.]*(?:\s*\([^()]{0,80}\))?)\s*\)\s*\.\s*(?:toEqual|toStrictEqual)\s*\(\s*([A-Za-z_$][\w$.]*(?:\s*\([^()]{0,80}\))?)\s*\)/g;

function rootIdent(expr: string): string {
  return /^([A-Za-z_$][\w$]*)/.exec(expr.trim())?.[1] ?? '';
}

/** Is `name` bound in this file to a hand-written literal expectation? */
function isLiteralAnchored(code: string, name: string): boolean {
  const re = new RegExp(
    String.raw`(?:const|let|var)\s+${name}\b[^=;\n]{0,160}=\s*([\s\S]{0,4})`,
  );
  const init = re.exec(code)?.[1]?.trimStart() ?? '';
  return /^[[{'"`]/.test(init) || /^(?:\d|true\b|false\b|null\b)/.test(init);
}

/**
 * Returns the ids of the covered shapes that this source matches. The match
 * runs against the code view. Thus a comment or a string literal that
 * describes a parity assertion does not put the file in scope.
 */
export function matchedShapes(source: string): readonly string[] {
  const { code } = sourceViews(source);
  return COVERED_SHAPES.filter(
    (s) => s.pattern.test(code) && (s.refine === undefined || s.refine(source, code)),
  ).map((s) => s.id);
}

/** A file is in scope for the `@oracle-sources` obligation iff it matches ≥1 shape. */
export function isInScope(source: string): boolean {
  return matchedShapes(source).length > 0;
}
