import { describe, it, expect } from 'vitest';
import { StableSectionsSchema, VolatileSectionsSchema } from './schema.js';

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

describe('rehydration document volatile-sections schema (T012, DR-3)', () => {
  it('RehydrationDoc_FullVolatileSections_Parses', () => {
    const fullInput = {
      taskProgress: [
        { id: 'T011', status: 'complete' },
        { id: 'T012', status: 'in-progress' },
      ],
      decisions: [
        { id: 'DR-3', summary: 'canonical rehydration document' },
      ],
      artifacts: {
        design: 'docs/designs/rehydrate-foundation.md',
        plan: 'docs/plans/rehydrate-foundation.md',
      },
      blockers: ['awaiting T013 envelope'],
      nextAction: {
        verb: 'implement',
        reason: 'T013 composes stable + volatile into envelope',
      },
    };

    const result = VolatileSectionsSchema.safeParse(fullInput);

    expect(result.success).toBe(true);
  });

  it('RehydrationDoc_UnknownField_Rejects', () => {
    const inputWithUnknownField = {
      taskProgress: [{ id: 'T012', status: 'in-progress' }],
      decisions: [],
      artifacts: {},
      blockers: [],
      unexpectedField: 'should-be-rejected',
    };

    const result = VolatileSectionsSchema.safeParse(inputWithUnknownField);

    expect(result.success).toBe(false);
  });
});
