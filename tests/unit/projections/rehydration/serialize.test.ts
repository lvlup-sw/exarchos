/**
 * Tests for `loadRehydrationDocument`, `STABLE_KEYS` and the stable prefix of the serializer.
 *
 * `loadRehydrationDocument` probes the envelope `v` and always returns a v:4 document. A v:4
 * input parses as is. An older input goes through the upgrade chain. An input of no known
 * version throws `InvalidEnvelopeError`, never an empty document.
 *
 * All fixtures are synthetic.
 */
import { describe, it, expect } from 'vitest';
import { loadRehydrationDocument, serializeRehydrationDocument, STABLE_KEYS } from '../../../../src/projections/rehydration/serialize.js';
import { InvalidEnvelopeError } from '../../../../src/projections/rehydration/upgrade.js';

const minimalWorkflowState = {
  workflowState: {
    featureId: 'checkpoint-handoff-bundle',
    phase: 'implementation',
    workflowType: 'feature',
  },
};

const minimalV2Stable = {
  behavioralGuidance: {
    skill: 'rehydrate-foundation',
    skillRef: 'skills/claude-code/rehydrate-foundation/SKILL.md',
  },
  ...minimalWorkflowState,
};

describe('loadRehydrationDocument (T3, #1246 + T-03, rehydration-machinery-refactor)', () => {
  /** The upgrade of a v:2 input adds no degraded blocker, drops `behavioralGuidance` and sets `phasePlaybook` to `null`. */
  it('loadRehydrationDocument_V2Document_ReturnsLatestShape', () => {
    const v2Input = {
      v: 2,
      projectionSequence: 7,
      ...minimalV2Stable,
      taskProgress: [],
      decisions: [],
      artifacts: {},
      blockers: [],
      recentHandoffs: [
        {
          context: 'already v:2',
          eventRef: {
            sequence: 100,
            timestamp: '2026-05-08T00:00:00.000Z',
          },
        },
      ],
      latestHandoff: {
        context: 'already v:2 latest',
        eventRef: {
          sequence: 100,
          timestamp: '2026-05-08T00:00:00.000Z',
        },
      },
    };

    const result = loadRehydrationDocument(v2Input);

    expect(result.v).toBe(4);
    expect(result.projectionSequence).toBe(7);
    expect(result.latestHandoff?.eventRef.sequence).toBe(100);
    expect(result.recentHandoffs?.[0]?.eventRef.sequence).toBe(100);
    expect(result.blockers).toEqual([]);
    expect(result.phasePlaybook).toBeNull();
    expect(Object.prototype.hasOwnProperty.call(result, 'behavioralGuidance')).toBe(false);
  });

  /** A v:1 input goes through each upgrade step. No `eventRef.id` stays on a handoff entry. */
  it('loadRehydrationDocument_V1Document_ReturnsLatestShape', () => {
    const v1Input = {
      v: 1,
      projectionSequence: 3,
      ...minimalV2Stable,
      taskProgress: [],
      decisions: [],
      artifacts: {},
      blockers: [],
      latestHandoff: {
        context: 'legacy',
        eventRef: {
          id: 'evt_legacy',
          timestamp: '2026-05-08T00:00:00.000Z',
          sequence: 12,
        },
      },
      recentHandoffs: [
        {
          context: 'legacy-r0',
          eventRef: {
            id: 'evt_legacy_r0',
            timestamp: '2026-05-08T00:00:00.000Z',
            sequence: 11,
          },
        },
      ],
    };

    const result = loadRehydrationDocument(v1Input);

    expect(result.v).toBe(4);
    expect(result.latestHandoff?.eventRef).toEqual({
      sequence: 12,
      timestamp: '2026-05-08T00:00:00.000Z',
    });
    expect(
      Object.prototype.hasOwnProperty.call(result.latestHandoff!.eventRef, 'id'),
    ).toBe(false);
    expect(result.recentHandoffs?.[0]?.eventRef).toEqual({
      sequence: 11,
      timestamp: '2026-05-08T00:00:00.000Z',
    });
    expect(
      Object.prototype.hasOwnProperty.call(
        result.recentHandoffs![0]!.eventRef,
        'id',
      ),
    ).toBe(false);
    expect(result.phasePlaybook).toBeNull();
    expect(Object.prototype.hasOwnProperty.call(result, 'behavioralGuidance')).toBe(false);
  });

  it('loadRehydrationDocument_V4Document_NativePassThrough', () => {
    const v4Input = {
      v: 4,
      projectionSequence: 42,
      ...minimalWorkflowState,
      taskProgress: [],
      decisions: [],
      artifacts: {},
      blockers: [],
      recentHandoffs: [],
      phasePlaybook: null,
    };

    const result = loadRehydrationDocument(v4Input);

    expect(result.v).toBe(4);
    expect(result.projectionSequence).toBe(42);
    expect(result.phasePlaybook).toBeNull();
    expect(result.blockers).toEqual([]);
    expect(Object.prototype.hasOwnProperty.call(result, 'behavioralGuidance')).toBe(false);
  });

  /** An unknown `v`, a missing `v` and a `null` input each throw the typed error. */
  it('loadRehydrationDocument_InvalidEnvelope_ThrowsInvalidEnvelopeError', () => {
    const garbage = { v: 99, projectionSequence: 0, ...minimalV2Stable };

    expect(() => loadRehydrationDocument(garbage)).toThrow(InvalidEnvelopeError);
    expect(() => loadRehydrationDocument({ projectionSequence: 0 })).toThrow(
      InvalidEnvelopeError,
    );
    expect(() => loadRehydrationDocument(null)).toThrow(InvalidEnvelopeError);
  });
});

