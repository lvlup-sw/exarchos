/**
 * The file list of the FAIL-detail cap. A token is a failing file only in one of two shapes.
 * A path holds a directory part and counts at any place on a line. A bare name counts only when it opens the line and a line location follows it.
 * A dotted word has neither shape, so a member access in a message is not a failing file.
 *
 * @oracle-sources: ../../../../src/verbs/pure/fail-detail.ts, and the line forms of tsc, eslint, msbuild, go vet, ruff and rustc
 */

import { describe, expect, it } from 'vitest';

import { capFailDetail, FAIL_DETAIL_MAX_LINES } from '../../../../src/verbs/pure/fail-detail.js';

/** A capped detail of `lines`. Lines with no file token fill it past the cap, so the file list of the cap reads each given line. */
function cappedDetail(lines: readonly string[]): string {
  const filler = Array.from({ length: FAIL_DETAIL_MAX_LINES + 1 }, (_, index) => `problem number ${index}`);
  return capFailDetail([...lines, ...filler].join('\n'), 'npm run lint');
}

describe('capFailDetail — what counts as a failing file', () => {
  /**
   * The message of a linter or a compiler can name a member access. Each of these lines has a dotted word and no file token.
   * The killing assertion: the regex with no shape rule lists `console.log`, `this.foo`, `Math.max` and `process.env` as failing files.
   */
  it('CapFailDetail_ADottedWordInAMessage_IsNotAFile', () => {
    const detail = cappedDetail([
      '  12:5  error  Unexpected console.log statement  no-console',
      "  14:3  error  Property 'this.foo' does not exist",
      'error TS2345: Math.max expects a number',
      'warning: process.env is read at module scope',
    ]);

    expect(detail).not.toContain('Failing files');
    expect(detail).not.toContain('console.log: 1');
    expect(detail).not.toContain('this.foo: 1');
  });

  /** A code line of a transcript opens with a dotted word and has no line location, so it is not a file. */
  it('CapFailDetail_ACodeLineThatOpensWithADottedWord_IsNotAFile', () => {
    const detail = cappedDetail(['console.log(value);', '    this.foo = bar;']);

    expect(detail).not.toContain('Failing files');
  });

  /** A bare name counts when it opens the line and a location follows it. This holds for the form of tsc and msbuild, and for the form of go vet and ruff. */
  it('CapFailDetail_ABareNameThatOpensTheLineBeforeALocation_IsAFile', () => {
    const detail = cappedDetail([
      'Program.cs(12,5): error CS1002: ; expected',
      'main.go:3:1: unreachable code',
      '  setup.py:1:1: F401 unused import',
    ]);

    expect(detail).toContain('Failing files (3):');
    expect(detail).toContain('Program.cs: 1');
    expect(detail).toContain('main.go: 1');
    expect(detail).toContain('setup.py: 1');
  });

  /** A path counts at any place on a line, also after a dotted word. A line counts for the path, not for the word. */
  it('CapFailDetail_APathAfterADottedWord_IsTheFileOfTheLine', () => {
    const detail = cappedDetail([
      '  --> src/main.rs:2:5',
      'error foo.bar: src/a.ts → src/b.ts',
      'at console.log (/abs/src/c.ts:1:1)',
      '/abs/src/d.ts',
      './cmd/e.go:1:1: vet failed',
    ]);

    expect(detail).toContain('Failing files (5):');
    expect(detail).toContain('src/main.rs: 1');
    expect(detail).toContain('src/a.ts: 1');
    expect(detail).toContain('/abs/src/c.ts: 1');
    expect(detail).toContain('/abs/src/d.ts: 1');
    expect(detail).toContain('./cmd/e.go: 1');
    expect(detail).not.toContain('foo.bar: 1');
  });

  /** A win32 tool prints a backslash path. The separator counts, so the file list of such a run is not empty. */
  it('CapFailDetail_ABackslashPath_IsAFile', () => {
    const detail = cappedDetail(['C:\\repo\\src\\Foo.cs(12,5): error CS1002: ; expected']);

    expect(detail).toContain('Failing files (1):');
    expect(detail).toContain('src\\Foo.cs: 1');
  });

  /** A version is not a file, in a path or in a bare token, because an extension starts with a letter. */
  it('CapFailDetail_AVersion_IsNotAFile', () => {
    const detail = cappedDetail(['rubocop 1.2.3 stopped', 'node/20.1.2 failed']);

    expect(detail).not.toContain('Failing files');
  });
});
