// Tests for `deriveElicitationSchema`, which derives a JSON Schema for one field of a Zod input schema.

import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { deriveElicitationSchema } from '../../../../src/workflow/capabilities/elicitation.js';
import { zodToJsonSchema } from '../../../../src/utils/json-schema.js';

describe('deriveElicitationSchema (#1274)', () => {
  /**
   * The helper is `pick` plus `zodToJsonSchema`. The expected value uses the same adapter, so the test pins the wire shape that callers see.
   */
  it('ElicitationSchema_DerivedViaPick_MatchesInputSchema', () => {
    const inputSchema = z.object({
      featureId: z.string(),
      target: z.string(),
    });

    const derived = deriveElicitationSchema(inputSchema, 'target') as Record<string, unknown>;
    const expected = zodToJsonSchema(inputSchema.pick({ target: true })) as Record<string, unknown>;

    expect(derived.type).toBe('object');
    const properties = derived.properties as Record<string, unknown>;
    expect(Object.keys(properties)).toEqual(['target']);
    expect(derived).toEqual(expected);
  });

  it('ElicitationSchema_DerivationIdempotent', () => {
    const inputSchema = z.object({
      featureId: z.string(),
      target: z.string(),
    });
    const a = deriveElicitationSchema(inputSchema, 'featureId');
    const b = deriveElicitationSchema(inputSchema, 'featureId');
    expect(a).toEqual(b);
  });

  /**
   * Zod v4 `.pick({missing: true})` returns an empty schema and does not throw.
   * The helper must throw, so a wrong field name gives a clear error and not an empty prompt.
   */
  it('ElicitationSchema_UnknownField_ThrowsExplicitError', () => {
    const inputSchema = z.object({
      featureId: z.string(),
      target: z.string(),
    });
    expect(() => deriveElicitationSchema(inputSchema, 'missing')).toThrow(
      /field 'missing' is not declared/,
    );
  });
});
