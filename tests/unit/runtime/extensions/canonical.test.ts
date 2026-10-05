import { describe, it, expect } from 'vitest';
import {
  canonicalBytes,
  canonicalJson,
  CanonicalJsonError,
  type CanonicalJsonValue,
} from '../../../../src/runtime/extensions/canonical.js';

describe('canonicalJson (P03-08 signature payloads)', () => {
  /** Two equal objects with a different key insertion order must serialize to the same signed bytes. */
  it('Canonical_KeyOrderIndependent_SameBytes', () => {
    const a: CanonicalJsonValue = { b: 1, a: 2, c: { y: 1, x: 2 } };
    const b: CanonicalJsonValue = { c: { x: 2, y: 1 }, a: 2, b: 1 };
    expect(canonicalJson(a)).toBe(canonicalJson(b));
    expect(canonicalJson(a)).toBe('{"a":2,"b":1,"c":{"x":2,"y":1}}');
  });

  /** An array is ordered data, so its order is part of the signed bytes. */
  it('Canonical_PreservesArrayOrder', () => {
    expect(canonicalJson(['b', 'a', 'c'])).toBe('["b","a","c"]');
    expect(canonicalJson(['b', 'a', 'c'])).not.toBe(canonicalJson(['a', 'b', 'c']));
  });

  it('Canonical_RejectsNonFiniteNumbers', () => {
    expect(() => canonicalJson(Number.NaN as unknown as CanonicalJsonValue)).toThrow(
      CanonicalJsonError,
    );
    expect(() =>
      canonicalJson(Number.POSITIVE_INFINITY as unknown as CanonicalJsonValue),
    ).toThrow(CanonicalJsonError);
  });

  it('Canonical_BytesAreUtf8OfText', () => {
    const value: CanonicalJsonValue = { greeting: 'héllo', n: 3 };
    expect(canonicalBytes(value).toString('utf8')).toBe(canonicalJson(value));
  });
});
