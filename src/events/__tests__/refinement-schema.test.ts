import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
  RefinementSuggestedDataSchema,
  EventTypes,
  WorkflowEventBase,
} from '../schemas.js';

// ─── Valid fixture ──────────────────────────────────────────────────────────

const validRefinementData = {
  skill: 'delegation',
  signalConfidence: 'high' as const,
  trigger: 'regression' as const,
  evidence: {
    gatePassRate: 0.85,
    evalScore: 0.72,
    topFailureCategories: [
      { category: 'type-errors', count: 5 },
      { category: 'test-failures', count: 3 },
    ],
    selfCorrectionRate: 0.6,
    recentRegressions: 2,
  },
  suggestedAction: 'Review delegation skill prompt for type-safety guidance',
  affectedPromptPaths: [
    'skills/delegation/SKILL.md',
    'skills/delegation/references/dispatch.md',
  ],
};

// ─── Schema Parsing Tests ───────────────────────────────────────────────────

describe('RefinementSuggestedDataSchema', () => {
  it('RefinementSuggestedSchema_ValidData_ParsesSuccessfully', () => {
    const result = RefinementSuggestedDataSchema.safeParse(validRefinementData);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.skill).toBe('delegation');
      expect(result.data.signalConfidence).toBe('high');
      expect(result.data.trigger).toBe('regression');
      expect(result.data.evidence.gatePassRate).toBe(0.85);
      expect(result.data.evidence.evalScore).toBe(0.72);
      expect(result.data.evidence.topFailureCategories).toHaveLength(2);
      expect(result.data.evidence.selfCorrectionRate).toBe(0.6);
      expect(result.data.evidence.recentRegressions).toBe(2);
      expect(result.data.suggestedAction).toBe(
        'Review delegation skill prompt for type-safety guidance',
      );
      expect(result.data.affectedPromptPaths).toHaveLength(2);
    }
  });

  it('RefinementSuggestedSchema_MissingSkill_ThrowsValidationError', () => {
    const { skill: _, ...withoutSkill } = validRefinementData;
    const result = RefinementSuggestedDataSchema.safeParse(withoutSkill);
    expect(result.success).toBe(false);
  });

  it('RefinementSuggestedSchema_EmptySkill_ThrowsValidationError', () => {
    const result = RefinementSuggestedDataSchema.safeParse({
      ...validRefinementData,
      skill: '',
    });
    expect(result.success).toBe(false);
  });

  it('RefinementSuggestedSchema_InvalidTrigger_ThrowsValidationError', () => {
    const result = RefinementSuggestedDataSchema.safeParse({
      ...validRefinementData,
      trigger: 'unknown-trigger',
    });
    expect(result.success).toBe(false);
  });

  it('RefinementSuggestedSchema_LowConfidence_ThrowsValidationError', () => {
    const result = RefinementSuggestedDataSchema.safeParse({
      ...validRefinementData,
      signalConfidence: 'low',
    });
    expect(result.success).toBe(false);
  });

  it('RefinementSuggestedSchema_EmptySuggestedAction_ThrowsValidationError', () => {
    const result = RefinementSuggestedDataSchema.safeParse({
      ...validRefinementData,
      suggestedAction: '',
    });
    expect(result.success).toBe(false);
  });

  it('RefinementSuggestedSchema_EmptyAffectedPaths_ParsesSuccessfully', () => {
    const result = RefinementSuggestedDataSchema.safeParse({
      ...validRefinementData,
      affectedPromptPaths: [],
    });
    expect(result.success).toBe(true);
  });

  it('RefinementSuggestedSchema_AllTriggerValues_ParseSuccessfully', () => {
    for (const trigger of ['regression', 'trend-degradation', 'attribution-outlier']) {
      const result = RefinementSuggestedDataSchema.safeParse({
        ...validRefinementData,
        trigger,
      });
      expect(result.success).toBe(true);
    }
  });
});

// ─── EventType Union Tests ──────────────────────────────────────────────────

describe('EventTypes — quality.refinement.suggested', () => {
  it('EventTypes_IncludesQualityRefinementSuggested', () => {
    expect(EventTypes).toContain('quality.refinement.suggested');
  });

  it('WorkflowEventBase_QualityRefinementSuggestedType_Parses', () => {
    const event = WorkflowEventBase.safeParse({
      streamId: 'quality-stream',
      sequence: 1,
      type: 'quality.refinement.suggested',
      data: validRefinementData,
    });
    expect(event.success).toBe(true);
  });
});

// ─── Property-Based Tests ───────────────────────────────────────────────────

describe('RefinementSuggestedDataSchema — property-based', () => {
  it('should reject low confidence', () => {
    const result = RefinementSuggestedDataSchema.safeParse({
      ...validRefinementData,
      signalConfidence: 'low',
    });
    expect(result.success).toBe(false);
  });

  it('should accept high and medium confidence', () => {
    fc.assert(
      fc.property(fc.constantFrom('high', 'medium'), (confidence) => {
        const result = RefinementSuggestedDataSchema.safeParse({
          ...validRefinementData,
          signalConfidence: confidence,
        });
        expect(result.success).toBe(true);
      }),
    );
  });

  it('should reject arbitrary invalid confidence strings', () => {
    fc.assert(
      fc.property(
        fc.string().filter((s) => s !== 'high' && s !== 'medium'),
        (confidence) => {
          const result = RefinementSuggestedDataSchema.safeParse({
            ...validRefinementData,
            signalConfidence: confidence,
          });
          expect(result.success).toBe(false);
        },
      ),
    );
  });
});