describe('STABLE_KEYS (T-05, rehydration-machinery-refactor)', () => {
  it('StableKeys_IncludesWorkflowState', () => {
    expect(STABLE_KEYS).toContain('workflowState');
  });

  /** No v:3 or v:4 document holds `behavioralGuidance`, so the stable prefix must not name it. */
  it('StableKeys_ExcludesBehavioralGuidance', () => {
    expect(STABLE_KEYS).not.toContain('behavioralGuidance');
  });

  /** Pins the exact key list, so a change to the keys of `StableSectionsSchema` fails here. */
  it('StableKeys_DerivedFromSchema_ExactlyMatchesSchemaShape', () => {
    expect(STABLE_KEYS).toEqual(['workflowState']);
  });

  /**
   * Two documents have the same stable section and different blockers. They must share the bytes
   * before `"taskProgress"`, the first volatile key.
   */
  it('CachePrefixSerialization_V3Doc_IsDeterministic', () => {
    const baseDoc = {
      v: 4 as const,
      projectionSequence: 10,
      workflowState: {
        featureId: 'feature-alpha',
        phase: 'implementation',
        workflowType: 'feature',
      },
      taskProgress: [],
      decisions: [],
      artifacts: {},
      blockers: [],
      recentHandoffs: [],
      phasePlaybook: null,
    };

    const docA = { ...baseDoc, projectionSequence: 10, taskProgress: [] };
    const docB = {
      ...baseDoc,
      projectionSequence: 10,
      blockers: ['a-blocker'],
    };

    const serializedA = serializeRehydrationDocument(docA);
    const serializedB = serializeRehydrationDocument(docB);

    const stableBoundaryA = serializedA.indexOf('"taskProgress"');
    const stableBoundaryB = serializedB.indexOf('"taskProgress"');

    expect(stableBoundaryA).toBeGreaterThan(0);
    expect(stableBoundaryB).toBeGreaterThan(0);

    const prefixA = serializedA.slice(0, stableBoundaryA);
    const prefixB = serializedB.slice(0, stableBoundaryB);

    expect(prefixA).toBe(prefixB);
  });
});
