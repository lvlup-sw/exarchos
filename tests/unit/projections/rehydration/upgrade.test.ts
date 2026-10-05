/**
 * Tests for the read-side upgrades of rehydration documents, from v:1 to v:4.
 *
 * The v:1 to v:2 step makes `eventRef.sequence` required and drops `eventRef.id`. It fails open
 * for each entry: a v:1 handoff entry without a sequence raises `HandoffEntryUpgradeError`. The
 * document upgrade drops that entry and appends a degraded blocker.
 *
 * All fixtures are synthetic.
 */
import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import {
  upgradeHandoffEntryV1toV2,
  upgradeRehydrationDocumentV1toV2,
  upgradeRehydrationDocumentV2toV3,
  upgradeRehydrationDocumentV3toV4,
  upgradeRehydrationDocument,
  HandoffEntryUpgradeError,
} from '../../../../src/projections/rehydration/upgrade.js';
import {
  HandoffEntrySchemaV1,
  HandoffEntrySchemaV2,
  RehydrationDocumentSchema,
  RehydrationDocumentSchemaV1,
  RehydrationDocumentSchemaV2,
  RehydrationDocumentSchemaV3,
} from '../../../../src/projections/rehydration/schema.js';

const minimalStable = {
  behavioralGuidance: {
    skill: 'rehydrate-foundation',
    skillRef: 'skills/claude-code/rehydrate-foundation/SKILL.md',
  },
  workflowState: {
    featureId: 'checkpoint-handoff-bundle',
    phase: 'implementation',
    workflowType: 'feature',
  },
};

const baseVolatileV1 = {
  taskProgress: [{ id: 'T3', status: 'in-progress' }],
  decisions: [{ id: 'DR-18', summary: 'fail-open per entry' }],
  artifacts: { design: 'docs/designs/2026-05-08-checkpoint-handoff-bundle.md' },
  blockers: ['pre-existing blocker'],
};

describe('upgradeHandoffEntryV1toV2 (T3, #1246, DR-18)', () => {
  /** The inner `eventRef` of the v:2 entry schema is strict. If the upgrade keeps the `id`, the schema check fails. */
  it('upgradeHandoffEntryV1toV2_ValidEntry_DropsIdKeepsSequence', () => {
    const v1Entry = HandoffEntrySchemaV1.parse({
      context: 'handoff context',
      nextSteps: ['step 1', 'step 2'],
      suggestions: ['try X'],
      eventRef: {
        id: 'evt_legacy_id_to_drop',
        timestamp: '2026-05-08T00:00:00.000Z',
        sequence: 42,
      },
    });

    const v2Entry = upgradeHandoffEntryV1toV2(v1Entry);

    expect(HandoffEntrySchemaV2.safeParse(v2Entry).success).toBe(true);
    expect(v2Entry.eventRef).toEqual({
      sequence: 42,
      timestamp: '2026-05-08T00:00:00.000Z',
    });
    expect(Object.prototype.hasOwnProperty.call(v2Entry.eventRef, 'id')).toBe(false);
    expect(v2Entry.context).toBe('handoff context');
    expect(v2Entry.nextSteps).toEqual(['step 1', 'step 2']);
    expect(v2Entry.suggestions).toEqual(['try X']);
  });

  /** The entry holds an `id` and no `sequence`. The throw lets the document upgrade drop the entry. */
  it('upgradeHandoffEntryV1toV2_MissingSequence_ThrowsForFailOpen', () => {
    const v1Entry = HandoffEntrySchemaV1.parse({
      context: 'legacy context',
      eventRef: {
        id: 'evt_no_sequence',
        timestamp: '2026-05-08T00:00:00.000Z',
      },
    });

    expect(() => upgradeHandoffEntryV1toV2(v1Entry)).toThrow(HandoffEntryUpgradeError);
    expect(() => upgradeHandoffEntryV1toV2(v1Entry)).toThrow(/missing usable sequence/);
  });
});

