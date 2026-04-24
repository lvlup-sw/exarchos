import { describe, it, expect } from 'vitest';
import {
  RehydrationDocumentSchema,
  StableSectionsSchema,
  VolatileSectionsSchema,
} from './schema.js';

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

describe('rehydration document top-level schema (T013, DR-3)', () => {
  const minimalStable = {
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

  const minimalVolatile = {
    taskProgress: [],
    decisions: [],
    artifacts: {},
    blockers: [],
  };

  it('RehydrationDoc_VersionedSchema_RequiresV1', () => {
    const validDoc = {
      v: 1,
      projectionSequence: 0,
      ...minimalStable,
      ...minimalVolatile,
    };

    const validResult = RehydrationDocumentSchema.safeParse(validDoc);
    expect(validResult.success).toBe(true);

    const wrongVersionDoc = {
      ...validDoc,
      v: 2,
    };
    const wrongVersionResult = RehydrationDocumentSchema.safeParse(wrongVersionDoc);
    expect(wrongVersionResult.success).toBe(false);

    const { v: _omit, ...missingVersionDoc } = validDoc;
    const missingVersionResult = RehydrationDocumentSchema.safeParse(missingVersionDoc);
    expect(missingVersionResult.success).toBe(false);
  });

  it('RehydrationDoc_ProjectionSequence_RequiresNonNegativeInt', () => {
    const baseDoc = {
      v: 1 as const,
      ...minimalStable,
      ...minimalVolatile,
    };

    expect(
      RehydrationDocumentSchema.safeParse({ ...baseDoc, projectionSequence: 0 }).success,
    ).toBe(true);
    expect(
      RehydrationDocumentSchema.safeParse({ ...baseDoc, projectionSequence: 42 }).success,
    ).toBe(true);

    expect(
      RehydrationDocumentSchema.safeParse({ ...baseDoc, projectionSequence: -1 }).success,
    ).toBe(false);
    expect(
      RehydrationDocumentSchema.safeParse({ ...baseDoc, projectionSequence: 1.5 }).success,
    ).toBe(false);
    expect(
      RehydrationDocumentSchema.safeParse({ ...baseDoc, projectionSequence: '1' }).success,
    ).toBe(false);
  });
});
