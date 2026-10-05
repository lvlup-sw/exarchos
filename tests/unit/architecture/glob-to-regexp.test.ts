import { describe, it, expect } from 'vitest';
import { globToRegExp } from '../../../src/architecture/glob-to-regexp.js';

describe('globToRegExp (shared, FIX-3)', () => {
  it('GlobToRegExp_SingleStar_MatchesWithinSegmentOnly', () => {
    const re = globToRegExp('*.ts');
    expect(re.test('foo.ts')).toBe(true);
    expect(re.test('bar.tsx')).toBe(false);
    expect(re.test('src/foo.ts')).toBe(false);
  });

  it('GlobToRegExp_DoubleStar_CrossesSeparators', () => {
    const re = globToRegExp('src/**');
    expect(re.test('src/foo.ts')).toBe(true);
    expect(re.test('src/a/b/c.ts')).toBe(true);
    expect(re.test('lib/foo.ts')).toBe(false);
  });

  /** The compiled source shows the escaped separator. */
  it('GlobToRegExp_EscapesPathSeparator', () => {
    expect(globToRegExp('a/b').source).toBe('^a\\/b$');
    expect(globToRegExp('a/b').test('a/b')).toBe(true);
  });

  /** A dot in the glob matches only a literal dot. */
  it('GlobToRegExp_EscapesRegexSpecials', () => {
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

  /**
   * A double star with a slash after it matches zero or more segments, so a file directly in `servers/` must match.
   * An expansion to a bare `.*\/` excludes that zero-depth case.
   * The pattern stays anchored: a path with a different first segment must not match.
   */
  it('GlobToRegExp_DoubleStarSlash_MatchesZeroDepth', () => {
    const re = globToRegExp('servers/**/*.ts');
    expect(re.test('servers/foo.ts')).toBe(true);
    expect(re.test('servers/a/foo.ts')).toBe(true);
    expect(re.test('servers/a/b/foo.ts')).toBe(true);
    expect(re.test('other/foo.ts')).toBe(false);
  });
});
