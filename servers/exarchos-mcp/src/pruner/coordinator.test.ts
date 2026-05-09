/**
 * Coordinator unit tests — `scoreEntryThroughTopology` looks up
 * `topology.phases[phase].staleness` and delegates to `scoreStaleness`.
 */
import { describe, it, expect } from 'vitest';
import { scoreEntryThroughTopology } from './coordinator.js';
import type { Topology } from '../topology/phase-contract.js';

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
    scaffolding: Object.freeze({}), // no staleness → fallback
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

  it('falls back to single-signal v2.9 heuristic when phase has no contract', () => {
    const result = scoreEntryThroughTopology(topology, 'scaffolding', {
      lastActivityMinutes: 100,
      thresholdMinutes: 60,
    });
    expect(result.isStale).toBe(true);
    expect(result.signalsEvaluated).toEqual({});
  });

  it('falls back to single-signal v2.9 heuristic when phase is absent from topology', () => {
    const result = scoreEntryThroughTopology(topology, 'phaseNotInTopology', {
      lastActivityMinutes: 100,
      thresholdMinutes: 60,
    });
    expect(result.isStale).toBe(true);
  });
});
