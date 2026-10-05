/**
 * `artifact-agreement.ts` holds copies of two digests: `digestText` in
 * `src/contract/authority-digest.ts` and `digestTree` in `src/install/install-identity.ts`.
 * These tests assert that each copy gives the same digest as its source.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { digestText, digestTree } from '../../../src/install/artifact-agreement.js';

/** The part of the dynamically imported `authority-digest` module that these tests use. */
type TextDigester = { digestText: (t: string) => string };
type TreeDigester = {
  digestTree: (e: ReadonlyArray<{ path: string; content: string }>) => string;
};

let authorityDigest: TextDigester;
let installIdentity: TreeDigester;

beforeAll(async () => {
  authorityDigest = (await import(
    '../../../src/contract/authority-digest.js'
  )) as unknown as TextDigester;
  installIdentity = (await import(
    '../../../src/install/install-identity.js'
  )) as unknown as TreeDigester;
});

describe('digestText mirrors P03-01 authority-digest', () => {
  const cases = [
    'plain',
    'trailing\n\n\n',
    'crlf\r\nmixed\r\n',
    'classic\rmac',
    'unicode — π ✓ 🚀',
    '',
    'interior\n\nblank\nlines',
  ];
  for (const [i, text] of cases.entries()) {
    it(`case ${i} agrees`, () => {
      expect(digestText(text)).toBe(authorityDigest.digestText(text));
    });
  }
});

/**
 * Tree 3 holds two entries that give the same bytes when no delimiter divides path and content.
 * Tree 4 starts with a BOM.
 */
describe('digestTree mirrors P05-04 install-identity', () => {
  const trees: ReadonlyArray<ReadonlyArray<{ path: string; content: string }>> = [
    [],
    [{ path: 'a.md', content: 'x\n' }],
    [
      { path: 'b/two.md', content: 'y\r\n' },
      { path: 'a/one.md', content: 'x\n' },
    ],
    [
      { path: 'a', content: 'b' },
      { path: 'ab', content: '' },
    ],
    [{ path: 'bom.md', content: '\uFEFFhello' }],
  ];
  for (const [i, tree] of trees.entries()) {
    it(`tree ${i} agrees`, () => {
      expect(digestTree(tree)).toBe(installIdentity.digestTree(tree));
    });
  }
});
