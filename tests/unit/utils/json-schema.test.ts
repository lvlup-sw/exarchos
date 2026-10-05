import { describe, it, expect } from 'vitest';
import { z } from 'zod';

import { zodToJsonSchema } from '../../../src/utils/json-schema.js';

describe('utils/json-schema', () => {
  /** A tuple tells the drafts apart: 2020-12 emits `prefixItems`, and draft-7 emits an array in `items`. */
  it('zodToJsonSchema_DefaultTarget_EmitsNative2020Draft', () => {
    const schema = z.tuple([z.string(), z.number()]);
    const result = zodToJsonSchema(schema) as Record<string, unknown>;

    expect(result.$schema).toBe('https://json-schema.org/draft/2020-12/schema');
    expect(result.prefixItems).toBeDefined();
    expect(Array.isArray(result.prefixItems)).toBe(true);
    expect(Array.isArray(result.items)).toBe(false);
  });

  /** `unrepresentable: 'any'` is an option that only `z.toJSONSchema` reads. */
  it('zodToJsonSchema_RespectsCallerOpts_PassesThroughToUpstream', () => {
    const schema = z.object({ foo: z.string() });
    const result = zodToJsonSchema(schema, { unrepresentable: 'any' }) as Record<
      string,
      unknown
    >;

    expect(result.$schema).toBe('https://json-schema.org/draft/2020-12/schema');
    expect(result.type).toBe('object');
  });

  it('zodToJsonSchema_ExplicitTarget_OverridesDefault', () => {
    const schema = z.object({ foo: z.string() });
    const result = zodToJsonSchema(schema, { target: 'draft-7' }) as Record<
      string,
      unknown
    >;

    expect(result.$schema).toBe('http://json-schema.org/draft-07/schema#');
    expect(result.$schema).not.toBe('https://json-schema.org/draft/2020-12/schema');
  });
});