describe('upgradeRehydrationDocumentV1toV2 (T3, #1246, DR-18)', () => {
  it('upgradeRehydrationDocumentV1toV2_FullDocument_ReturnsV2Envelope', () => {
    const v1Doc = RehydrationDocumentSchemaV1.parse({
      v: 1,
      projectionSequence: 17,
      ...minimalStable,
      ...baseVolatileV1,
      latestHandoff: {
        context: 'latest',
        eventRef: {
          id: 'evt_latest',
          timestamp: '2026-05-08T01:00:00.000Z',
          sequence: 99,
        },
      },
      recentHandoffs: [
        {
          context: 'recent-0',
          eventRef: {
            id: 'evt_r0',
            timestamp: '2026-05-08T00:30:00.000Z',
            sequence: 50,
          },
        },
        {
          context: 'recent-1',
          eventRef: {
            id: 'evt_r1',
            timestamp: '2026-05-08T00:15:00.000Z',
            sequence: 25,
          },
        },
      ],
    });

    const v2Doc = upgradeRehydrationDocumentV1toV2(v1Doc);

    expect(RehydrationDocumentSchemaV2.safeParse(v2Doc).success).toBe(true);
    expect(v2Doc.v).toBe(2);

    expect(v2Doc.projectionSequence).toBe(17);
    expect(v2Doc.behavioralGuidance).toEqual(minimalStable.behavioralGuidance);
    expect(v2Doc.workflowState).toEqual(minimalStable.workflowState);
    expect(v2Doc.taskProgress).toEqual(baseVolatileV1.taskProgress);
    expect(v2Doc.decisions).toEqual(baseVolatileV1.decisions);
    expect(v2Doc.artifacts).toEqual(baseVolatileV1.artifacts);
    expect(v2Doc.blockers).toEqual(baseVolatileV1.blockers);

    expect(v2Doc.latestHandoff?.eventRef).toEqual({
      sequence: 99,
      timestamp: '2026-05-08T01:00:00.000Z',
    });

    expect(v2Doc.recentHandoffs).toHaveLength(2);
    expect(v2Doc.recentHandoffs?.[0]?.eventRef).toEqual({
      sequence: 50,
      timestamp: '2026-05-08T00:30:00.000Z',
    });
    expect(v2Doc.recentHandoffs?.[1]?.eventRef).toEqual({
      sequence: 25,
      timestamp: '2026-05-08T00:15:00.000Z',
    });
  });

  /** The second of three entries has no `sequence`. The upgrade drops it and keeps the order of the other two. */
  it('upgradeRehydrationDocumentV1toV2_SkipsBadEntries_DegradedBlocker', () => {
    const v1Doc = RehydrationDocumentSchemaV1.parse({
      v: 1,
      projectionSequence: 5,
      ...minimalStable,
      ...baseVolatileV1,
      recentHandoffs: [
        {
          context: 'good',
          eventRef: {
            id: 'evt_good',
            timestamp: '2026-05-08T00:00:00.000Z',
            sequence: 10,
          },
        },
        {
          context: 'bad',
          eventRef: {
            id: 'evt_bad_no_seq',
            timestamp: '2026-05-08T00:00:00.000Z',
          },
        },
        {
          context: 'good-2',
          eventRef: {
            id: 'evt_good_2',
            timestamp: '2026-05-08T00:01:00.000Z',
            sequence: 11,
          },
        },
      ],
    });

    const v2Doc = upgradeRehydrationDocumentV1toV2(v1Doc);

    expect(v2Doc.recentHandoffs).toHaveLength(2);
    expect(v2Doc.recentHandoffs?.[0]?.context).toBe('good');
    expect(v2Doc.recentHandoffs?.[1]?.context).toBe('good-2');

    expect(v2Doc.blockers.length).toBe(baseVolatileV1.blockers.length + 1);
    const newBlocker = v2Doc.blockers[v2Doc.blockers.length - 1];
    expect(typeof newBlocker).toBe('object');
    expect(newBlocker).toMatchObject({
      source: 'rehydration.upgrade-v1-to-v2',
      reason: expect.stringMatching(/recentHandoffs/),
    });

    expect(RehydrationDocumentSchemaV2.safeParse(v2Doc).success).toBe(true);
  });

  /**
   * `latestHandoff` and the three `recentHandoffs` entries have no `sequence`. The upgrade does not
   * throw. It drops all four and appends one degraded blocker for each.
   */
  it('upgradeRehydrationDocumentV1toV2_AllEntriesBad_ReturnsEmptyHandoffs', () => {
    const v1Doc = RehydrationDocumentSchemaV1.parse({
      v: 1,
      projectionSequence: 1,
      ...minimalStable,
      ...baseVolatileV1,
      latestHandoff: {
        context: 'latest-bad',
        eventRef: {
          id: 'evt_latest_no_seq',
          timestamp: '2026-05-08T00:00:00.000Z',
        },
      },
      recentHandoffs: [
        {
          context: 'r0',
          eventRef: { id: 'evt_r0', timestamp: '2026-05-08T00:00:00.000Z' },
        },
        {
          context: 'r1',
          eventRef: { id: 'evt_r1', timestamp: '2026-05-08T00:01:00.000Z' },
        },
        {
          context: 'r2',
          eventRef: { id: 'evt_r2', timestamp: '2026-05-08T00:02:00.000Z' },
        },
      ],
    });

    let v2Doc!: ReturnType<typeof upgradeRehydrationDocumentV1toV2>;
    expect(() => {
      v2Doc = upgradeRehydrationDocumentV1toV2(v1Doc);
    }).not.toThrow();

    expect(v2Doc.recentHandoffs).toEqual([]);
    expect(v2Doc.latestHandoff).toBeUndefined();
    expect(v2Doc.blockers.length).toBe(baseVolatileV1.blockers.length + 4);
    expect(RehydrationDocumentSchemaV2.safeParse(v2Doc).success).toBe(true);
  });
});

