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
  /** The stable sections hold only `workflowState`. */
  it('RehydrationDoc_MinimalStableSections_Parses', () => {
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
  /** `phasePlaybook` is required and nullable, so the input sets it to `null`. */
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

  /** The main schema requires the literal `v: 4`. The `V1`, `V2` and `V3` schemas read older documents. */
  it('RehydrationDoc_VersionedSchema_RequiresV4', () => {
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

  /**
   * `reverseDoc` holds the same values as `forwardDoc`, with the keys declared in reverse order.
   * The serializer omits an optional key with an `undefined` value, so the expected order holds only the populated keys.
   * The bytes up to the first volatile key must be the same for both documents, because the prompt cache needs a stable prefix.
   */
  it('DocumentSerialization_StableSectionsFirst_Always', () => {
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

    const populatedKey = (key: string): boolean =>
      Object.prototype.hasOwnProperty.call(forwardDoc, key) &&
      (forwardDoc as Record<string, unknown>)[key] !== undefined;
    const expectedKeyOrder = ['v', 'projectionSequence', ...STABLE_KEYS, ...VOLATILE_KEYS].filter(
      populatedKey,
    );

    for (const json of [forwardJson, reverseJson]) {
      const parsed = JSON.parse(json) as Record<string, unknown>;
      expect(Object.keys(parsed)).toEqual(expectedKeyOrder);
    }

    const stableLastKey = STABLE_KEYS[STABLE_KEYS.length - 1];
    const volatileFirstKey = VOLATILE_KEYS[0];
    const stableLastIdx = forwardJson.indexOf(`"${stableLastKey}"`);
    const volatileFirstIdx = forwardJson.indexOf(`"${volatileFirstKey}"`);
    expect(stableLastIdx).toBeGreaterThan(-1);
    expect(volatileFirstIdx).toBeGreaterThan(stableLastIdx);

    const prefixEnd = forwardJson.indexOf(`,"${volatileFirstKey}"`);
    expect(prefixEnd).toBeGreaterThan(0);
    expect(reverseJson.slice(0, prefixEnd)).toBe(forwardJson.slice(0, prefixEnd));
  });

  /** `docB` holds the same values as `docA`, with the keys declared in reverse order. */
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

describe('WorkflowCheckpointData handoff field (T1, #1240)', () => {
  /** The test also rejects a `context` of 2049 characters and a `nextSteps` list of 11 entries, which exceed the caps. */
  it('WorkflowCheckpointData_HandoffField_AcceptsValidPayload', () => {
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

    const oversizedContext = {
      counter: 5,
      phase: 'delegate',
      featureId: 'rehydrate-foundation',
      handoff: {
        context: 'x'.repeat(2049),
      },
    };
    expect(WorkflowCheckpointData.safeParse(oversizedContext).success).toBe(false);

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

  /** Older checkpoint events have no `handoff` field. They must still parse, so a replay of an old stream does not fail. */
  it('WorkflowCheckpointData_NoHandoff_BackwardCompatible', () => {
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
  /**
   * `eventRef.sequence` is the key and must be a non-negative integer.
   * The strict `eventRef` rejects an `id`, so a v:1 entry cannot enter a later envelope.
   */
  it('HandoffEntrySchemaV2_RequiresSequence_RejectsId', () => {
    const validV2Entry = {
      context: 'phase exit',
      eventRef: {
        sequence: 42,
        timestamp: '2026-05-08T00:00:00.000Z',
      },
    };
    expect(HandoffEntrySchemaV2.safeParse(validV2Entry).success).toBe(true);

    const missingSequence = {
      eventRef: {
        timestamp: '2026-05-08T00:00:00.000Z',
      },
    };
    expect(HandoffEntrySchemaV2.safeParse(missingSequence).success).toBe(false);

    const negativeSequence = {
      eventRef: {
        sequence: -1,
        timestamp: '2026-05-08T00:00:00.000Z',
      },
    };
    expect(HandoffEntrySchemaV2.safeParse(negativeSequence).success).toBe(false);

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
  /** In a v:1 entry, `eventRef.id` is the required key and `eventRef.sequence` is optional. */
  it('HandoffEntrySchemaV1_AllowsId_SequenceOptional', () => {
    const idOnlyEntry = {
      context: 'legacy phase exit',
      eventRef: {
        id: 'evt_legacy_001',
        timestamp: '2026-05-01T00:00:00.000Z',
      },
    };
    expect(HandoffEntrySchemaV1.safeParse(idOnlyEntry).success).toBe(true);

    const idAndSequence = {
      eventRef: {
        id: 'evt_legacy_002',
        timestamp: '2026-05-04T00:00:00.000Z',
        sequence: 17,
      },
    };
    expect(HandoffEntrySchemaV1.safeParse(idAndSequence).success).toBe(true);

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

  /** The main schema rejects v:1 and v:2 documents. The `V1` and `V2` schemas accept them for the upgrade path. */
  it('RehydrationDocumentSchema_V3Literal_RejectsV1AndV2Documents', () => {
    const v2Doc = {
      v: 2,
      projectionSequence: 0,
      ...minimalStableV2,
      ...minimalVolatileV2,
    };

    expect(RehydrationDocumentSchema.safeParse(v2Doc).success).toBe(false);

    expect(RehydrationDocumentSchemaV2.safeParse(v2Doc).success).toBe(true);

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

    expect(RehydrationDocumentSchemaV1.safeParse(v1Doc).success).toBe(true);
  });
});

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

  /** `null` is the value for a phase with no playbook. */
  it('PhasePlaybookSchema_NullValue_Parses', () => {
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

  /** The main schema rejects a v:2 document, and `RehydrationDocumentSchemaV2` accepts it. */
  it('RehydrationDocumentSchema_V2Doc_Fails', () => {
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

    const newSchemaResult = RehydrationDocumentSchema.safeParse(v2Doc);
    expect(newSchemaResult.success).toBe(false);

    const v2SchemaResult = RehydrationDocumentSchemaV2.safeParse(v2Doc);
    expect(v2SchemaResult.success).toBe(true);
  });
});

describe('VolatileSectionsSchema handoff fields (T1, #1240 + #1246)', () => {
  const baseVolatile = {
    taskProgress: [],
    decisions: [],
    artifacts: {},
    blockers: [],
    phasePlaybook: null,
  };

  /**
   * `latestHandoff` is optional. `recentHandoffs` defaults to `[]` and holds at most 3 entries.
   * The strict object rejects an unknown sibling key.
   * A `latestHandoff` with `eventRef.id` fails, because the strict `HandoffEntrySchemaV2` applies inside it.
   */
  it('VolatileSectionsSchema_HandoffFields_StrictBoundary', () => {
    const minimal = { ...baseVolatile };
    const result = VolatileSectionsSchema.safeParse(minimal);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.latestHandoff).toBeUndefined();
      expect(result.data.recentHandoffs).toEqual([]);
    }

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

    expect(
      VolatileSectionsSchema.safeParse({
        ...baseVolatile,
        unknownSiblingKey: 'should-be-rejected',
      }).success,
    ).toBe(false);

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
