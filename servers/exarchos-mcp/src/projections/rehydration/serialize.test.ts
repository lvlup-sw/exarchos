/**
 * `loadRehydrationDocument` tests — T3 (#1246-readside-migration).
 *
 * Verifies the read-side entry point that probes the envelope `v`
 * discriminator and routes:
 *   - v:2 → schema-parse pass-through
 *   - v:1 → upgrade via `upgradeRehydrationDocumentV1toV2`
 *   - neither → `InvalidEnvelopeError` (no silent fallback per DR-18 strict
 *     boundary — corruption surfaces as a typed throw, not as an empty doc)
 *
 * Fixture provenance (DIM-4): No real on-disk v:1 rehydration document was
 * reachable; tests use synthetic fixtures only. Real-fixture capture tracked
 * in #1296.
 */
import { describe, it, expect } from 'vitest';
import { loadRehydrationDocument } from './serialize.js';
import { InvalidEnvelopeError } from './upgrade.js';

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

describe('loadRehydrationDocument (T3, #1246)', () => {
  it('loadRehydrationDocument_V2Document_PassesThroughUnchanged', () => {
    const v2Input = {
      v: 2,
      projectionSequence: 7,
      ...minimalStable,
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

    // Pass-through: every field equals the input.
    expect(result.v).toBe(2);
    expect(result.projectionSequence).toBe(7);
    expect(result.latestHandoff?.eventRef.sequence).toBe(100);
    expect(result.recentHandoffs?.[0]?.eventRef.sequence).toBe(100);

    // No upgrade-path side-effects (no degraded blockers were injected).
    expect(result.blockers).toEqual([]);
  });

  it('loadRehydrationDocument_V1Document_ReturnsV2Shape', () => {
    const v1Input = {
      v: 1,
      projectionSequence: 3,
      ...minimalStable,
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

    // Envelope was bumped.
    expect(result.v).toBe(2);

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
  });

  it('loadRehydrationDocument_InvalidEnvelope_ThrowsInvalidEnvelopeError', () => {
    // Neither v:1 nor v:2 — typed error (no silent fallback).
    const garbage = { v: 99, projectionSequence: 0, ...minimalStable };

    expect(() => loadRehydrationDocument(garbage)).toThrow(InvalidEnvelopeError);

    // Also rejects non-object / missing-v inputs.
    expect(() => loadRehydrationDocument({ projectionSequence: 0 })).toThrow(
      InvalidEnvelopeError,
    );
    expect(() => loadRehydrationDocument(null)).toThrow(InvalidEnvelopeError);
  });
});
