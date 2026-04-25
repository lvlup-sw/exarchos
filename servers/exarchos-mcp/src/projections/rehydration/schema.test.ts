import { describe, it, expect } from 'vitest';
import {
  RehydrationDocumentSchema,
  StableSectionsSchema,
  VolatileSectionsSchema,
  type RehydrationDocument,
} from './schema.js';
import {
  serializeRehydrationDocument,
  STABLE_KEYS,
  VOLATILE_KEYS,
} from './serialize.js';

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

describe('rehydration document serializer — stable-before-volatile order (T050, DR-14)', () => {
  const stable = {
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

  const volatile = {
    taskProgress: [{ id: 'T050', status: 'in-progress' }],
    decisions: [{ id: 'DR-14', summary: 'cache-aware ordering' }],
    artifacts: { plan: 'docs/plans/2026-04-23-rehydrate-foundation.md' },
    blockers: ['awaiting T051'],
    nextAction: { verb: 'implement', reason: 'T050 serializer' },
  };

  it('DocumentSerialization_StableSectionsFirst_Always', () => {
    // Forward-declared doc: keys in canonical order.
    const forwardDoc: RehydrationDocument = {
      v: 1,
      projectionSequence: 7,
      behavioralGuidance: stable.behavioralGuidance,
      workflowState: stable.workflowState,
      taskProgress: volatile.taskProgress,
      decisions: volatile.decisions,
      artifacts: volatile.artifacts,
      blockers: volatile.blockers,
      nextAction: volatile.nextAction,
    };

    // Reverse-declared doc: same field values, but object-literal key order
    // is deliberately inverted (volatile keys declared before stable keys, and
    // sibling keys flipped end-to-start).
    const reverseDoc = {
      nextAction: volatile.nextAction,
      blockers: volatile.blockers,
      artifacts: volatile.artifacts,
      decisions: volatile.decisions,
      taskProgress: volatile.taskProgress,
      workflowState: stable.workflowState,
      behavioralGuidance: stable.behavioralGuidance,
      projectionSequence: 7,
      v: 1,
    } as RehydrationDocument;

    const forwardJson = serializeRehydrationDocument(forwardDoc);
    const reverseJson = serializeRehydrationDocument(reverseDoc);

    // Expected canonical key order at top level.
    const expectedKeyOrder = ['v', 'projectionSequence', ...STABLE_KEYS, ...VOLATILE_KEYS];

    // Both variants must surface the canonical key order.
    for (const json of [forwardJson, reverseJson]) {
      const parsed = JSON.parse(json) as Record<string, unknown>;
      expect(Object.keys(parsed)).toEqual(expectedKeyOrder);
    }

    // STABLE_KEYS must appear before any VOLATILE_KEYS byte-position in the
    // serialized string — i.e., the stable prefix is contiguous at the head.
    const stableLastKey = STABLE_KEYS[STABLE_KEYS.length - 1];
    const volatileFirstKey = VOLATILE_KEYS[0];
    const stableLastIdx = forwardJson.indexOf(`"${stableLastKey}"`);
    const volatileFirstIdx = forwardJson.indexOf(`"${volatileFirstKey}"`);
    expect(stableLastIdx).toBeGreaterThan(-1);
    expect(volatileFirstIdx).toBeGreaterThan(stableLastIdx);

    // Prefix up through the end of the last stable section must be
    // byte-identical across both variants (prompt-cache guarantee).
    const prefixEnd = forwardJson.indexOf(`,"${volatileFirstKey}"`);
    expect(prefixEnd).toBeGreaterThan(0);
    expect(reverseJson.slice(0, prefixEnd)).toBe(forwardJson.slice(0, prefixEnd));
  });

  it('DocumentSerialization_ReorderedInput_ProducesIdenticalBytes', () => {
    const docA: RehydrationDocument = {
      v: 1,
      projectionSequence: 42,
      behavioralGuidance: stable.behavioralGuidance,
      workflowState: stable.workflowState,
      taskProgress: volatile.taskProgress,
      decisions: volatile.decisions,
      artifacts: volatile.artifacts,
      blockers: volatile.blockers,
      nextAction: volatile.nextAction,
    };

    // Same values, intentionally reversed JS key-declaration order.
    const docB = {
      nextAction: volatile.nextAction,
      blockers: volatile.blockers,
      artifacts: volatile.artifacts,
      decisions: volatile.decisions,
      taskProgress: volatile.taskProgress,
      workflowState: stable.workflowState,
      behavioralGuidance: stable.behavioralGuidance,
      projectionSequence: 42,
      v: 1,
    } as RehydrationDocument;

    expect(serializeRehydrationDocument(docA)).toBe(serializeRehydrationDocument(docB));
  });
});
