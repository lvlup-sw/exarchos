// Content addresses for compiled capsules: one document, one digest, whatever
// order its keys were written in — and a different document, a different one.

import { describe, it, expect } from 'vitest';

import { capsuleDigest, contentDigest } from '../../../../src/contract/capsule/capsule-digest.js';
import { baseValidCapsule } from '../../../../src/contract/capsule/exarchos-capsule-fixtures.js';
import { ExarchosCapsuleV1Schema } from '../../../../src/contract/capsule/exarchos-capsule.js';

/** A deep copy with every object's keys written in reverse order. */
function reverseKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reverseKeys);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).reverse()) {
      out[key] = reverseKeys((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

describe('capsule content addresses', () => {
  it('CapsuleDigest_KeyOrder_DoesNotReachTheDigest', () => {
    const capsule = baseValidCapsule();
    const reordered = reverseKeys(capsule);
    // The denominator: the reordering really did change the serialized bytes,
    // or this test would pass for a digest over plain JSON.stringify too.
    expect(JSON.stringify(reordered)).not.toBe(JSON.stringify(capsule));
    expect(contentDigest(reordered)).toBe(capsuleDigest(capsule));
  });

  it('CapsuleDigest_ADifferentCapsule_HasADifferentDigest', () => {
    const base = baseValidCapsule();
    const bumped = { ...base, identity: { ...base.identity, capsuleVersion: 8 } };
    expect(capsuleDigest(bumped)).not.toBe(capsuleDigest(base));
  });

  it('CapsuleDigest_IsSpelledAsTheKernelSpellsADigest', () => {
    const digest = capsuleDigest(baseValidCapsule());
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    // Accepted where the capsule itself carries a kernel digest, so a capsule
    // can name a definition by a digest computed here without re-spelling it.
    const base = baseValidCapsule();
    const pinned = { ...base, identity: { ...base.identity, definitionVersion: digest } };
    expect(ExarchosCapsuleV1Schema.safeParse(pinned).success).toBe(true);
  });
});
