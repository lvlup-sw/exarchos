// ─── DR-4: `withCappedShape` mints substance, so it must refuse to mint it ────
//
// `withCappedShape` is documented as THE SOLE CONSTRUCTOR of a substantive
// `outputSchema` — the compile-time half of DR-4's "vacuity is unconstructible
// for new actions". It was not: handed a base whose `data` is already total it
// returned `EnvelopeSchema(z.union([z.unknown(), CappedDataSchema]))`, a branded
// DeclaredOutputSchema that accepts every payload and that the census (then an
// `instanceof` test on the outermost node) classified `substantive`. Both teeth
// cleared in one call, and it was the cheapest possible fake paydown: swap a
// `vacuityWaiver` for this call and the brand check, the membership audit, the
// staleness arm, the expiry arm and the frozen seed digest all read green with
// the response contract unchanged.
//
// These are the kill fixtures for that path. The census-side half — that the
// laundered union classifies vacuous even if it is constructed some other way —
// lives in architecture/output-schema-census.test.ts, so neither half can be the
// only thing standing.
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { withCappedShape, isDeclaredOutputSchema } from './output-schema-declaration.js';
import { EnvelopeSchema } from './schemas/envelope.js';

describe('withCappedShape — refuses a vacuity only on the envelope-shaped path (task 092)', () => {
  // The H1 repair above reached its `acceptsEveryValue` throw only through
  // `baseData`, which `extractEnvelopeDataSchema` returns `undefined` for on
  // any non-envelope schema — so the early return above it branded a bare
  // `z.unknown()` / `z.any()` UNCHECKED while the two envelope-wrapped
  // equivalents below were correctly refused. Same defect class as DR-8, one
  // layer in: the guard's subject (the envelope's `data` branch) was narrower
  // than its claim (the whole `outputSchema`). Task 092 closes it by making
  // the non-envelope branch fail loudly instead of branding.
  it('withCappedShape_BareUnknown_Throws', () => {
    expect(() => withCappedShape(z.unknown())).toThrow(/non-envelope/i);
  });

  it('withCappedShape_BareAny_Throws', () => {
    expect(() => withCappedShape(z.any())).toThrow(/non-envelope/i);
  });

  it('withCappedShape_BareTypedObject_Throws', () => {
    // Not just the two total forms — ANY non-envelope schema is rejected,
    // total or not, because this constructor cannot do its job (widening a
    // `data` branch that does not exist) on a schema that never had one.
    expect(() => withCappedShape(z.object({ items: z.array(z.string()) }))).toThrow(
      /non-envelope/i,
    );
  });

  it('withCappedShape_UnknownDataBase_Throws', () => {
    expect(() => withCappedShape(EnvelopeSchema(z.unknown()))).toThrow(
      /accepts every value/i,
    );
  });

  it('withCappedShape_AnyDataBase_Throws', () => {
    expect(() => withCappedShape(EnvelopeSchema(z.any()))).toThrow(/accepts every value/i);
  });

  it('withCappedShape_OptionalUnknownDataBase_Throws', () => {
    // The wrapper forms have to be refused too, or the same laundering just
    // acquires one more layer.
    expect(() => withCappedShape(EnvelopeSchema(z.unknown().optional()))).toThrow(
      /accepts every value/i,
    );
  });

  it('withCappedShape_TypedDataBase_StillDeclares', () => {
    // The negative control. Without it, a `withCappedShape` that threw on
    // EVERYTHING would pass all three assertions above while breaking every real
    // declaration — a guard that always fires is as useless as one that never does.
    const declared = withCappedShape(
      EnvelopeSchema(z.object({ items: z.array(z.string()) })),
    );
    expect(isDeclaredOutputSchema(declared)).toBe(true);

    const envelope = (data: unknown): unknown => ({
      success: true,
      data,
      next_actions: [],
      _meta: {},
      _perf: { ms: 0, bytes: 0, tokens: 0 },
    });
    // It still constrains: the typed shape parses, a wrong shape does not.
    expect(declared.safeParse(envelope({ items: ['a'] })).success).toBe(true);
    expect(declared.safeParse(envelope(42)).success).toBe(false);
  });

  it('withCappedShape_TypedDataBase_AdmitsTheCappedShape', () => {
    // The widening the constructor exists for must survive the new refusal: a
    // capped/truncated response is still a legal member of the declared union.
    const declared = withCappedShape(
      EnvelopeSchema(z.object({ items: z.array(z.string()) })),
    );
    const capped = {
      success: true,
      data: { summary: 'capped', counts: { items: 3 }, firstPage: ['a'] },
      next_actions: [],
      _meta: { truncated: true },
      _perf: { ms: 0, bytes: 0, tokens: 0 },
    };
    expect(declared.safeParse(capped).success).toBe(true);
  });
});
