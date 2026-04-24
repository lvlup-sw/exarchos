import { describe, it, expect } from 'vitest';
import { StableSectionsSchema } from './schema.js';

describe('rehydration document stable-sections schema (T011, DR-3)', () => {
  it('RehydrationDoc_MinimalStableSections_Parses', () => {
    const minimalInput = {
      behavioralGuidance: {
        skill: 'rehydrate-foundation',
        skillRef: 'skills/claude-code/rehydrate-foundation/SKILL.md',
      },
      workflowState: {
        featureId: 'rehydrate-foundation',
        phase: 'implementation',
        workflowType: 'feature',
      },
    };

    const result = StableSectionsSchema.safeParse(minimalInput);

    expect(result.success).toBe(true);
  });
});
