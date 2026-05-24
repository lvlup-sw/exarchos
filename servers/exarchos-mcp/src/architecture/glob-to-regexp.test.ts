import { describe, it, expect } from 'vitest';
import { globToRegExp } from './glob-to-regexp.js';

describe('globToRegExp (shared, FIX-3)', () => {
  it('GlobToRegExp_SingleStar_MatchesWithinSegmentOnly', () => {
    const re = globToRegExp('*.ts');
    expect(re.test('foo.ts')).toBe(true);
    expect(re.test('bar.tsx')).toBe(false);
    // single `*` must NOT cross a path separator.
    expect(re.test('src/foo.ts')).toBe(false);
  });

  it('GlobToRegExp_DoubleStar_CrossesSeparators', () => {
    const re = globToRegExp('src/**');
    expect(re.test('src/foo.ts')).toBe(true);
    expect(re.test('src/a/b/c.ts')).toBe(true);
    expect(re.test('lib/foo.ts')).toBe(false);
  });

  it('GlobToRegExp_EscapesPathSeparator', () => {
    // `/` is escaped to a literal separator: the compiled source proves it.
    expect(globToRegExp('a/b').source).toBe('^a\\/b$');
    expect(globToRegExp('a/b').test('a/b')).toBe(true);
  });

  it('GlobToRegExp_EscapesRegexSpecials', () => {
    // A dot is a literal, not "any char".
    const re = globToRegExp('file.ts');
    expect(re.test('file.ts')).toBe(true);
    expect(re.test('fileXts')).toBe(false);
  });

  it('GlobToRegExp_AnchorsWholePath', () => {
    const re = globToRegExp('foo');
    expect(re.test('foo')).toBe(true);
    expect(re.test('xfooy')).toBe(false);
  });

  it('GlobToRegExp_MixedDoubleStarSuffix', () => {
    const re = globToRegExp('servers/**/*.ts');
    expect(re.test('servers/a/b.ts')).toBe(true);
    expect(re.test('servers/a/b/c.ts')).toBe(true);
  });

  it('GlobToRegExp_DoubleStarSlash_MatchesZeroDepth', () => {
    // `**/` means "zero or more leading segments, including none", so a file
    // directly under `servers/` must match — not just nested files. Regression
    // guard: a bare `.*\/` expansion silently excludes the zero-depth case.
    const re = globToRegExp('servers/**/*.ts');
    expect(re.test('servers/foo.ts')).toBe(true);
    expect(re.test('servers/a/foo.ts')).toBe(true);
    expect(re.test('servers/a/b/foo.ts')).toBe(true);
    // still anchored: a sibling prefix must not match.
    expect(re.test('other/foo.ts')).toBe(false);
  });
});
