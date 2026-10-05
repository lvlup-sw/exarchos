// The cast census must count type assertions, not text.
//
// `tests/unit/tsconfig-strictness.test.ts` holds each census count inside a baseline
// window with a small budget, so each miscount spends that budget. These tests hold two
// properties:
//   - The census does not count comment prose, namespace imports or literal text.
//   - The census counts each real assertion form.
//
// An under-count is worse than an over-count, because it passes while real casts land.

import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { countCastsInSource, countCasts } from '../../../tools/audit/tsconfig-strictness/count-casts.js';
import { rmrf } from '../../../tools/test-helpers/temp-dir.js';

/**
 * The census by text match, kept for comparison. The fixtures assert its count, so a
 * return to text matching shows what breaks and by how much.
 */
const LEGACY_AS_CAST = /\bas\s+(?:const\b|unknown\b|any\b|[A-Za-z_$][\w$]*|\{|\[|\()/g;
function legacyCount(src: string): number {
  return src.match(LEGACY_AS_CAST)?.length ?? 0;
}

describe('DR-24: cast census counts assertions, not text', () => {
  /** One of the three lines asserts a type. The text-match census counts all three. */
  it('CountCastsInSource_ProseAndNamespaceImportAlongsideRealCast_CountsOnlyTheAssertion', () => {
    const src = [
      '// treat this as a hint',
      "import * as path from 'node:path';",
      'const y = x as Foo;',
      '',
    ].join('\n');

    expect(countCastsInSource(src).asCast).toBe(1);

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

  /**
   * The text-match pattern has no branch for a quote or a digit, so it misses these real
   * assertions.
   */
  it('CountCastsInSource_LiteralTypeAssertions_RecoversLegacyFalseNegatives', () => {
    const src = ["const a = x as 'created' | 'updated';", 'const b = y as 5;', ''].join('\n');

    expect(countCastsInSource(src).asCast).toBe(2);
    expect(legacyCount(src)).toBe(0);
  });

  it('CountCastsInSource_NestedAssertions_CountedIndividually', () => {
    expect(countCastsInSource('const a = (x as A) as B;').asCast).toBe(2);
  });

  /** `satisfies` proves the type and does not silence the checker. */
  it('CountCastsInSource_SatisfiesOperator_NotCountedAsAssertion', () => {
    expect(countCastsInSource('const a = { b: 1 } satisfies Foo;').asCast).toBe(0);
  });

  /**
   * A hand-written comment or string stripper misreads these inputs. Each case holds one
   * real assertion, on its last line.
   */
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
      expect(countCastsInSource(src).asCast, label).toBe(1);
    }
  });

  it('CountCastsInSource_AnyAnywhereInAssertedType_CountedOnAsAnyAxis', () => {
    expect(countCastsInSource('const a = x as any;').asAny).toBe(1);
    expect(countCastsInSource('const a = x as any[];').asAny).toBe(1);
    expect(countCastsInSource('const a = x as Record<string, any>;').asAny).toBe(1);
    expect(countCastsInSource('const a = x as Foo;').asAny).toBe(0);
  });

  it('CountCastsInSource_AsAnyInsideComment_NotCountedOnAsAnyAxis', () => {
    const src = '// `(issue as any).received` is therefore JS `undefined`.\nconst n = 1;\n';
    expect(countCastsInSource(src).asAny).toBe(0);
  });

  it('CountCastsInSource_NonNullAssertion_CountedOnlyInRealCode', () => {
    expect(countCastsInSource('const a = x!.y;').nonNull).toBe(1);
    expect(countCastsInSource('// wow! not an assertion\nconst n = 1;').nonNull).toBe(0);
    expect(countCastsInSource("const s = 'boom! not an assertion';").nonNull).toBe(0);
  });

  /**
   * `createSourceFile` does not throw on broken input. It returns a partial tree, and a
   * partial tree gives a low count.
   */
  it('CountCastsInSource_UnparseableSource_ThrowsRatherThanUnderCounting', () => {
    expect(() => countCastsInSource('function f() { const a = x as Foo;', 'broken.ts')).toThrow(
      /did not parse cleanly/,
    );
  });

  /**
   * A root that resolves no files adds 0 to the count, which looks like a paydown. The
   * test covers a missing root and a root that holds only skipped files.
   */
  it('CountCasts_ScanRootResolvingNoFiles_ThrowsRatherThanPassingClean', () => {
    const dir = mkdtempSync(join(tmpdir(), 'imo-058-census-'));
    try {
      expect(() => countCasts([{ dir: join(dir, 'does-not-exist') }])).toThrow(/resolved 0 TypeScript files/);

      mkdirSync(join(dir, 'only-tests'));
      writeFileSync(join(dir, 'only-tests', 'a.test.ts'), 'const a = x as Foo;\n');
      expect(() => countCasts([{ dir: join(dir, 'only-tests') }])).toThrow(/resolved 0 TypeScript files/);
    } finally {
      rmrf(dir);
    }
  });

  it('CountCasts_NoScanRoots_ThrowsRatherThanPassingClean', () => {
    expect(() => countCasts([])).toThrow(/no scan roots supplied/);
  });

  /** The `.test.ts` file and the `__tests__` directory must add nothing to the counts. */
  it('CountCasts_PopulatedRoot_AggregatesAcrossNestedFiles', () => {
    const dir = mkdtempSync(join(tmpdir(), 'imo-058-census-'));
    try {
      mkdirSync(join(dir, 'nested'), { recursive: true });
      writeFileSync(join(dir, 'a.ts'), "// as a note\nimport * as fs from 'node:fs';\nconst a = x as Foo;\n");
      writeFileSync(join(dir, 'nested', 'b.ts'), 'const b = y as any;\nconst c = z!.w;\n');
      writeFileSync(join(dir, 'nested', 'b.test.ts'), 'const d = q as Bar;\n');
      mkdirSync(join(dir, 'nested', '__tests__'));
      writeFileSync(join(dir, 'nested', '__tests__', 'c.ts'), 'const e = r as Baz;\n');

      expect(countCasts([{ dir }])).toEqual({ nonNull: 1, asCast: 2, asAny: 1 });
    } finally {
      rmrf(dir);
    }
  });
});
