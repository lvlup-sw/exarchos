// DR-24 (Task 058): the cast census must measure type ASSERTIONS, not text.
//
// The census feeds a closed-window ratchet (`[BASELINE, BASELINE + 5]`, see
// `src/install/tsconfig-strictness.test.ts`), so anything it miscounts is spent out of a
// five-site budget. These tests pin both directions of correctness:
//   - false POSITIVES are gone (comment prose, namespace imports, literal text);
//   - false NEGATIVES were not introduced (every real assertion form still counts).
//
// The second half is the one that matters. An under-counting census is strictly
// worse than the over-counting one it replaces: it reports green while real debt
// lands. Each "still counted" case below exists to make that failure loud.

import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { countCastsInSource, countCasts } from './count-casts.js';

/**
 * The census this task replaced, preserved verbatim. It is the "before" number
 * in every kill fixture — asserting it keeps the regression legible: if someone
 * reverts to text matching, the fixtures below say exactly what breaks and by
 * how much.
 */
const LEGACY_AS_CAST = /\bas\s+(?:const\b|unknown\b|any\b|[A-Za-z_$][\w$]*|\{|\[|\()/g;
function legacyCount(src: string): number {
  return src.match(LEGACY_AS_CAST)?.length ?? 0;
}

describe('DR-24: cast census counts assertions, not text', () => {
  // ---------------------------------------------------------------------
  // The kill fixture named in the task's acceptance criteria.
  // ---------------------------------------------------------------------
  it('CountCastsInSource_ProseAndNamespaceImportAlongsideRealCast_CountsOnlyTheAssertion', () => {
    const src = [
      '// treat this as a hint',
      "import * as path from 'node:path';",
      'const y = x as Foo;',
      '',
    ].join('\n');

    // Exactly one of these three lines asserts a type.
    expect(countCastsInSource(src).asCast).toBe(1);

    // …and the census this replaced counted all three. Pinning the old number
    // documents the size of the defect, not just its absence.
    expect(legacyCount(src)).toBe(3);
  });

  it('CountCastsInSource_CommentProse_NotCountedAsAssertion', () => {
    const src = [
      '// tracked as a known gap in T5',
      '/* the marker survives as a SUPPLEMENTARY pointer */',
      '/** Echoed as the POSIX repo-relative path. */',
      'const n = 1;',
      '',
    ].join('\n');

    expect(countCastsInSource(src).asCast).toBe(0);
    expect(legacyCount(src)).toBe(3);
  });

  it('CountCastsInSource_NamespaceImportAndExport_NotCountedAsAssertion', () => {
    const src = ["import * as fs from 'node:fs';", "export * as helpers from './helpers.js';", ''].join('\n');

    expect(countCastsInSource(src).asCast).toBe(0);
    expect(legacyCount(src)).toBe(2);
  });

  it('CountCastsInSource_ImportAndExportAliases_NotCountedAsAssertion', () => {
    const src = [
      "import { load as yamlLoad } from 'js-yaml';",
      "export { inner as outer } from './inner.js';",
      '',
    ].join('\n');

    expect(countCastsInSource(src).asCast).toBe(0);
    expect(legacyCount(src)).toBe(2);
  });

  it('CountCastsInSource_StringAndTemplateLiteralText_NotCountedAsAssertion', () => {
    const src = [
      "const a = 'Start Exarchos as an MCP server';",
      'const b = `streamed as NDJSON frames`;',
      'const c = `claimed as a ${kind} elsewhere`;',
      '',
    ].join('\n');

    expect(countCastsInSource(src).asCast).toBe(0);
    expect(legacyCount(src)).toBe(3);
  });

  // ---------------------------------------------------------------------
  // False-negative guards: every real assertion form must still be counted.
  // ---------------------------------------------------------------------
  it('CountCastsInSource_EveryAssertionForm_StillCounted', () => {
    const cases: Array<[string, string]> = [
      ['as const', 'const a = [1, 2] as const;'],
      ['as unknown', 'const a = x as unknown;'],
      ['as any', 'const a = x as any;'],
      ['as NamedType', 'const a = x as Foo;'],
      ['as qualified', 'const a = x as NodeJS.ErrnoException;'],
      ['as generic', 'const a = x as Record<string, unknown>;'],
      ['as array', 'const a = x as string[];'],
      ['as object literal type', 'const a = x as { scripts?: unknown };'],
      ['as parenthesised union', 'const a = x as (A | B);'],
      ['as readonly', 'const a = x as readonly string[];'],
      ['as string-literal union', "const a = x as 'created' | 'updated';"],
      ['as numeric literal', 'const a = x as 5;'],
      ['as across a newline', 'const a = x as\n  Foo;'],
      ['angle-bracket form', 'const a = <Foo>x;'],
    ];

    for (const [label, src] of cases) {
      expect(countCastsInSource(src).asCast, label).toBe(1);
    }
  });

  it('CountCastsInSource_LiteralTypeAssertions_RecoversLegacyFalseNegatives', () => {
    // The legacy alternation had no branch for a quote or a digit, so these
    // real assertions were never counted at all. The corrected census finds
    // them — the correction moves the number DOWN on balance, but not here.
    const src = ["const a = x as 'created' | 'updated';", 'const b = y as 5;', ''].join('\n');

    expect(countCastsInSource(src).asCast).toBe(2);
    expect(legacyCount(src)).toBe(0);
  });

  it('CountCastsInSource_NestedAssertions_CountedIndividually', () => {
    expect(countCastsInSource('const a = (x as A) as B;').asCast).toBe(2);
  });

  it('CountCastsInSource_SatisfiesOperator_NotCountedAsAssertion', () => {
    // `satisfies` is checked, not asserted — it proves the type rather than
    // silencing the checker, so it is not an escape hatch.
    expect(countCastsInSource('const a = { b: 1 } satisfies Foo;').asCast).toBe(0);
  });

  // ---------------------------------------------------------------------
  // Adversarial lexical input. A hand-rolled comment/string stripper fumbles
  // exactly these; the parser is used precisely so it cannot.
  // ---------------------------------------------------------------------
  it('CountCastsInSource_AdversarialLexicalInput_DoesNotDesyncCensus', () => {
    const cases: Array<[string, string]> = [
      ['apostrophe in comment', "// don't read this as a cast\nconst y = x as Bar;"],
      ['double-slash inside a string', "const s = 'http://host as Foo';\nconst y = x as Bar;"],
      ['block-comment marker in template', 'const s = `/* x as Foo */`;\nconst y = x as Bar;'],
      ['regex literal containing a quote', "const r = /'\\/\\/ as Foo/;\nconst y = x as Bar;"],
      ['template substitution re-entering code', 'const s = `a ${b} c as d`;\nconst y = x as Bar;'],
      ['backtick inside a line comment', '// a `as Foo` mention\nconst y = x as Bar;'],
      ['escaped quote inside a string', "const s = 'it\\'s as a rule';\nconst y = x as Bar;"],
      ['nested template substitution', 'const s = `${`inner as Foo`} as Bar`;\nconst y = x as Baz;'],
    ];

    for (const [label, src] of cases) {
      // Exactly one genuine assertion in each — the trailing `x as Bar`/`as Baz`.
      expect(countCastsInSource(src).asCast, label).toBe(1);
    }
  });

  // ---------------------------------------------------------------------
  // The `as any` axis (zero-growth ceiling).
  // ---------------------------------------------------------------------
  it('CountCastsInSource_AnyAnywhereInAssertedType_CountedOnAsAnyAxis', () => {
    expect(countCastsInSource('const a = x as any;').asAny).toBe(1);
    expect(countCastsInSource('const a = x as any[];').asAny).toBe(1);
    expect(countCastsInSource('const a = x as Record<string, any>;').asAny).toBe(1);
    expect(countCastsInSource('const a = x as Foo;').asAny).toBe(0);
  });

  it('CountCastsInSource_AsAnyInsideComment_NotCountedOnAsAnyAxis', () => {
    // All three `as any` matches in the scanned trees were comment prose like
    // this one; the corrected census reports zero real `as any`.
    const src = '// `(issue as any).received` is therefore JS `undefined`.\nconst n = 1;\n';
    expect(countCastsInSource(src).asAny).toBe(0);
  });

  // ---------------------------------------------------------------------
  // Non-null axis — same false-positive class, same fix.
  // ---------------------------------------------------------------------
  it('CountCastsInSource_NonNullAssertion_CountedOnlyInRealCode', () => {
    expect(countCastsInSource('const a = x!.y;').nonNull).toBe(1);
    expect(countCastsInSource('// wow! not an assertion\nconst n = 1;').nonNull).toBe(0);
    expect(countCastsInSource("const s = 'boom! not an assertion';").nonNull).toBe(0);
  });

  // ---------------------------------------------------------------------
  // Under-count guards: the census must fail loudly, never quietly report low.
  // ---------------------------------------------------------------------
  it('CountCastsInSource_UnparseableSource_ThrowsRatherThanUnderCounting', () => {
    // `createSourceFile` never throws — it recovers and silently drops nodes.
    // A recovered parse must not be reported as a clean low count.
    expect(() => countCastsInSource('function f() { const a = x as Foo;', 'broken.ts')).toThrow(
      /did not parse cleanly/,
    );
  });

  it('CountCasts_ScanRootResolvingNoFiles_ThrowsRatherThanPassingClean', () => {
    const dir = mkdtempSync(join(tmpdir(), 'imo-058-census-'));
    try {
      // A root that resolves nothing would contribute 0 and read as a paydown.
      expect(() => countCasts([{ dir: join(dir, 'does-not-exist') }])).toThrow(/resolved 0 TypeScript files/);

      // Present but holding only skipped files — same hazard, same rejection.
      mkdirSync(join(dir, 'only-tests'));
      writeFileSync(join(dir, 'only-tests', 'a.test.ts'), 'const a = x as Foo;\n');
      expect(() => countCasts([{ dir: join(dir, 'only-tests') }])).toThrow(/resolved 0 TypeScript files/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('CountCasts_NoScanRoots_ThrowsRatherThanPassingClean', () => {
    expect(() => countCasts([])).toThrow(/no scan roots supplied/);
  });

  it('CountCasts_PopulatedRoot_AggregatesAcrossNestedFiles', () => {
    const dir = mkdtempSync(join(tmpdir(), 'imo-058-census-'));
    try {
      mkdirSync(join(dir, 'nested'), { recursive: true });
      writeFileSync(join(dir, 'a.ts'), "// as a note\nimport * as fs from 'node:fs';\nconst a = x as Foo;\n");
      writeFileSync(join(dir, 'nested', 'b.ts'), 'const b = y as any;\nconst c = z!.w;\n');
      // Skipped surfaces must not contribute.
      writeFileSync(join(dir, 'nested', 'b.test.ts'), 'const d = q as Bar;\n');
      mkdirSync(join(dir, 'nested', '__tests__'));
      writeFileSync(join(dir, 'nested', '__tests__', 'c.ts'), 'const e = r as Baz;\n');

      expect(countCasts([{ dir }])).toEqual({ nonNull: 1, asCast: 2, asAny: 1 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
