import { describe, it, expect } from 'vitest';
import {
  HandoffEntrySchemaV1,
  HandoffEntrySchemaV2,
  RehydrationDocumentSchema,
  RehydrationDocumentSchemaV1,
  StableSectionsSchema,
  VolatileSectionsSchema,
  type RehydrationDocument,
} from './schema.js';
import {
  serializeRehydrationDocument,
  STABLE_KEYS,
  VOLATILE_KEYS,
} from './serialize.js';
import { WorkflowCheckpointData } from '../../event-store/schemas.js';

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

  it('RehydrationDoc_VersionedSchema_RequiresV2', () => {
    // Updated for v:2 envelope bump (#1246). The main schema now requires
    // v: literal(2); legacy v:1 docs route through the read-back path.
    const validDoc = {
      v: 2,
      projectionSequence: 0,
      ...minimalStable,
      ...minimalVolatile,
    };

    const validResult = RehydrationDocumentSchema.safeParse(validDoc);
    expect(validResult.success).toBe(true);

    const wrongVersionDoc = {
      ...validDoc,
      v: 1,
    };
    const wrongVersionResult = RehydrationDocumentSchema.safeParse(wrongVersionDoc);
    expect(wrongVersionResult.success).toBe(false);

    const { v: _omit, ...missingVersionDoc } = validDoc;
    const missingVersionResult = RehydrationDocumentSchema.safeParse(missingVersionDoc);
    expect(missingVersionResult.success).toBe(false);
  });

  it('RehydrationDoc_ProjectionSequence_RequiresNonNegativeInt', () => {
    const baseDoc = {
      v: 2 as const,
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
      v: 2,
      projectionSequence: 7,
      behavioralGuidance: stable.behavioralGuidance,
      workflowState: stable.workflowState,
      taskProgress: volatile.taskProgress,
      decisions: volatile.decisions,
      artifacts: volatile.artifacts,
      blockers: volatile.blockers,
      nextAction: volatile.nextAction,
      recentHandoffs: [],
    };

    // Reverse-declared doc: same field values, but object-literal key order
    // is deliberately inverted (volatile keys declared before stable keys, and
    // sibling keys flipped end-to-start).
    const reverseDoc = {
      recentHandoffs: [],
      nextAction: volatile.nextAction,
      blockers: volatile.blockers,
      artifacts: volatile.artifacts,
      decisions: volatile.decisions,
      taskProgress: volatile.taskProgress,
      workflowState: stable.workflowState,
      behavioralGuidance: stable.behavioralGuidance,
      projectionSequence: 7,
      v: 2,
    } as RehydrationDocument;

    const forwardJson = serializeRehydrationDocument(forwardDoc);
    const reverseJson = serializeRehydrationDocument(reverseDoc);

    // Canonical key order at top level. Optional keys whose value is
    // undefined (e.g. `latestHandoff` when no handoff has landed yet) are
    // omitted by the serializer — preserving the optional-field contract —
    // so we filter the expectation to keys actually populated on the doc.
    const populatedKey = (key: string): boolean =>
      Object.prototype.hasOwnProperty.call(forwardDoc, key) &&
      (forwardDoc as Record<string, unknown>)[key] !== undefined;
    const expectedKeyOrder = ['v', 'projectionSequence', ...STABLE_KEYS, ...VOLATILE_KEYS].filter(
      populatedKey,
    );

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
      v: 2,
      projectionSequence: 42,
      behavioralGuidance: stable.behavioralGuidance,
      workflowState: stable.workflowState,
      taskProgress: volatile.taskProgress,
      decisions: volatile.decisions,
      artifacts: volatile.artifacts,
      blockers: volatile.blockers,
      nextAction: volatile.nextAction,
      recentHandoffs: [],
    };

    // Same values, intentionally reversed JS key-declaration order.
    const docB = {
      recentHandoffs: [],
      nextAction: volatile.nextAction,
      blockers: volatile.blockers,
      artifacts: volatile.artifacts,
      decisions: volatile.decisions,
      taskProgress: volatile.taskProgress,
      workflowState: stable.workflowState,
      behavioralGuidance: stable.behavioralGuidance,
      projectionSequence: 42,
      v: 2,
    } as RehydrationDocument;

    expect(serializeRehydrationDocument(docA)).toBe(serializeRehydrationDocument(docB));
  });
});

