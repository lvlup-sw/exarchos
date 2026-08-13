/**
 * Read-side v:1 → v:2 → v:3 migration tests — T3 + T-02.
 *
 * T3 (#1246-readside-migration, DR-18):
 * Covers per-entry and full-document upgrades from the legacy v:1 rehydration
 * shape (`eventRef.id` primary, `eventRef.sequence` advisory) to the v:2 shape
 * (`eventRef.sequence` primary, `eventRef.id` removed). Per DR-18 the upgrade
 * fails OPEN at the entry granularity: a v:1 entry missing a usable sequence
 * raises `HandoffEntryUpgradeError` so the document-level upgrade can drop it
 * and append a degraded blocker, rather than tearing down the whole envelope.
 *
 * T-02 (rehydration-machinery-refactor):
 * Covers upgradeRehydrationDocumentV2toV3 — pure field drop: behavioralGuidance
 * removed, phasePlaybook seeded null (composed at handler time, not folded).
 *
 * Fixture provenance (DIM-4): No real on-disk v:1 rehydration document was
 * reachable from this worktree (no `~/.claude/projects/state/*.snapshot.json`,
 * `/tmp/*.snapshot.json`, or repo-internal v:1 fixture). Tests use synthetic
 * fixtures only; fidelity-vs-real-snapshot risk is acknowledged. Real-fixture
 * capture tracked in #1296.
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

    // v:2 schema validates the upgraded entry (strict mode rejects stray id).
    expect(HandoffEntrySchemaV2.safeParse(v2Entry).success).toBe(true);

    // No id key on inner eventRef.
    expect(v2Entry.eventRef).toEqual({
      sequence: 42,
      timestamp: '2026-05-08T00:00:00.000Z',
    });
    expect(Object.prototype.hasOwnProperty.call(v2Entry.eventRef, 'id')).toBe(false);

    // Volatile fields propagated verbatim.
    expect(v2Entry.context).toBe('handoff context');
    expect(v2Entry.nextSteps).toEqual(['step 1', 'step 2']);
    expect(v2Entry.suggestions).toEqual(['try X']);
  });

  it('upgradeHandoffEntryV1toV2_MissingSequence_ThrowsForFailOpen', () => {
    // Pre-#1230 entry: id only, no advisory sequence. Per DR-18 the upgrade
    // throws so the caller can drop the entry and surface a degraded blocker.
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

    // The v:2 read-back schema accepts the upgraded doc.
    expect(RehydrationDocumentSchemaV2.safeParse(v2Doc).success).toBe(true);

    // Envelope discriminator bumped.
    expect(v2Doc.v).toBe(2);

    // Stable + non-handoff volatile sections preserved verbatim.
    expect(v2Doc.projectionSequence).toBe(17);
    expect(v2Doc.behavioralGuidance).toEqual(minimalStable.behavioralGuidance);
    expect(v2Doc.workflowState).toEqual(minimalStable.workflowState);
    expect(v2Doc.taskProgress).toEqual(baseVolatileV1.taskProgress);
    expect(v2Doc.decisions).toEqual(baseVolatileV1.decisions);
    expect(v2Doc.artifacts).toEqual(baseVolatileV1.artifacts);
    expect(v2Doc.blockers).toEqual(baseVolatileV1.blockers);

    // latestHandoff upgraded — id dropped, sequence retained.
    expect(v2Doc.latestHandoff?.eventRef).toEqual({
      sequence: 99,
      timestamp: '2026-05-08T01:00:00.000Z',
    });

    // recentHandoffs upgraded entry-by-entry.
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

  it('upgradeRehydrationDocumentV1toV2_SkipsBadEntries_DegradedBlocker', () => {
    const v1Doc = RehydrationDocumentSchemaV1.parse({
      v: 1,
      projectionSequence: 5,
      ...minimalStable,
      ...baseVolatileV1,
      recentHandoffs: [
        // Good entry — should survive.
        {
          context: 'good',
          eventRef: {
            id: 'evt_good',
            timestamp: '2026-05-08T00:00:00.000Z',
            sequence: 10,
          },
        },
        // Bad entry — id only, no sequence; upgrade fails open.
        {
          context: 'bad',
          eventRef: {
            id: 'evt_bad_no_seq',
            timestamp: '2026-05-08T00:00:00.000Z',
          },
        },
        // Another good entry — should survive.
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

    // The bad entry was dropped; the survivors retain order.
    expect(v2Doc.recentHandoffs).toHaveLength(2);
    expect(v2Doc.recentHandoffs?.[0]?.context).toBe('good');
    expect(v2Doc.recentHandoffs?.[1]?.context).toBe('good-2');

    // A degraded blocker was appended for the dropped entry.
    expect(v2Doc.blockers.length).toBe(baseVolatileV1.blockers.length + 1);
    const newBlocker = v2Doc.blockers[v2Doc.blockers.length - 1];
    expect(typeof newBlocker).toBe('object');
    expect(newBlocker).toMatchObject({
      source: 'rehydration.upgrade-v1-to-v2',
      reason: expect.stringMatching(/recentHandoffs/),
    });

    // The v:2 read-back schema still accepts the upgraded doc.
    expect(RehydrationDocumentSchemaV2.safeParse(v2Doc).success).toBe(true);
  });

  it('upgradeRehydrationDocumentV1toV2_AllEntriesBad_ReturnsEmptyHandoffs', () => {
    // Edge case: every recentHandoffs entry is missing a usable sequence and
    // latestHandoff is missing too. The doc-level upgrade must NOT throw —
    // per DR-18 fail-open is per-entry, not per-document.
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

    // recentHandoffs is empty (all 3 dropped).
    expect(v2Doc.recentHandoffs).toEqual([]);

    // latestHandoff is undefined (the bad one was dropped).
    expect(v2Doc.latestHandoff).toBeUndefined();

    // 4 degraded blockers appended (1 for latestHandoff + 3 for recentHandoffs).
    expect(v2Doc.blockers.length).toBe(baseVolatileV1.blockers.length + 4);

    // The v:2 read-back schema still accepts the upgraded doc.
    expect(RehydrationDocumentSchemaV2.safeParse(v2Doc).success).toBe(true);
  });
});

// ─── T-02: v:2 → v:3 upgrade ─────────────────────────────────────────────────

/**
 * Minimal v:2 fixture helper. Returns a parsed v:2 doc with behavioralGuidance
 * and a basic workflowState, projectionSequence, and empty volatile sections.
 */
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
  it('upgradeRehydrationDocumentV2toV3_MinimalV2Doc_DropsBehavioralGuidanceAddsPhasePlaybookNull', () => {
    // Given a minimal valid v:2 doc with behavioralGuidance, the upgrade drops
    // behavioralGuidance and seeds phasePlaybook: null.
    const v2Doc = makeMinimalV2Doc();

    const v3Doc = upgradeRehydrationDocumentV2toV3(v2Doc);

    // Envelope discriminator bumped to 3.
    expect(v3Doc.v).toBe(3);

    // behavioralGuidance must be absent (field dropped by upgrade).
    expect(Object.prototype.hasOwnProperty.call(v3Doc, 'behavioralGuidance')).toBe(false);

    // phasePlaybook seeded null (composed at handler time, not folded from events).
    expect(v3Doc.phasePlaybook).toBeNull();

    // The v:3 schema validates the result. Post #1359 / PR4 T12 the
    // top-level RehydrationDocumentSchema is v:4, so the intermediate v:3
    // shape validates against the frozen RehydrationDocumentSchemaV3.
    expect(RehydrationDocumentSchemaV3.safeParse(v3Doc).success).toBe(true);
  });

  it('upgradeRehydrationDocumentV2toV3_PreservesWorkflowStateProjectionSequenceAndVolatileFields', () => {
    // workflowState, projectionSequence, and volatile sections are preserved
    // verbatim across the upgrade.
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
    // Property test: for any valid v:2 document, the upgrade produces a
    // document that passes RehydrationDocumentSchema.parse (v:3).
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
    // Chain test: v:1 → v:2 → v:3 produces a valid v:3 document.
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

    // v:1 → v:2 still works correctly.
    expect(v2Doc.v).toBe(2);
    expect(RehydrationDocumentSchemaV2.safeParse(v2Doc).success).toBe(true);

    // v:2 → v:3 chain produces a valid v:3 document. Post #1359 / PR4 T12
    // the top-level schema is v:4; the intermediate v:3 shape validates
    // against the frozen RehydrationDocumentSchemaV3.
    expect(v3Doc.v).toBe(3);
    expect(RehydrationDocumentSchemaV3.safeParse(v3Doc).success).toBe(true);

    // behavioralGuidance is absent from the v:3 result.
    expect(Object.prototype.hasOwnProperty.call(v3Doc, 'behavioralGuidance')).toBe(false);

    // phasePlaybook is null.
    expect(v3Doc.phasePlaybook).toBeNull();

    // workflowState preserved through the chain.
    expect(v3Doc.workflowState.featureId).toBe('chain-test');

    // latestHandoff preserved through the chain (upgraded from v:1 entry).
    expect(v3Doc.latestHandoff?.context).toBe('chain latest');
    expect(v3Doc.latestHandoff?.eventRef.sequence).toBe(3);
  });
});