/** A parsed v:2 document with `behavioralGuidance` and empty volatile sections. */
function makeMinimalV2Doc() {
  return RehydrationDocumentSchemaV2.parse({
    v: 2,
    projectionSequence: 10,
    behavioralGuidance: {
      skill: 'rehydrate-foundation',
      skillRef: 'skills/claude-code/rehydrate-foundation/SKILL.md',
    },
    workflowState: {
      featureId: 'test-feature',
      phase: 'implementation',
      workflowType: 'feature',
    },
    taskProgress: [],
    decisions: [],
    artifacts: {},
    blockers: [],
  });
}

describe('upgradeRehydrationDocumentV2toV3 (T-02, rehydration-machinery-refactor)', () => {
  /** `RehydrationDocumentSchema` is v:4, so the v:3 result validates against `RehydrationDocumentSchemaV3`. */
  it('upgradeRehydrationDocumentV2toV3_MinimalV2Doc_DropsBehavioralGuidanceAddsPhasePlaybookNull', () => {
    const v2Doc = makeMinimalV2Doc();

    const v3Doc = upgradeRehydrationDocumentV2toV3(v2Doc);

    expect(v3Doc.v).toBe(3);
    expect(Object.prototype.hasOwnProperty.call(v3Doc, 'behavioralGuidance')).toBe(false);
    expect(v3Doc.phasePlaybook).toBeNull();
    expect(RehydrationDocumentSchemaV3.safeParse(v3Doc).success).toBe(true);
  });

  it('upgradeRehydrationDocumentV2toV3_PreservesWorkflowStateProjectionSequenceAndVolatileFields', () => {
    const v2Base = RehydrationDocumentSchemaV2.parse({
      v: 2,
      projectionSequence: 42,
      behavioralGuidance: { skill: '', skillRef: '' },
      workflowState: {
        featureId: 'preserve-test',
        phase: 'review',
        workflowType: 'feature',
      },
      taskProgress: [{ id: 'T-1', status: 'complete' }],
      decisions: [{ id: 'DR-1', summary: 'decision summary' }],
      artifacts: { design: 'docs/designs/test.md' },
      blockers: ['pre-existing blocker'],
      latestHandoff: {
        context: 'latest context',
        eventRef: { sequence: 7, timestamp: '2026-05-09T00:00:00.000Z' },
      },
      recentHandoffs: [
        {
          context: 'recent-0',
          eventRef: { sequence: 5, timestamp: '2026-05-09T00:00:00.000Z' },
        },
      ],
    });

    const v3Doc = upgradeRehydrationDocumentV2toV3(v2Base);

    expect(v3Doc.projectionSequence).toBe(42);
    expect(v3Doc.workflowState).toEqual({
      featureId: 'preserve-test',
      phase: 'review',
      workflowType: 'feature',
    });
    expect(v3Doc.taskProgress).toEqual([{ id: 'T-1', status: 'complete' }]);
    expect(v3Doc.decisions).toEqual([{ id: 'DR-1', summary: 'decision summary' }]);
    expect(v3Doc.artifacts).toEqual({ design: 'docs/designs/test.md' });
    expect(v3Doc.blockers).toEqual(['pre-existing blocker']);
    expect(v3Doc.latestHandoff?.context).toBe('latest context');
    expect(v3Doc.recentHandoffs).toHaveLength(1);
    expect(v3Doc.recentHandoffs?.[0]?.context).toBe('recent-0');
  });

  it('upgradeRehydrationDocumentV2toV3_PropertyTest_AnyValidV2ProducesValidV3', () => {
    const taskProgressEntry = fc.record({
      id: fc.string({ minLength: 1, maxLength: 32 }),
      status: fc.constantFrom('pending', 'in-progress', 'complete', 'blocked'),
    });

    const decisionEntry = fc.record({
      id: fc.string({ minLength: 1, maxLength: 32 }),
      summary: fc.string({ maxLength: 128 }),
    });

    const handoffEventRef = fc.record({
      sequence: fc.nat(),
      timestamp: fc.constant('2026-05-09T00:00:00.000Z'),
    });

    const handoffEntry = fc.record(
      {
        context: fc.string({ maxLength: 256 }),
        eventRef: handoffEventRef,
      },
      { requiredKeys: ['eventRef'] },
    );

    const v2DocArb = fc
      .record({
        projectionSequence: fc.nat(),
        behavioralGuidance: fc.record({
          skill: fc.string({ maxLength: 64 }),
          skillRef: fc.string({ maxLength: 128 }),
        }),
        workflowState: fc.record({
          featureId: fc.string({ minLength: 1, maxLength: 64 }),
          phase: fc.constantFrom('planning', 'implementation', 'review', 'done'),
          workflowType: fc.constantFrom('feature', 'bugfix', 'refactor'),
        }),
        taskProgress: fc.array(taskProgressEntry, { maxLength: 5 }),
        decisions: fc.array(decisionEntry, { maxLength: 5 }),
        artifacts: fc.dictionary(
          fc.string({ minLength: 1, maxLength: 16 }),
          fc.string({ maxLength: 64 }),
        ),
        blockers: fc.array(fc.string({ maxLength: 64 }), { maxLength: 5 }),
        recentHandoffs: fc.array(handoffEntry, { maxLength: 3 }),
      })
      .map((fields) =>
        RehydrationDocumentSchemaV2.parse({
          v: 2,
          ...fields,
        }),
      );

    fc.assert(
      fc.property(v2DocArb, (v2Doc) => {
        const result = RehydrationDocumentSchemaV3.safeParse(
          upgradeRehydrationDocumentV2toV3(v2Doc),
        );
        return result.success;
      }),
      { numRuns: 100 },
    );
  });

  it('upgradeRehydrationDocumentV2toV3_ChainFromV1_ProducesValidV3', () => {
    const v1Doc = RehydrationDocumentSchemaV1.parse({
      v: 1,
      projectionSequence: 5,
      behavioralGuidance: {
        skill: 'rehydrate-foundation',
        skillRef: 'skills/claude-code/rehydrate-foundation/SKILL.md',
      },
      workflowState: {
        featureId: 'chain-test',
        phase: 'implementation',
        workflowType: 'feature',
      },
      taskProgress: [{ id: 'T-chain', status: 'in-progress' }],
      decisions: [],
      artifacts: {},
      blockers: [],
      latestHandoff: {
        context: 'chain latest',
        eventRef: {
          id: 'evt_chain',
          timestamp: '2026-05-09T00:00:00.000Z',
          sequence: 3,
        },
      },
    });

    const v2Doc = upgradeRehydrationDocumentV1toV2(v1Doc);
    const v3Doc = upgradeRehydrationDocumentV2toV3(v2Doc);

    expect(v2Doc.v).toBe(2);
    expect(RehydrationDocumentSchemaV2.safeParse(v2Doc).success).toBe(true);

    expect(v3Doc.v).toBe(3);
    expect(RehydrationDocumentSchemaV3.safeParse(v3Doc).success).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(v3Doc, 'behavioralGuidance')).toBe(false);
    expect(v3Doc.phasePlaybook).toBeNull();
    expect(v3Doc.workflowState.featureId).toBe('chain-test');
    expect(v3Doc.latestHandoff?.context).toBe('chain latest');
    expect(v3Doc.latestHandoff?.eventRef.sequence).toBe(3);
  });
});

