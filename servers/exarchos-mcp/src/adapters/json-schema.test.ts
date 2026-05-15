import { describe, it, expect } from 'vitest';
import { z } from 'zod';

import { zodToJsonSchema } from './json-schema.js';

describe('adapters/json-schema wrapper', () => {
  it('zodToJsonSchema_DefaultTarget_EmitsNative2020Draft', () => {
    // A tuple is a high-signal probe: 2020-12 emits `prefixItems`, draft-7
    // emits an array-form `items`. The wrapper must produce the 2020-12 form
    // by default — proving native emission (not the old relabel workaround).
    const schema = z.tuple([z.string(), z.number()]);
    const result = zodToJsonSchema(schema) as Record<string, unknown>;

    expect(result.$schema).toBe('https://json-schema.org/draft/2020-12/schema');
    expect(result.prefixItems).toBeDefined();
    expect(Array.isArray(result.prefixItems)).toBe(true);
    // Confirm we did NOT fall back to draft-7's array-of-items form.
    expect(Array.isArray(result.items)).toBe(false);
  });

  it('zodToJsonSchema_RespectsCallerOpts_PassesThroughToUpstream', () => {
    // Caller-supplied options must thread through to z.toJSONSchema. We use
    // `unrepresentable: 'any'` (a v4-native option) to verify pass-through —
    // it is meaningful only to the upstream call.
    const schema = z.object({ foo: z.string() });
    const result = zodToJsonSchema(schema, { unrepresentable: 'any' }) as Record<
      string,
      unknown
    >;

    // Default target still wins when caller doesn't override it.
    expect(result.$schema).toBe('https://json-schema.org/draft/2020-12/schema');
    expect(result.type).toBe('object');
  });

  it('zodToJsonSchema_ExplicitTarget_OverridesDefault', () => {
    const schema = z.object({ foo: z.string() });
    const result = zodToJsonSchema(schema, { target: 'draft-7' }) as Record<
      string,
      unknown
    >;

    // Caller-supplied target wins; result must carry the draft-7 marker, not 2020-12.
    expect(result.$schema).toBe('http://json-schema.org/draft-07/schema#');
    expect(result.$schema).not.toBe('https://json-schema.org/draft/2020-12/schema');
  });
});
