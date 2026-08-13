/**
 * Coordinator unit tests (DR-7, v2.11) — `scoreEntryThroughTopology`
 * looks up `topology.phases[phase].staleness` and delegates to
 * `scoreStaleness`. Throws on missing-contract / missing-phase
 * synthetic Topologies (production-loaded Topologies cannot reach
 * those states because the loader hard-throws).
 */
import { describe, it, expect } from 'vitest';
import { scoreEntryThroughTopology } from './coordinator.js';
import type { Topology } from '../workflow/topology/phase-contract.js';

const topology: Topology = Object.freeze({
  phases: Object.freeze({
    design: Object.freeze({
      staleness: Object.freeze({
        expectedMaxDwellMinutes: 60,
        freshnessRequires: 'all' as const,
        signals: Object.freeze([
          Object.freeze({ name: 'lastActivity' as const, thresholdMinutes: 60 }),
        ]),
      }),
    }),
    // Synthetic fixture: in production the loader rejects this shape.
    scaffolding: Object.freeze({}),
  }),
}) as Topology;

describe('scoreEntryThroughTopology', () => {
  it('uses the phase contract when present', () => {
    const result = scoreEntryThroughTopology(topology, 'design', {
      lastActivityMinutes: 9999,
    });
    expect(result.isStale).toBe(true);
    expect(result.signalsEvaluated).toEqual({ lastActivity: true });
  });

  it('throws when phase has no contract (v2.11 invariant)', () => {
    expect(() =>
      scoreEntryThroughTopology(topology, 'scaffolding', {
        lastActivityMinutes: 100,
      }),
    ).toThrow(/contract|staleness/i);
  });

  it('throws when phase is absent from topology (v2.11 invariant)', () => {
    expect(() =>
      scoreEntryThroughTopology(topology, 'phaseNotInTopology', {
        lastActivityMinutes: 100,
      }),
    ).toThrow(/absent|contract|missing|unknown/i);
  });
});
