/**
 * Read-side v:1 → v:2 migration tests — T3 (#1246-readside-migration, DR-18).
 *
 * Covers per-entry and full-document upgrades from the legacy v:1 rehydration
 * shape (`eventRef.id` primary, `eventRef.sequence` advisory) to the v:2 shape
 * (`eventRef.sequence` primary, `eventRef.id` removed). Per DR-18 the upgrade
 * fails OPEN at the entry granularity: a v:1 entry missing a usable sequence
 * raises `HandoffEntryUpgradeError` so the document-level upgrade can drop it
 * and append a degraded blocker, rather than tearing down the whole envelope.
 *
 * Fixture provenance (DIM-4): No real on-disk v:1 rehydration document was
 * reachable from this worktree (no `~/.claude/projects/state/*.snapshot.json`,
 * `/tmp/*.snapshot.json`, or repo-internal v:1 fixture). Tests use synthetic
 * fixtures only; fidelity-vs-real-snapshot risk is acknowledged. Real-fixture
 * capture tracked in #1296.
 */
import { describe, it, expect } from 'vitest';
import {
  upgradeHandoffEntryV1toV2,
  upgradeRehydrationDocumentV1toV2,
  HandoffEntryUpgradeError,
} from './upgrade.js';
import {
  HandoffEntrySchemaV1,
  HandoffEntrySchemaV2,
  RehydrationDocumentSchema,
  RehydrationDocumentSchemaV1,
} from './schema.js';

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

    // The full v:2 schema (with strict boundaries) accepts the upgraded doc.
    expect(RehydrationDocumentSchema.safeParse(v2Doc).success).toBe(true);

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

    // The full v:2 schema still accepts the upgraded doc.
    expect(RehydrationDocumentSchema.safeParse(v2Doc).success).toBe(true);
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

    // The full v:2 schema still accepts the upgraded doc.
    expect(RehydrationDocumentSchema.safeParse(v2Doc).success).toBe(true);
  });
});
