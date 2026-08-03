import { describe, it, expect } from 'vitest';
import {
  canonicalizeText,
  digestText,
  digestParts,
  digestIdentifierSet,
  isWellFormedDigest,
  isFloatingVersionSpec,
  isExactVersionPin,
  DIGEST_RE,
} from './authority-digest.js';

describe('canonicalizeText', () => {
  it('Canonicalize_NormalizesCrlfAndCrToLf', () => {
    expect(canonicalizeText('a\r\nb\rc\nd')).toBe('a\nb\nc\nd');
  });

  it('Canonicalize_StripsTrailingNewlines', () => {
    expect(canonicalizeText('a\nb\n\n\n')).toBe('a\nb');
    expect(canonicalizeText('a\nb')).toBe('a\nb');
  });

  it('Canonicalize_IsIdempotent', () => {
    const once = canonicalizeText('x\r\ny\r\n\r\n');
    expect(canonicalizeText(once)).toBe(once);
  });
});

describe('digestText — determinism + line-ending normalization', () => {
  it('Digest_IsStableAcrossCalls', () => {
    expect(digestText('hello\nworld')).toBe(digestText('hello\nworld'));
  });

  it('Digest_IsLineEndingIndependent', () => {
    // CRLF (Windows), CR (classic Mac), and LF (Linux) forms of the SAME
    // content must hash identically — the cross-machine reproducibility
    // guarantee the freeze depends on.
    const lf = digestText('line1\nline2\nline3');
    const crlf = digestText('line1\r\nline2\r\nline3');
    const cr = digestText('line1\rline2\rline3');
    expect(crlf).toBe(lf);
    expect(cr).toBe(lf);
  });

  it('Digest_IgnoresTrailingNewlineDifferences', () => {
    expect(digestText('body\n')).toBe(digestText('body'));
    expect(digestText('body\r\n')).toBe(digestText('body'));
  });

  it('Digest_DistinguishesDifferentContent', () => {
    expect(digestText('alpha')).not.toBe(digestText('beta'));
  });

  it('Digest_HasWellFormedShape', () => {
    expect(DIGEST_RE.test(digestText('anything'))).toBe(true);
    expect(isWellFormedDigest(digestText('anything'))).toBe(true);
  });
});

describe('digestParts / digestIdentifierSet', () => {
  it('DigestParts_IsOrderSensitive', () => {
    expect(digestParts(['a', 'b'])).not.toBe(digestParts(['b', 'a']));
  });

  it('DigestIdentifierSet_IsOrderIndependent', () => {
    expect(digestIdentifierSet(['a', 'b', 'c'])).toBe(digestIdentifierSet(['c', 'a', 'b']));
  });

  it('DigestIdentifierSet_DedupesDuplicates', () => {
    expect(digestIdentifierSet(['a', 'a', 'b'])).toBe(digestIdentifierSet(['a', 'b']));
  });

  it('DigestIdentifierSet_ReactsToMembershipChange', () => {
    expect(digestIdentifierSet(['a', 'b'])).not.toBe(digestIdentifierSet(['a', 'b', 'c']));
  });
});

describe('isFloatingVersionSpec — floating detection', () => {
  it('Floating_ExactPinsAreNotFloating', () => {
    for (const exact of ['1.29.0', '2.12.0-preview.3', '2025-11-25', '0.0.1', 'v1.2.3']) {
      expect(isFloatingVersionSpec(exact)).toBe(false);
      expect(isExactVersionPin(exact)).toBe(true);
    }
  });

  it('Floating_RangesAndTagsAreFloating', () => {
    for (const floating of [
      '',
      '   ',
      '^1.29.0',
      '~1.29.0',
      '>=1.2.0',
      '<2.0.0',
      '1.2.0 || 2.0.0',
      '1.2.0 - 1.3.0',
      '1.x',
      '1.2.*',
      '*',
      'x',
      'latest',
      'next',
    ]) {
      expect(isFloatingVersionSpec(floating)).toBe(true);
      expect(isExactVersionPin(floating)).toBe(false);
    }
  });
});