describe('upgradeRehydrationDocumentV3toV4 (#1359 / PR4 T12)', () => {
  /** The upgrade renames `'completed'` and `'assigned'` to the `TaskSchema.status` words. `failed` and `pending` stay unchanged. */
  it('UpgradeV3ToV4_TaskProgressCompleted_RenamesToComplete', () => {
    const v3Doc = RehydrationDocumentSchemaV3.parse({
      v: 3,
      projectionSequence: 9,
      workflowState: {
        featureId: 'feat-1359',
        phase: 'delegate',
        workflowType: 'feature',
      },
      taskProgress: [
        { id: 'T001', status: 'completed' },
        { id: 'T002', status: 'assigned' },
        { id: 'T003', status: 'failed' },
        { id: 'T004', status: 'pending' },
      ],
      decisions: [],
      artifacts: {},
      blockers: [],
      recentHandoffs: [],
      phasePlaybook: null,
    });

    const v4Doc = upgradeRehydrationDocumentV3toV4(v3Doc);

    expect(v4Doc.v).toBe(4);
    const byId = new Map(v4Doc.taskProgress.map((t) => [t.id, t.status]));
    expect(byId.get('T001')).toBe('complete');
    expect(byId.get('T002')).toBe('in_progress');
    expect(byId.get('T003')).toBe('failed');
    expect(byId.get('T004')).toBe('pending');

    expect(RehydrationDocumentSchema.safeParse(v4Doc).success).toBe(true);

    expect(v4Doc.projectionSequence).toBe(9);
    expect(v4Doc.workflowState).toEqual(v3Doc.workflowState);
    expect(v4Doc.phasePlaybook).toBeNull();
  });

  it('UpgradeChain_FromV1OrV2_TerminatesAtV4', () => {
    const v1Doc = RehydrationDocumentSchemaV1.parse({
      v: 1,
      projectionSequence: 1,
      behavioralGuidance: { skill: 's', skillRef: 'sr' },
      workflowState: { featureId: 'f', phase: 'p', workflowType: 'feature' },
      taskProgress: [{ id: 'T1', status: 'completed' }],
      decisions: [],
      artifacts: {},
      blockers: [],
    });

    const latest = upgradeRehydrationDocument(v1Doc);
    expect(latest.v).toBe(4);
    expect(latest.taskProgress[0]?.status).toBe('complete');
    expect(RehydrationDocumentSchema.safeParse(latest).success).toBe(true);
  });
});
