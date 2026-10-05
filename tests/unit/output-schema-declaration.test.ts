/**
 * Kill fixtures for `withCappedShape`, the only constructor of a substantive `outputSchema`.
 *
 * The constructor must refuse a base whose `data` accepts every value. The capped union of that
 * base still accepts every payload, but it carries the declared brand. Without the refusal, a
 * caller can replace a `vacuityWaiver` with this call and leave the response contract unchanged.
 *
 * `tools/conformance/src/output-schema-census.test.ts` holds the census half. There the same union
 * classifies as vacuous when a caller builds it by hand.
 */

import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { withCappedShape, isDeclaredOutputSchema } from '../../src/output-schema-declaration.js';
import { EnvelopeSchema } from '../../src/contract/schemas/envelope.js';

describe('withCappedShape — refuses a vacuity only on the envelope-shaped path (task 092)', () => {
  /**
   * `extractEnvelopeDataSchema` returns `undefined` for a schema that is not an envelope, so the
   * totality check cannot see it. The constructor must throw for that schema, or it brands a bare
   * `z.unknown()` unchecked.
   */
  it('withCappedShape_BareUnknown_Throws', () => {
    expect(() => withCappedShape(z.unknown())).toThrow(/non-envelope/i);
  });

  it('withCappedShape_BareAny_Throws', () => {
    expect(() => withCappedShape(z.any())).toThrow(/non-envelope/i);
  });

  /**
   * A typed schema that is not an envelope also throws, because it has no `data` branch to widen.
   */
  it('withCappedShape_BareTypedObject_Throws', () => {
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

  /** A wrapper such as `.optional()` must not hide a `data` that accepts every value. */
  it('withCappedShape_OptionalUnknownDataBase_Throws', () => {
    expect(() => withCappedShape(EnvelopeSchema(z.unknown().optional()))).toThrow(
      /accepts every value/i,
    );
  });

  /**
   * The negative control. A constructor that throws for every input passes each test above and
   * breaks each real declaration. The declared schema must still accept the typed shape and reject
   * a wrong shape.
   */
  it('withCappedShape_TypedDataBase_StillDeclares', () => {
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
    expect(declared.safeParse(envelope({ items: ['a'] })).success).toBe(true);
    expect(declared.safeParse(envelope(42)).success).toBe(false);
  });

  /** A capped response is still a member of the declared union. */
  it('withCappedShape_TypedDataBase_AdmitsTheCappedShape', () => {
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
