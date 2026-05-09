/**
 * `loadRehydrationDocument` tests — T3 (#1246-readside-migration) + T-03
 * (rehydration-machinery-refactor).
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
 * Fixture provenance (DIM-4): No real on-disk v:1 rehydration document was
 * reachable; tests use synthetic fixtures only. Real-fixture capture tracked
 * in #1296.
 */
import { describe, it, expect } from 'vitest';
import { loadRehydrationDocument } from './serialize.js';
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
  it('loadRehydrationDocument_V2Document_ReturnsV3Shape', () => {
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
    expect(result.v).toBe(3);
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

  it('loadRehydrationDocument_V1Document_ReturnsV3Shape', () => {
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
    expect(result.v).toBe(3);

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

  it('loadRehydrationDocument_V3Document_NativePassThrough', () => {
    // T-03 RED: v:3 doc should pass through without any upgrade applied.
    const v3Input = {
      v: 3,
      projectionSequence: 42,
      ...minimalWorkflowState,
      taskProgress: [],
      decisions: [],
      artifacts: {},
      blockers: [],
      recentHandoffs: [],
      phasePlaybook: null,
    };

    const result = loadRehydrationDocument(v3Input);

    // Native pass-through: v:3 shape preserved verbatim.
    expect(result.v).toBe(3);
    expect(result.projectionSequence).toBe(42);
    expect(result.phasePlaybook).toBeNull();
    expect(result.blockers).toEqual([]);

    // behavioralGuidance was never present and must not be on result.
    expect(Object.prototype.hasOwnProperty.call(result, 'behavioralGuidance')).toBe(false);
  });

  it('loadRehydrationDocument_InvalidEnvelope_ThrowsInvalidEnvelopeError', () => {
    // Neither v:1 nor v:2 nor v:3 — typed error (no silent fallback).
    const garbage = { v: 99, projectionSequence: 0, ...minimalV2Stable };

    expect(() => loadRehydrationDocument(garbage)).toThrow(InvalidEnvelopeError);

    // Also rejects non-object / missing-v inputs.
    expect(() => loadRehydrationDocument({ projectionSequence: 0 })).toThrow(
      InvalidEnvelopeError,
    );
    expect(() => loadRehydrationDocument(null)).toThrow(InvalidEnvelopeError);
  });
});
