// ─── #1274 — Elicitation sub-schema derivation tests ─────────────────────────

import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { deriveElicitationSchema } from '../../../../src/workflow/capabilities/elicitation.js';
import { zodToJsonSchema } from '../../../../src/utils/json-schema.js';

describe('deriveElicitationSchema (#1274)', () => {
  it('ElicitationSchema_DerivedViaPick_MatchesInputSchema', () => {
    // Given a Zod input schema with `featureId` and `target`, calling
    // `deriveElicitationSchema(schema, 'target')` should return a JSON
    // Schema with only the `target` field — matching what
    // `schema.pick({target: true})` would produce.
    const inputSchema = z.object({
      featureId: z.string(),
      target: z.string(),
    });

    const derived = deriveElicitationSchema(inputSchema, 'target') as Record<string, unknown>;
    // Use the same internal adapter so the comparison pins the actual
    // wire shape that callers will see (draft-2020-12, etc.).
    const expected = zodToJsonSchema(inputSchema.pick({ target: true })) as Record<string, unknown>;

    // Shape comparison: the derived schema must declare the `target`
    // property and only the `target` property.
    expect(derived.type).toBe('object');
    const properties = derived.properties as Record<string, unknown>;
    expect(Object.keys(properties)).toEqual(['target']);
    // And the JSON Schema must match a fresh pick().toJSONSchema()
    // exactly — `deriveElicitationSchema` is just `pick + zodToJsonSchema`.
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

  it('ElicitationSchema_UnknownField_ThrowsExplicitError', () => {
    // CR PR #1432: Zod v4 `.pick({missing: true})` silently returns an
    // empty schema rather than throwing. The helper MUST guard against
    // this so a misnamed field surfaces as an actionable error instead
    // of an empty elicitation prompt to the client.
    const inputSchema = z.object({
      featureId: z.string(),
      target: z.string(),
    });
    expect(() => deriveElicitationSchema(inputSchema, 'missing')).toThrow(
      /field 'missing' is not declared/,
    );
  });
});
