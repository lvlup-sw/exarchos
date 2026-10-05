/**
 * @fileoverview Tests for the comment block, fingerprint and baseline module.
 */
import { describe, it, expect } from 'vitest';
import {
  BaselineError,
  countTextOccurrences,
  fingerprint,
  groupBlocks,
  isDirective,
  isSuppressed,
  isTypeAnnotation,
  normalizeBlock,
  parseBaseline,
  serializeBaseline,
} from '../../../tools/audit/lib/comment-baseline.mjs';

/** Find the comments in a small source with a scanner that is good enough for these fixtures. */
function commentsOf(text: string): { type: string; value: string; range: [number, number] }[] {
  const out: { type: string; value: string; range: [number, number] }[] = [];
  const re = /\/\/[^\n]*|\/\*[\s\S]*?\*\//g;
  for (const match of text.matchAll(re)) {
    const start = match.index;
    const raw = match[0];
    const isLine = raw.startsWith('//');
    out.push({
      type: isLine ? 'Line' : 'Block',
      value: isLine ? raw.slice(2) : raw.slice(2, -2),
      range: [start, start + raw.length],
    });
  }
  return out;
}

/** The blocks of a source text. */
function blocksOf(text: string) {
  return groupBlocks(commentsOf(text), text);
}

describe('groupBlocks', () => {
  it('GroupBlocks_AdjacentOwnLineComments_MergeIntoOneBlock', () => {
    const blocks = blocksOf('// one\n// two\nconst a = 1;\n');

    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.text).toBe('one two');
    expect(blocks[0]?.line).toBe(1);
    expect(blocks[0]?.endLine).toBe(2);
  });

  it('GroupBlocks_BlankLineBetweenComments_StartsANewBlock', () => {
    expect(blocksOf('// one\n\n// two\n')).toHaveLength(2);
  });

  it('GroupBlocks_TrailingComment_IsItsOwnBlockAndDoesNotMerge', () => {
    const blocks = blocksOf('const a = 1; // trailing\n// own line\n');

    expect(blocks.map((b) => [b.text, b.ownLine])).toEqual([
      ['trailing', false],
      ['own line', true],
    ]);
  });

  it('GroupBlocks_DirectiveBetweenComments_BreaksTheRunAndIsNotABlock', () => {
    const blocks = blocksOf('// one\n// eslint-disable-next-line no-console\n// two\n');

    expect(blocks.map((b) => b.text)).toEqual(['one', 'two']);
  });

  it('GroupBlocks_BlockComment_IsOneBlock', () => {
    const blocks = blocksOf('/**\n * a\n * b\n */\n// next\n');

    expect(blocks.map((b) => [b.kind, b.text])).toEqual([
      ['block', 'a b'],
      ['line', 'next'],
    ]);
  });

  it('GroupBlocks_TypeOnlyJsdoc_IsNotABlock', () => {
    expect(blocksOf('const a = /** @type {string} */ (b);\n')).toEqual([]);
  });
});

describe('isTypeAnnotation', () => {
  it('IsTypeAnnotation_TypeTagsWithoutProse_ReturnsTrue', () => {
    expect(isTypeAnnotation('* @type {string} ')).toBe(true);
    expect(isTypeAnnotation('*\n * @param {string} name\n * @returns {number}\n ')).toBe(true);
    expect(isTypeAnnotation('*\n * @typedef {object} Point\n * @property {number} x\n ')).toBe(true);
  });

  it('IsTypeAnnotation_TagWithProse_ReturnsFalse', () => {
    expect(isTypeAnnotation('*\n * @param {string} name The name to greet.\n ')).toBe(false);
    expect(isTypeAnnotation('* Describes the thing. ')).toBe(false);
    expect(isTypeAnnotation(' not jsdoc ')).toBe(false);
  });
});

describe('isDirective', () => {
  it('IsDirective_ToolInstruction_ReturnsTrue', () => {
    for (const value of [' eslint-disable-next-line', ' @ts-expect-error reason', ' istanbul ignore next ', '/ <reference types="node" />']) {
      expect(isDirective(value), value).toBe(true);
    }
  });

  it('IsDirective_Prose_ReturnsFalse', () => {
    expect(isDirective(' the retry budget is three')).toBe(false);
  });
});

describe('fingerprint', () => {
  it('Fingerprint_IndentationAndLineEndings_DoNotChangeTheHash', () => {
    expect(fingerprint('  // a\r\n    // b')).toBe(fingerprint('// a\n// b'));
  });

  it('Fingerprint_RewordedOrRewrappedText_ChangesTheHash', () => {
    expect(fingerprint('// a b')).not.toBe(fingerprint('// a\n// b'));
    expect(fingerprint('// one')).not.toBe(fingerprint('// two'));
  });

  it('Fingerprint_IsTwelveHexCharacters', () => {
    expect(fingerprint('// x')).toMatch(/^[0-9a-f]{12}$/);
  });
});

describe('baseline text', () => {
  it('ParseBaseline_ThenSerialize_RoundTripsInCanonicalOrder', () => {
    const text = 'b.ts\t222222222222\t1\na.ts\t111111111111\t2\n';
    const canonical = serializeBaseline(parseBaseline(text));

    expect(canonical).toBe('a.ts\t111111111111\t2\nb.ts\t222222222222\t1\n');
    expect(serializeBaseline(parseBaseline(canonical))).toBe(canonical);
  });

  it('ParseBaseline_MalformedLine_Throws', () => {
    expect(() => parseBaseline('a.ts\tnot-a-hash\t1\n')).toThrow(BaselineError);
    expect(() => parseBaseline('a.ts\t111111111111\t0\n')).toThrow(BaselineError);
    expect(() => parseBaseline('a.ts\t111111111111\n')).toThrow(BaselineError);
  });

  it('ParseBaseline_RepeatedEntry_Throws', () => {
    expect(() => parseBaseline('a.ts\t111111111111\t1\na.ts\t111111111111\t1\n')).toThrow(/repeats/);
  });

  it('SerializeBaseline_Empty_IsEmptyText', () => {
    expect(serializeBaseline(new Map())).toBe('');
  });
});

describe('isSuppressed', () => {
  it('IsSuppressed_CoversOnlyTheFirstCountViolatingCopies', () => {
    const entries = new Map([['111111111111', 2]]);

    expect(isSuppressed(entries, '111111111111', 0)).toBe(true);
    expect(isSuppressed(entries, '111111111111', 1)).toBe(true);
    expect(isSuppressed(entries, '111111111111', 2)).toBe(false);
    expect(isSuppressed(undefined, '111111111111', 0)).toBe(false);
  });
});

describe('countTextOccurrences', () => {
  it('CountTextOccurrences_CountsCopiesAcrossIndentation', () => {
    const file = 'function f() {\n  // keep this\n}\n// keep this\n';

    expect(countTextOccurrences(file, '// keep this')).toBe(2);
    expect(countTextOccurrences(file, '// not here')).toBe(0);
  });

  it('CountTextOccurrences_MultiLineBlock_MatchesOnlyContiguousLines', () => {
    expect(countTextOccurrences('// a\n// b\n', '// a\n// b')).toBe(1);
    expect(countTextOccurrences('// a\nx\n// b\n', '// a\n// b')).toBe(0);
  });

  it('NormalizeBlock_TrimsEachLine', () => {
    expect(normalizeBlock('  a  \r\n  b')).toBe('a\nb');
  });
});
