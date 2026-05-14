import { describe, it, expect } from 'vitest';
import { z } from 'zod';

import { zodToJsonSchema } from './json-schema.js';

describe('adapters/json-schema wrapper', () => {
  it('zodToJsonSchema_DefaultTarget_Emits2020Draft', () => {
    const schema = z.object({ foo: z.string() });
    const result = zodToJsonSchema(schema) as Record<string, unknown>;

    expect(result.$schema).toBe('https://json-schema.org/draft/2020-12/schema');
  });

  it('zodToJsonSchema_PassThroughOverrides_RespectsCallerOptions', () => {
    const schema = z.object({ foo: z.string() });
    const result = zodToJsonSchema(schema, { name: 'MySchema' }) as Record<string, unknown>;

    // When `name` is supplied, the upstream emits a $ref pointing into a
    // `definitions` block keyed by the name — caller options must pass through.
    expect(result.$ref).toBe('#/definitions/MySchema');
    expect(result.definitions).toBeDefined();
    expect((result.definitions as Record<string, unknown>).MySchema).toBeDefined();
  });

  it('zodToJsonSchema_ExplicitTarget_OverridesDefault', () => {
    const schema = z.object({ foo: z.string() });
    const result = zodToJsonSchema(schema, { target: 'jsonSchema7' }) as Record<string, unknown>;

    // Caller-supplied target wins; result must NOT carry the 2020-12 marker.
    expect(result.$schema).not.toBe('https://json-schema.org/draft/2020-12/schema');
    expect(result.$schema).toBe('http://json-schema.org/draft-07/schema#');
  });
});
