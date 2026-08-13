/**
 * Cross-consistency: the digest primitives in `artifact-agreement.ts` are a
 * hand-copied mirror of two MCP-package modules (they can't be imported in
 * production because the root package's `rootDir` is `./src`). This test imports
 * both upstreams and asserts byte-identical digests so the mirror cannot drift:
 *
 *   - {@link digestText}  ≡  P03-01 authority-digest `digestText`
 *   - {@link digestTree}  ≡  P05-04 install-identity `digestTree`
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { digestText, digestTree } from './artifact-agreement.js';

// Minimal typed surfaces so no `any` leaks in from the dynamic imports.
type TextDigester = { digestText: (t: string) => string };
type TreeDigester = {
  digestTree: (e: ReadonlyArray<{ path: string; content: string }>) => string;
};

let authorityDigest: TextDigester;
let installIdentity: TreeDigester;

beforeAll(async () => {
  authorityDigest = (await import(
    '../contract/authority-digest.js'
  )) as unknown as TextDigester;
  installIdentity = (await import(
    './install-identity.js'
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

describe('digestTree mirrors P05-04 install-identity', () => {
  const trees: ReadonlyArray<ReadonlyArray<{ path: string; content: string }>> = [
    [],
    [{ path: 'a.md', content: 'x\n' }],
    [
      { path: 'b/two.md', content: 'y\r\n' },
      { path: 'a/one.md', content: 'x\n' },
    ],
    // ambiguity guard: {a,b} vs {ab,''} must not collide (NUL delimiter).
    [
      { path: 'a', content: 'b' },
      { path: 'ab', content: '' },
    ],
    // BOM stripping
    [{ path: 'bom.md', content: '\uFEFFhello' }],
  ];
  for (const [i, tree] of trees.entries()) {
    it(`tree ${i} agrees`, () => {
      expect(digestTree(tree)).toBe(installIdentity.digestTree(tree));
    });
  }
});