// ─── T1: v:2 envelope schema additions (#1240 + #1246) ──────────────────────

describe('WorkflowCheckpointData handoff field (T1, #1240)', () => {
  it('WorkflowCheckpointData_HandoffField_AcceptsValidPayload', () => {
    // Full handoff with all three optional fields populated parses cleanly.
    const validInput = {
      counter: 5,
      phase: 'delegate',
      featureId: 'rehydrate-foundation',
      handoff: {
        context: 'Phase exit: P4 shepherd handoff',
        nextSteps: [
          'Rebase --onto origin/main <boundary>',
          'Run npm run test:process to validate state-dir fix',
        ],
        suggestions: ['Cross-reference SHAs in CodeRabbit threads'],
      },
    };

    const result = WorkflowCheckpointData.safeParse(validInput);
    expect(result.success).toBe(true);

    // Per-field byte caps enforced (DIM-7): context >2048 chars rejected.
    const oversizedContext = {
      counter: 5,
      phase: 'delegate',
      featureId: 'rehydrate-foundation',
      handoff: {
        context: 'x'.repeat(2049),
      },
    };
    expect(WorkflowCheckpointData.safeParse(oversizedContext).success).toBe(false);

    // Bounded list size: nextSteps array of 11 entries rejected.
    const oversizedNextSteps = {
      counter: 5,
      phase: 'delegate',
      featureId: 'rehydrate-foundation',
      handoff: {
        nextSteps: Array.from({ length: 11 }, (_, i) => `step-${i}`),
      },
    };
    expect(WorkflowCheckpointData.safeParse(oversizedNextSteps).success).toBe(false);
  });

  it('WorkflowCheckpointData_NoHandoff_BackwardCompatible', () => {
    // Historical events emitted before #1240 had no handoff field; they MUST
    // continue to parse cleanly under z.optional() so replay over old streams
    // is unaffected by the schema additions.
    const legacyEvent = {
      counter: 5,
      phase: 'delegate',
      featureId: 'rehydrate-foundation',
    };

    const result = WorkflowCheckpointData.safeParse(legacyEvent);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.handoff).toBeUndefined();
    }
  });
});

describe('HandoffEntrySchemaV2 (T1, #1246)', () => {
  it('HandoffEntrySchemaV2_RequiresSequence_RejectsId', () => {
    // v:2 contract: eventRef.sequence is the primary key; eventRef.id is gone.
    const validV2Entry = {
      context: 'phase exit',
      eventRef: {
        sequence: 42,
        timestamp: '2026-05-08T00:00:00.000Z',
      },
    };
    expect(HandoffEntrySchemaV2.safeParse(validV2Entry).success).toBe(true);

    // Missing sequence is rejected (was advisory in v:1, primary in v:2).
    const missingSequence = {
      eventRef: {
        timestamp: '2026-05-08T00:00:00.000Z',
      },
    };
    expect(HandoffEntrySchemaV2.safeParse(missingSequence).success).toBe(false);

    // Negative sequence is rejected (nonnegative integer required).
    const negativeSequence = {
      eventRef: {
        sequence: -1,
        timestamp: '2026-05-08T00:00:00.000Z',
      },
    };
    expect(HandoffEntrySchemaV2.safeParse(negativeSequence).success).toBe(false);

    // Strict mode at the eventRef level rejects payloads carrying `id` —
    // prevents v:1 entries silently leaking into v:2 output.
    const strayIdInEventRef = {
      eventRef: {
        sequence: 42,
        timestamp: '2026-05-08T00:00:00.000Z',
        id: 'evt_abc123',
      },
    };
    expect(HandoffEntrySchemaV2.safeParse(strayIdInEventRef).success).toBe(false);
  });
});