// ─── #1359 / PR4 T12 — v:3 → v:4 taskProgress vocabulary rename ─────────────

describe('upgradeRehydrationDocumentV3toV4 (#1359 / PR4 T12)', () => {
  it('UpgradeV3ToV4_TaskProgressCompleted_RenamesToComplete', () => {
    // GIVEN: a valid v:3 document carrying the pre-#1359 task-progress
    // vocabulary (`'completed'` / `'assigned'`).
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

    // WHEN: we upgrade to v:4
    const v4Doc = upgradeRehydrationDocumentV3toV4(v3Doc);

    // THEN: vocabulary is renamed to canonical TaskSchema.status values.
    expect(v4Doc.v).toBe(4);
    const byId = new Map(v4Doc.taskProgress.map((t) => [t.id, t.status]));
    expect(byId.get('T001')).toBe('complete');     // was 'completed'
    expect(byId.get('T002')).toBe('in_progress');  // was 'assigned'
    expect(byId.get('T003')).toBe('failed');       // unchanged
    expect(byId.get('T004')).toBe('pending');      // unchanged

    // AND: the upgraded doc passes the v:4 schema.
    expect(RehydrationDocumentSchema.safeParse(v4Doc).success).toBe(true);

    // AND: non-task fields are preserved verbatim.
    expect(v4Doc.projectionSequence).toBe(9);
    expect(v4Doc.workflowState).toEqual(v3Doc.workflowState);
    expect(v4Doc.phasePlaybook).toBeNull();
  });

  it('UpgradeChain_FromV1OrV2_TerminatesAtV4', () => {
    // The full upgrade chain (v:1 → v:4) must produce a v:4-shaped document.
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
