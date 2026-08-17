// ─── The covered assertion shapes (DR-30) ───────────────────────────────────
//
// DR-30 makes the "declare your authorities" obligation decidable by tying it
// to *assertion shape* rather than to dataflow: "the annotation requirement is
// enforced by matching assertion shapes, and the list of covered shapes is
// itself ratcheted so it cannot quietly shrink."
//
// CRITICAL DESIGN POINT — why in-scope-ness is shape-driven, not
// annotation-driven:
//
//   If a file were considered in scope *because it carries an
//   `@oracle-sources` annotation*, then deleting the annotation would remove
//   the file from scope and the guard would pass. That is a trivially
//   evadable guard, and DR-30 names it explicitly ("Removing an
//   `@oracle-sources` annotation from an in-scope test FAILS").
//
//   So: `isInScope(file)` is computed ENTIRELY from the shapes below, which
//   are matched against the file's CODE view (comments and string-literal
//   bodies blanked — see `source-view.ts`). The annotation is never an input
//   to scope. It is only an input to *compliance*.
//
// Each shape carries the observed corpus match count at the time it was
// introduced. `registry.ts` ratchets a floor under that count, so a matcher
// that is broken into matching nothing (the classic vacuous-scanner failure)
// turns the suite RED instead of reporting perfect compliance.

import { sourceViews } from './source-view.js';

export interface ShapeDefinition {
  /** Stable id. Referenced by the ratchet in `registry.ts`. */
  readonly id: string;
  /** Which DR-30 property this shape is evidence of. */
  readonly property: 'containment' | 'drift' | 'parity' | 'census-closure' | 'coverage';
  /** Human rationale, for the failure message. */
  readonly why: string;
  /** Matched against the CODE view of the file (comments/strings blanked). */
  readonly pattern: RegExp;
  /**
   * Optional second stage. `pattern` is the cheap silhouette; `refine`
   * removes the silhouettes that are provably NOT the property. Kept
   * separate so the anti-vacuity floor in `registry.ts` still ratchets the
   * refined count — a `refine` that starts rejecting everything is caught by
   * the same floor that catches a broken `pattern`.
   */
  readonly refine?: (source: string, code: string) => boolean;
}

/**
 * Nouns that mark a collection as a *census difference* rather than an
 * ordinary array. `expect(items).toEqual([])` is unremarkable;
 * `expect(missingIds).toEqual([])` is a closure claim over a population, and
 * it is exactly the shape T-42 found passing for the wrong reason.
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
  {
    // Added because the catalogue's first draft MISSED the contract drift
    // guard (`verbs/gates/contract-drift.parity.test.ts`), one of the three
    // Class B instances DR-30 names by name. Its assertion is
    // `expect(normalizedCli).toEqual(normalizedMcp)` — two locally-computed
    // values compared against each other, with nothing in the shape itself
    // saying whether they came from one read or two. That is precisely the
    // Class B silhouette, and a catalogue that cannot see it is a catalogue
    // scoped below the surface it governs.
    id: 'derived-pair-parity',
    property: 'parity',
    why: 'compares two computed values against each other with no hand-written expectation on either side — nothing in the shape proves they came from two reads',
    pattern:
      /expect\s*\(\s*[A-Za-z_$][\w$.]*(?:\s*\([^()]{0,80}\))?\s*\)\s*\.\s*(?:toEqual|toStrictEqual)\s*\(\s*[A-Za-z_$][\w$.]*(?:\s*\([^()]{0,80}\))?\s*\)/,
    refine: (_source, code) => {
      // `expect(a).toEqual(b)` is only Class-B-prone when NEITHER side is a
      // hand-written expectation. If either operand is bound in this file to
      // a literal (`const expected = { … }`), the human who wrote that
      // literal IS the second authority, and the comparison is not
      // single-source. Without this refinement the silhouette matches 192 of
      // 920 corpus files — most of them ordinary `expect(result)
      // .toEqual(expected)` unit assertions.
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
 * Which covered shapes does this source match? Matching is done against the
 * CODE view, so a docblock that *describes* a parity assertion does not put
 * the file in scope, and neither does a string literal containing the words.
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