describe('HandoffEntrySchemaV1 (T1, #1246 read-back)', () => {
  it('HandoffEntrySchemaV1_AllowsId_SequenceOptional', () => {
    // v:1 advisory contract (pre-#1230): eventRef.id is the primary key,
    // eventRef.sequence is advisory and may be absent on legacy entries.
    const idOnlyEntry = {
      context: 'legacy phase exit',
      eventRef: {
        id: 'evt_legacy_001',
        timestamp: '2026-05-01T00:00:00.000Z',
      },
    };
    expect(HandoffEntrySchemaV1.safeParse(idOnlyEntry).success).toBe(true);

    // v:1 with both id and sequence present (post-#1230 era, still v:1 doc)
    // is also accepted — sequence is advisory but allowed when populated.
    const idAndSequence = {
      eventRef: {
        id: 'evt_legacy_002',
        timestamp: '2026-05-04T00:00:00.000Z',
        sequence: 17,
      },
    };
    expect(HandoffEntrySchemaV1.safeParse(idAndSequence).success).toBe(true);

    // Missing id (the v:1 primary key) IS rejected by the v:1 schema.
    const missingId = {
      eventRef: {
        timestamp: '2026-05-04T00:00:00.000Z',
        sequence: 17,
      },
    };
    expect(HandoffEntrySchemaV1.safeParse(missingId).success).toBe(false);
  });
});

describe('RehydrationDocumentSchema v:2 envelope (T1, #1246)', () => {
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

  const minimalVolatileV2 = {
    taskProgress: [],
    decisions: [],
    artifacts: {},
    blockers: [],
    recentHandoffs: [],
  };

  it('RehydrationDocumentSchema_V2Literal_RejectsV1Documents', () => {
    // Main schema accepts v:2 docs.
    const v2Doc = {
      v: 2,
      projectionSequence: 0,
      ...minimalStable,
      ...minimalVolatileV2,
    };
    expect(RehydrationDocumentSchema.safeParse(v2Doc).success).toBe(true);

    // Main schema rejects v:1 docs — the read-side migration path
    // (loadRehydrationDocument) routes through RehydrationDocumentSchemaV1.
    const v1Doc = {
      v: 1,
      projectionSequence: 0,
      ...minimalStable,
      taskProgress: [],
      decisions: [],
      artifacts: {},
      blockers: [],
    };
    expect(RehydrationDocumentSchema.safeParse(v1Doc).success).toBe(false);

    // The companion RehydrationDocumentSchemaV1 export accepts v:1 for the
    // read-back/migration path that T3 will consume.
    expect(RehydrationDocumentSchemaV1.safeParse(v1Doc).success).toBe(true);
  });
});

describe('VolatileSectionsSchema handoff fields (T1, #1240 + #1246)', () => {
  const baseVolatile = {
    taskProgress: [],
    decisions: [],
    artifacts: {},
    blockers: [],
  };

  it('VolatileSectionsSchema_HandoffFields_StrictBoundary', () => {
    // latestHandoff is optional, recentHandoffs defaults to [].
    const minimal = { ...baseVolatile };
    const result = VolatileSectionsSchema.safeParse(minimal);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.latestHandoff).toBeUndefined();
      expect(result.data.recentHandoffs).toEqual([]);
    }

    // recentHandoffs accepts up to 3 v:2 entries.
    const threeEntries = Array.from({ length: 3 }, (_, i) => ({
      context: `entry ${i}`,
      eventRef: {
        sequence: i + 1,
        timestamp: '2026-05-08T00:00:00.000Z',
      },
    }));
    expect(
      VolatileSectionsSchema.safeParse({
        ...baseVolatile,
        recentHandoffs: threeEntries,
      }).success,
    ).toBe(true);

    // recentHandoffs rejects 4 entries (max(3) bound enforced).
    const fourEntries = Array.from({ length: 4 }, (_, i) => ({
      context: `entry ${i}`,
      eventRef: {
        sequence: i + 1,
        timestamp: '2026-05-08T00:00:00.000Z',
      },
    }));
    expect(
      VolatileSectionsSchema.safeParse({
        ...baseVolatile,
        recentHandoffs: fourEntries,
      }).success,
    ).toBe(false);

    // Strict mode at the volatile-section boundary rejects unknown sibling keys —
    // prevents accidental v:1-shaped fields (e.g. an `eventRefId` typo) from
    // surviving into a v:2 envelope.
    expect(
      VolatileSectionsSchema.safeParse({
        ...baseVolatile,
        unknownSiblingKey: 'should-be-rejected',
      }).success,
    ).toBe(false);

    // latestHandoff that contains eventRef.id is rejected (HandoffEntrySchemaV2
    // strict mode propagates upward).
    expect(
      VolatileSectionsSchema.safeParse({
        ...baseVolatile,
        latestHandoff: {
          eventRef: {
            sequence: 1,
            timestamp: '2026-05-08T00:00:00.000Z',
            id: 'evt_should_be_rejected',
          },
        },
      }).success,
    ).toBe(false);
  });
});
