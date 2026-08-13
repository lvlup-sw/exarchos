import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { makeRegisterSchema, isEntryExpired } from './register-entry-schema.js';

// The knip register keys on { symbol, file }; this is the exact schema the
// wrapper builds. Task 010's edge register will call makeRegisterSchema with
// its own key fields — the "extensibility" test below pins that seam.
const knipSchema = makeRegisterSchema({
  symbol: z.string().min(1),
  file: z.string().min(1),
});

const validExpires = {
  symbol: 'DeadType',
  file: 'src/foo.ts',
  owner: '@reedsalus',
  expires: '2026-10-31',
  rationale: 'forward-compat surface',
};
const validPermanent = {
  symbol: 'getEmbeddedRuntime',
  file: 'src/install/runtimes/embedded.ts',
  owner: '@reedsalus',
  permanent: true as const,
  rationale: 'codegen-emitted',
};

describe('makeRegisterSchema — shared { owner, rationale, expires XOR permanent } contract', () => {
  it('accepts a well-formed expiring entry', () => {
    expect(knipSchema.safeParse(validExpires).success).toBe(true);
  });

  it('accepts a well-formed permanent entry', () => {
    expect(knipSchema.safeParse(validPermanent).success).toBe(true);
  });

  it('REJECTS an entry missing owner', () => {
    const { owner: _drop, ...noOwner } = validExpires;
    const r = knipSchema.safeParse(noOwner);
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues.some((i) => i.path.includes('owner'))).toBe(true);
  });

  it('REJECTS an entry missing rationale', () => {
    const { rationale: _drop, ...noRationale } = validExpires;
    const r = knipSchema.safeParse(noRationale);
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues.some((i) => i.path.includes('rationale'))).toBe(true);
  });

  it('REJECTS an entry with an empty owner string', () => {
    expect(knipSchema.safeParse({ ...validExpires, owner: '' }).success).toBe(false);
  });

  it('REJECTS an entry missing BOTH expires and permanent (no expiry)', () => {
    const { expires: _drop, ...noExpiry } = validExpires;
    expect(knipSchema.safeParse(noExpiry).success).toBe(false);
  });

  it('REJECTS an entry that sets BOTH expires and permanent (XOR violated)', () => {
    expect(
      knipSchema.safeParse({ ...validExpires, permanent: true }).success,
    ).toBe(false);
  });

  it('REJECTS a malformed expires date', () => {
    expect(knipSchema.safeParse({ ...validExpires, expires: '10/31/2026' }).success).toBe(false);
    expect(knipSchema.safeParse({ ...validExpires, expires: '2026-13-01' }).success).toBe(false);
    // impossible rollover date must be rejected, not silently normalized
    expect(knipSchema.safeParse({ ...validExpires, expires: '2026-02-30' }).success).toBe(false);
  });

  it('REJECTS permanent set to a non-true value', () => {
    const { expires: _drop, ...base } = validExpires;
    expect(knipSchema.safeParse({ ...base, permanent: false }).success).toBe(false);
  });

  it('REJECTS an unknown/typo field (strict) so `expiry` never silently voids the contract', () => {
    const { expires: _drop, ...base } = validExpires;
    expect(knipSchema.safeParse({ ...base, expiry: '2026-10-31' }).success).toBe(false);
  });

  it('REJECTS an entry missing a per-register key field (symbol)', () => {
    const { symbol: _drop, ...noSymbol } = validExpires;
    expect(knipSchema.safeParse(noSymbol).success).toBe(false);
  });
});

describe('makeRegisterSchema — extensible for a different register (task 010 edge shape)', () => {
  const edgeSchema = makeRegisterSchema({
    from: z.string().min(1),
    to: z.string().min(1),
  });

  it('validates the register-specific key fields', () => {
    const ok = {
      from: 'A',
      to: 'B',
      owner: '@reedsalus',
      permanent: true as const,
      rationale: 'legitimate cross-tier edge',
    };
    expect(edgeSchema.safeParse(ok).success).toBe(true);
    expect(edgeSchema.safeParse({ ...ok, from: undefined }).success).toBe(false);
  });

  it('still enforces the shared contract (rejects missing owner)', () => {
    expect(
      edgeSchema.safeParse({ from: 'A', to: 'B', permanent: true, rationale: 'x' }).success,
    ).toBe(false);
  });
});

describe('isEntryExpired', () => {
  const now = new Date('2026-07-16T12:00:00.000Z');

  it('never treats a permanent entry as expired', () => {
    expect(isEntryExpired({ owner: 'o', rationale: 'r', permanent: true }, now)).toBe(false);
  });

  it('treats an entry with a past deadline as expired', () => {
    expect(isEntryExpired({ owner: 'o', rationale: 'r', expires: '2026-01-01' }, now)).toBe(true);
  });

  it('treats an entry with a future deadline as unexpired', () => {
    expect(isEntryExpired({ owner: 'o', rationale: 'r', expires: '2026-12-31' }, now)).toBe(false);
  });

  it('keeps an entry valid THROUGH the end of its deadline day, and flips the day after', () => {
    const entry = { owner: 'o', rationale: 'r', expires: '2026-07-16' };
    expect(isEntryExpired(entry, new Date('2026-07-16T23:59:00.000Z'))).toBe(false);
    expect(isEntryExpired(entry, new Date('2026-07-17T00:00:01.000Z'))).toBe(true);
  });
});
