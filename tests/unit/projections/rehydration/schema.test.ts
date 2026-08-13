import { describe, it, expect } from 'vitest';
import {
  HandoffEntrySchemaV1,
  HandoffEntrySchemaV2,
  PhasePlaybookSchema,
  RehydrationDocumentSchema,
  RehydrationDocumentSchemaV1,
  RehydrationDocumentSchemaV2,
  StableSectionsSchema,
  VolatileSectionsSchema,
  type RehydrationDocument,
} from '../../../../src/projections/rehydration/schema.js';
import {
  serializeRehydrationDocument,
  STABLE_KEYS,
  VOLATILE_KEYS,
} from '../../../../src/projections/rehydration/serialize.js';
import { WorkflowCheckpointData } from '../../../../src/events/schemas.js';

describe('rehydration document stable-sections schema (T011, DR-3)', () => {
  it('RehydrationDoc_MinimalStableSections_Parses', () => {
    // Updated for v:3 (T-01): stable sections contain only workflowState.
    // behavioralGuidance is dropped (vestigial in v:2, removed in v:3).
    const minimalInput = {
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
    // Updated for v:3 (T-01): phasePlaybook is now a required field (nullable).
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
      phasePlaybook: null,
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
  // Updated for v:3 (T-01): stable sections no longer include behavioralGuidance.
  const minimalStable = {
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
    phasePlaybook: null,
  };

  it('RehydrationDoc_VersionedSchema_RequiresV4', () => {
    // Updated for v:4 envelope bump (#1359 / PR4 T12). The main schema now
    // requires v: literal(4); legacy v:3 docs route through
    // RehydrationDocumentSchemaV3, v:2 docs through
    // RehydrationDocumentSchemaV2, and v:1 docs through
    // RehydrationDocumentSchemaV1.
    const validDoc = {
      v: 4,
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
      v: 4 as const,
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
  // Updated for v:3 (T-01): stable section no longer contains behavioralGuidance.
  const stable = {
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
    phasePlaybook: null,
  };

  it('DocumentSerialization_StableSectionsFirst_Always', () => {
    // Forward-declared doc: keys in canonical order.
    const forwardDoc: RehydrationDocument = {
      v: 4,
      projectionSequence: 7,
      workflowState: stable.workflowState,
      taskProgress: volatile.taskProgress,
      decisions: volatile.decisions,
      artifacts: volatile.artifacts,
      blockers: volatile.blockers,
      nextAction: volatile.nextAction,
      recentHandoffs: [],
      phasePlaybook: null,
    };

    // Reverse-declared doc: same field values, but object-literal key order
    // is deliberately inverted (volatile keys declared before stable keys, and
    // sibling keys flipped end-to-start).
    const reverseDoc = {
      phasePlaybook: null,
      recentHandoffs: [],
      nextAction: volatile.nextAction,
      blockers: volatile.blockers,
      artifacts: volatile.artifacts,
      decisions: volatile.decisions,
      taskProgress: volatile.taskProgress,
      workflowState: stable.workflowState,
      projectionSequence: 7,
      v: 4,
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
      v: 4,
      projectionSequence: 42,
      workflowState: stable.workflowState,
      taskProgress: volatile.taskProgress,
      decisions: volatile.decisions,
      artifacts: volatile.artifacts,
      blockers: volatile.blockers,
      nextAction: volatile.nextAction,
      recentHandoffs: [],
      phasePlaybook: null,
    };

    // Same values, intentionally reversed JS key-declaration order.
    const docB = {
      phasePlaybook: null,
      recentHandoffs: [],
      nextAction: volatile.nextAction,
      blockers: volatile.blockers,
      artifacts: volatile.artifacts,
      decisions: volatile.decisions,
      taskProgress: volatile.taskProgress,
      workflowState: stable.workflowState,
      projectionSequence: 42,
      v: 4,
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

describe('RehydrationDocumentSchema version routing (T1, #1246 + T-01)', () => {
  const minimalStableV2 = {
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

  it('RehydrationDocumentSchema_V3Literal_RejectsV1AndV2Documents', () => {
    // Updated for v:3 envelope bump (T-01). The main schema now requires
    // v: literal(3); v:2 docs route through RehydrationDocumentSchemaV2 and
    // v:1 docs route through RehydrationDocumentSchemaV1.
    const v2Doc = {
      v: 2,
      projectionSequence: 0,
      ...minimalStableV2,
      ...minimalVolatileV2,
    };

    // Main schema (v:3) rejects v:2 docs.
    expect(RehydrationDocumentSchema.safeParse(v2Doc).success).toBe(false);

    // RehydrationDocumentSchemaV2 (renamed from the previous RehydrationDocumentSchema)
    // accepts v:2 for the read-back/migration path that T-03 will consume.
    expect(RehydrationDocumentSchemaV2.safeParse(v2Doc).success).toBe(true);

    // Main schema rejects v:1 docs — the read-side migration path
    // (loadRehydrationDocument) routes through RehydrationDocumentSchemaV1.
    const v1Doc = {
      v: 1,
      projectionSequence: 0,
      ...minimalStableV2,
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

// ─── T-01: PhasePlaybookSchema and v:3 envelope ─────────────────────────────

describe('PhasePlaybookSchema (T-01, rehydration-machinery-refactor)', () => {
  const minimalPlaybook = {
    skill: 'delegate',
    skillRef: '@skills/delegate/SKILL.md',
    tools: [{ tool: 'exarchos_event', action: 'append', purpose: 'Emit task.assigned on dispatch' }],
    events: [{ type: 'task.assigned', when: 'On dispatch of each task', fields: ['taskId', 'title', 'worktree'] }],
    transitionCriteria: 'All tasks complete → review',
    guardPrerequisites: "tasks[].status = 'complete' for every task",
    validationScripts: ['post_delegation_check'],
    humanCheckpoint: false,
    compactGuidance: 'Dispatch implementation tasks.',
  };

  it('PhasePlaybookSchema_MinimalPlaybook_Parses', () => {
    const result = PhasePlaybookSchema.safeParse(minimalPlaybook);
    expect(result.success).toBe(true);
  });

  it('PhasePlaybookSchema_WithAutoEmittedEvents_Parses', () => {
    const withAuto = {
      ...minimalPlaybook,
      autoEmittedEvents: [
        {
          type: 'task.completed',
          when: 'After task_complete orchestrate action succeeds',
          source: 'auto',
          emittedBy: 'exarchos_orchestrate task_complete',
        },
      ],
    };
    const result = PhasePlaybookSchema.safeParse(withAuto);
    expect(result.success).toBe(true);
  });

  it('PhasePlaybookSchema_NullValue_Parses', () => {
    // phasePlaybook is nullable — null is the degraded/terminal-phase value
    const result = PhasePlaybookSchema.safeParse(null);
    expect(result.success).toBe(true);
  });
});

describe('RehydrationDocumentSchema v:3 envelope (T-01)', () => {
  const minimalWorkflowState = {
    featureId: 'rehydration-machinery-refactor',
    phase: 'delegate',
    workflowType: 'refactor',
  };

  const minimalVolatileV3 = {
    taskProgress: [],
    decisions: [],
    artifacts: {},
    blockers: [],
    recentHandoffs: [],
    phasePlaybook: null,
  };

  it('RehydrationDocumentSchema_V3NullPlaybook_Parses', () => {
    // Minimum valid v:3 doc with phasePlaybook: null
    const v3Doc = {
      v: 4,
      projectionSequence: 0,
      workflowState: minimalWorkflowState,
      ...minimalVolatileV3,
    };

    const result = RehydrationDocumentSchema.safeParse(v3Doc);
    expect(result.success).toBe(true);
  });

  it('RehydrationDocumentSchema_V3FullPlaybook_Parses', () => {
    // v:3 doc with a fully populated phasePlaybook
    const v3Doc = {
      v: 4,
      projectionSequence: 5,
      workflowState: minimalWorkflowState,
      taskProgress: [],
      decisions: [],
      artifacts: {},
      blockers: [],
      recentHandoffs: [],
      phasePlaybook: {
        skill: 'delegate',
        skillRef: '@skills/delegate/SKILL.md',
        tools: [{ tool: 'exarchos_event', action: 'append', purpose: 'Emit task.assigned on dispatch' }],
        events: [{ type: 'task.assigned', when: 'On dispatch of each task', fields: ['taskId', 'title', 'worktree'] }],
        autoEmittedEvents: [
          {
            type: 'task.completed',
            when: 'After task_complete orchestrate action succeeds',
            source: 'auto',
            emittedBy: 'exarchos_orchestrate task_complete',
          },
        ],
        transitionCriteria: 'All tasks complete → review',
        guardPrerequisites: "tasks[].status = 'complete' for every task",
        validationScripts: ['post_delegation_check'],
        humanCheckpoint: false,
        compactGuidance: 'Dispatch implementation tasks.',
      },
    };

    const result = RehydrationDocumentSchema.safeParse(v3Doc);
    expect(result.success).toBe(true);
  });

  it('RehydrationDocumentSchema_V2Doc_Fails', () => {
    // v:2 docs must NOT parse against the new RehydrationDocumentSchema (v:3 only)
    // They route through RehydrationDocumentSchemaV2 instead (T-03).
    const v2Doc = {
      v: 2,
      projectionSequence: 0,
      behavioralGuidance: {
        skill: 'delegate',
        skillRef: '@skills/delegate/SKILL.md',
      },
      workflowState: minimalWorkflowState,
      taskProgress: [],
      decisions: [],
      artifacts: {},
      blockers: [],
      recentHandoffs: [],
    };

    // New schema requires v:3 — rejects v:2
    const newSchemaResult = RehydrationDocumentSchema.safeParse(v2Doc);
    expect(newSchemaResult.success).toBe(false);

    // RehydrationDocumentSchemaV2 (the renamed old schema) accepts v:2
    const v2SchemaResult = RehydrationDocumentSchemaV2.safeParse(v2Doc);
    expect(v2SchemaResult.success).toBe(true);
  });
});

describe('VolatileSectionsSchema handoff fields (T1, #1240 + #1246)', () => {
  // Updated for v:3 (T-01): phasePlaybook is now a required (nullable) field.
  const baseVolatile = {
    taskProgress: [],
    decisions: [],
    artifacts: {},
    blockers: [],
    phasePlaybook: null,
  };

  it('VolatileSectionsSchema_HandoffFields_StrictBoundary', () => {
    // latestHandoff is optional, recentHandoffs defaults to [].
    // phasePlaybook: null is required for v:3 volatile sections.
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
    // surviving into a v:3 envelope.
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
