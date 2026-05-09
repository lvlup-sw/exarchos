/**
 * T48 — Bundle integration test: phase contract end-to-end through the
 * pruner's pure scoring layer.
 *
 * Uses a multi-phase topology fixture covering:
 *   - phases declaring staleness with `freshnessRequires: 'all'`
 *   - phases declaring staleness with `freshnessRequires: 'any'`
 *   - phases without a contract (fallback path)
 *
 * For each phase, asserts the pruner's verdict (via `scoreStaleness`)
 * matches the expected outcome under contract-aware scoring vs the
 * single-signal v2.9 fallback. T58 will wire this through the
 * orchestration handler in `lifecycle.ts`; this test exercises the
 * scorer + topology composition without touching the IO-bearing
 * handler.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  loadTopology,
  __resetTopologyCacheForTesting,
} from '../topology/loader.js';
import { scoreStaleness } from './score.js';

function writeTopology(yamlBody: string): string {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pruner-integration-'));
  const file = path.join(tmp, 'topology.yaml');
  fs.writeFileSync(file, yamlBody, 'utf-8');
  return file;
}

const MULTI_PHASE_TOPOLOGY = `
phases:
  design:
    staleness:
      expectedMaxDwellMinutes: 60
      freshnessRequires: all
      signals:
        - name: lastActivity
          thresholdMinutes: 60
        - name: phaseTransition
          thresholdMinutes: 60
  implement:
    staleness:
      expectedMaxDwellMinutes: 240
      freshnessRequires: any
      signals:
        - name: lastActivity
          thresholdMinutes: 240
        - name: branchActivity
          thresholdMinutes: 1440
  review:
    staleness:
      expectedMaxDwellMinutes: 120
      freshnessRequires: all
      signals:
        - name: lastActivity
          thresholdMinutes: 120
        - name: phaseTransition
          thresholdMinutes: 120
        - name: branchActivity
          thresholdMinutes: 1440
  scaffolding: {}
  orphan: {}
`;

describe('pruner_integration_with_phase_contract_multi_phase_fixture', () => {
  beforeEach(() => {
    __resetTopologyCacheForTesting();
  });

  it('routes per-phase scoring through the contract; missing phases fall back to v2.9 single-signal', async () => {
    const file = writeTopology(MULTI_PHASE_TOPOLOGY);
    const topology = await loadTopology({ topologyPath: file });

    // ─── design (all-fresh) ─────────────────────────────────────────────────
    // Both signals fresh → not stale.
    expect(
      scoreStaleness(
        { lastActivityMinutes: 30, phaseTransitionMinutes: 30 },
        topology.phases.design.staleness,
      ).isStale,
    ).toBe(false);
    // One signal stale → stale.
    expect(
      scoreStaleness(
        { lastActivityMinutes: 30, phaseTransitionMinutes: 9999 },
        topology.phases.design.staleness,
      ).isStale,
    ).toBe(true);

    // ─── implement (any-fresh, branchActivity slack window) ─────────────────
    // lastActivity stale but branchActivity within 1440 → not stale.
    expect(
      scoreStaleness(
        { lastActivityMinutes: 9999, branchActivityMinutes: 600 },
        topology.phases.implement.staleness,
      ).isStale,
    ).toBe(false);
    // Both stale → stale.
    expect(
      scoreStaleness(
        { lastActivityMinutes: 9999, branchActivityMinutes: 99_999 },
        topology.phases.implement.staleness,
      ).isStale,
    ).toBe(true);

    // ─── review (all-fresh, three signals) ─────────────────────────────────
    // All three fresh → not stale.
    expect(
      scoreStaleness(
        {
          lastActivityMinutes: 60,
          phaseTransitionMinutes: 60,
          branchActivityMinutes: 60,
        },
        topology.phases.review.staleness,
      ).isStale,
    ).toBe(false);
    // branchActivity (1440-min window) ages out → stale.
    expect(
      scoreStaleness(
        {
          lastActivityMinutes: 60,
          phaseTransitionMinutes: 60,
          branchActivityMinutes: 9999,
        },
        topology.phases.review.staleness,
      ).isStale,
    ).toBe(true);

    // ─── scaffolding (no contract → fallback) ──────────────────────────────
    // Default 14-day threshold: 1000min < 20160 → not stale.
    expect(
      scoreStaleness(
        { lastActivityMinutes: 1000 },
        topology.phases.scaffolding.staleness,
      ).isStale,
    ).toBe(false);
    // 99_999min > 20160 → stale.
    expect(
      scoreStaleness(
        { lastActivityMinutes: 99_999 },
        topology.phases.scaffolding.staleness,
      ).isStale,
    ).toBe(true);

    // ─── orphan (no contract → fallback, with explicit caller threshold) ───
    expect(
      scoreStaleness(
        { lastActivityMinutes: 100, thresholdMinutes: 60 },
        topology.phases.orphan.staleness,
      ).isStale,
    ).toBe(true);
    expect(
      scoreStaleness(
        { lastActivityMinutes: 30, thresholdMinutes: 60 },
        topology.phases.orphan.staleness,
      ).isStale,
    ).toBe(false);
  });

  it('selecting which contract to pass at the orchestration boundary is a `topology.phases[name].staleness` lookup', async () => {
    const file = writeTopology(MULTI_PHASE_TOPOLOGY);
    const topology = await loadTopology({ topologyPath: file });

    // The orchestration coordinator (T58 wiring) will route per-phase
    // calls through this exact lookup. Asserting the lookup shape here
    // pins the contract surface T58 has to integrate with.
    const phasesUnderTest: ReadonlyArray<{ phase: string; expectStale: boolean; state: Parameters<typeof scoreStaleness>[0] }> = [
      { phase: 'design', expectStale: false, state: { lastActivityMinutes: 5, phaseTransitionMinutes: 5 } },
      { phase: 'implement', expectStale: false, state: { lastActivityMinutes: 5, branchActivityMinutes: 5 } },
      { phase: 'scaffolding', expectStale: false, state: { lastActivityMinutes: 5 } },
      { phase: 'orphan', expectStale: false, state: { lastActivityMinutes: 5 } },
    ];

    for (const { phase, expectStale, state } of phasesUnderTest) {
      const contract = topology.phases[phase].staleness;
      const result = scoreStaleness(state, contract);
      expect({ phase, isStale: result.isStale }).toEqual({ phase, isStale: expectStale });
    }
  });
});
