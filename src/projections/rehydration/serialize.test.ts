/**
 * `loadRehydrationDocument` and `STABLE_KEYS` tests — T3 (#1246-readside-migration) + T-03
 * (rehydration-machinery-refactor) + T-05 (STABLE_KEYS v:3 alignment).
 *
 * Verifies the read-side entry point that probes the envelope `v`
 * discriminator and routes:
 *   - v:3 → schema-parse pass-through (native, no upgrade)
 *   - v:2 → upgrade via `upgradeRehydrationDocumentV2toV3`
 *   - v:1 → chained upgrade v:1 → v:2 → v:3 via `upgradeRehydrationDocument`
 *   - neither → `InvalidEnvelopeError` (no silent fallback per DR-18 strict
 *     boundary — corruption surfaces as a typed throw, not as an empty doc)
 *
 * All load paths now return `RehydrationDocumentV3` (T-03).
 *
 * T-05 adds assertions that `STABLE_KEYS` reflects the v:3 StableSectionsSchema
 * shape: `workflowState` present, `behavioralGuidance` absent.
 *
 * Fixture provenance (DIM-4): No real on-disk v:1 rehydration document was
 * reachable; tests use synthetic fixtures only. Real-fixture capture tracked
 * in #1296.
 */
import { describe, it, expect } from 'vitest';
import { loadRehydrationDocument, serializeRehydrationDocument, STABLE_KEYS } from './serialize.js';
import { InvalidEnvelopeError } from './upgrade.js';

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
  it('loadRehydrationDocument_V2Document_ReturnsLatestShape', () => {
    // T-03 RED: v:2 doc should be upgraded to v:3 on load.
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

    // Upgraded to v:3.
    expect(result.v).toBe(4);
    expect(result.projectionSequence).toBe(7);
    expect(result.latestHandoff?.eventRef.sequence).toBe(100);
    expect(result.recentHandoffs?.[0]?.eventRef.sequence).toBe(100);

    // No upgrade-path side-effects (no degraded blockers were injected).
    expect(result.blockers).toEqual([]);

    // phasePlaybook seeded null (v:3 volatile field).
    expect(result.phasePlaybook).toBeNull();

    // behavioralGuidance dropped (not part of v:3).
    expect(Object.prototype.hasOwnProperty.call(result, 'behavioralGuidance')).toBe(false);
  });

  it('loadRehydrationDocument_V1Document_ReturnsLatestShape', () => {
    // T-03 RED: v:1 doc should chain through v:2 → v:3 on load.
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

    // Chained all the way to v:3.
    expect(result.v).toBe(4);

    // No `id` leaks anywhere on eventRef.
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

    // phasePlaybook seeded null (v:3 volatile field).
    expect(result.phasePlaybook).toBeNull();

    // behavioralGuidance dropped (not part of v:3).
    expect(Object.prototype.hasOwnProperty.call(result, 'behavioralGuidance')).toBe(false);
  });

  it('loadRehydrationDocument_V4Document_NativePassThrough', () => {
    // Native pass-through for the latest envelope (v:4 post #1359 / PR4 T12).
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

    // Native pass-through: v:4 shape preserved verbatim.
    expect(result.v).toBe(4);
    expect(result.projectionSequence).toBe(42);
    expect(result.phasePlaybook).toBeNull();
    expect(result.blockers).toEqual([]);

    // behavioralGuidance was never present and must not be on result.
    expect(Object.prototype.hasOwnProperty.call(result, 'behavioralGuidance')).toBe(false);
  });

  it('loadRehydrationDocument_InvalidEnvelope_ThrowsInvalidEnvelopeError', () => {
    // None of v:1 / v:2 / v:3 / v:4 — typed error (no silent fallback).
    const garbage = { v: 99, projectionSequence: 0, ...minimalV2Stable };

    expect(() => loadRehydrationDocument(garbage)).toThrow(InvalidEnvelopeError);

    // Also rejects non-object / missing-v inputs.
    expect(() => loadRehydrationDocument({ projectionSequence: 0 })).toThrow(
      InvalidEnvelopeError,
    );
    expect(() => loadRehydrationDocument(null)).toThrow(InvalidEnvelopeError);
  });
});

// ─── T-05: STABLE_KEYS reflects v:3 StableSectionsSchema ─────────────────────

describe('STABLE_KEYS (T-05, rehydration-machinery-refactor)', () => {
  it('StableKeys_IncludesWorkflowState', () => {
    // T-05 RED: STABLE_KEYS must include 'workflowState' — the only stable
    // section in v:3. If this fails, serializeRehydrationDocument will not
    // enforce stable ordering for workflowState bytes.
    expect(STABLE_KEYS).toContain('workflowState');
  });

  it('StableKeys_ExcludesBehavioralGuidance', () => {
    // T-05 RED: behavioralGuidance was removed from StableSectionsSchema in
    // T-01 (v:3 envelope). STABLE_KEYS must NOT contain it. If this fails,
    // the cache-prefix bytes would depend on a field that no v:3 document
    // ever carries, which would corrupt the stable-prefix invariant.
    expect(STABLE_KEYS).not.toContain('behavioralGuidance');
  });

  it('StableKeys_DerivedFromSchema_ExactlyMatchesSchemaShape', () => {
    // T-05 RED: STABLE_KEYS must be exactly the set of keys in
    // StableSectionsSchema.shape — no more, no less. If a future schema
    // edit adds or removes a stable field, this test surfaces the drift
    // automatically (no manual STABLE_KEYS update required).
    expect(STABLE_KEYS).toEqual(['workflowState']);
  });

  it('CachePrefixSerialization_V3Doc_IsDeterministic', () => {
    // T-05 RED: two v:3 docs with identical (workflowType, phase) must
    // produce identical prefix bytes. Verifies that serializeRehydrationDocument
    // is field-order-disciplined for the v:3 stable section.
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

    // Construct a second doc with different volatile content but same stable section.
    const docA = { ...baseDoc, projectionSequence: 10, taskProgress: [] };
    const docB = {
      ...baseDoc,
      projectionSequence: 10,
      // Same stable section as docA, different volatile (blockers).
      blockers: ['a-blocker'],
    };

    const serializedA = serializeRehydrationDocument(docA);
    const serializedB = serializeRehydrationDocument(docB);

    // The stable prefix (up through workflowState) must be byte-identical.
    // Find where 'taskProgress' (first volatile key) begins in each output.
    const stableBoundaryA = serializedA.indexOf('"taskProgress"');
    const stableBoundaryB = serializedB.indexOf('"taskProgress"');

    expect(stableBoundaryA).toBeGreaterThan(0);
    expect(stableBoundaryB).toBeGreaterThan(0);

    const prefixA = serializedA.slice(0, stableBoundaryA);
    const prefixB = serializedB.slice(0, stableBoundaryB);

    expect(prefixA).toBe(prefixB);
  });
});
