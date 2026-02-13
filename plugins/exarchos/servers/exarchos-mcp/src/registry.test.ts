import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { buildCompositeSchema } from './registry.js';
import type { ToolAction } from './registry.js';

describe('buildCompositeSchema', () => {
  it('should create a discriminated union from two actions', () => {
    const actions: readonly ToolAction[] = [
      {
        name: 'init',
        description: 'Initialize a workflow',
        schema: z.object({ featureId: z.string() }),
        phases: new Set(['ideate']),
        roles: new Set(['lead']),
      },
      {
        name: 'get',
        description: 'Get workflow state',
        schema: z.object({ query: z.string().optional() }),
        phases: new Set(['ideate', 'plan']),
        roles: new Set(['any']),
      },
    ];

    const schema = buildCompositeSchema(actions);

    // Should parse a valid 'init' action
    const initResult = schema.safeParse({ action: 'init', featureId: 'test' });
    expect(initResult.success).toBe(true);

    // Should parse a valid 'get' action
    const getResult = schema.safeParse({ action: 'get', query: 'phase' });
    expect(getResult.success).toBe(true);

    // Should parse 'get' with optional field omitted
    const getNoQueryResult = schema.safeParse({ action: 'get' });
    expect(getNoQueryResult.success).toBe(true);

    // Should reject an invalid action
    const invalidResult = schema.safeParse({ action: 'invalid' });
    expect(invalidResult.success).toBe(false);
  });
});
