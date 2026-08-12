/**
 * Bundle integration test (DR-7, v2.11) — typed phase contract end-to-end
 * through the pruner's pure scoring layer.
 *
 * Uses a multi-phase topology fixture covering BOTH `freshnessRequires`
 * modes:
 *   - phases declaring `'all'` (every signal must be fresh)
 *   - phases declaring `'any'` (one fresh signal suffices)
 *
 * The v2.10 fallback path (phases without a `staleness` block routed
 * through the v2.9 single-signal heuristic) was deleted in v2.11
 * (Phase 5c, DR-7). The topology loader now throws on any phase missing
 * `staleness`, so an integration fixture must declare a contract on every
 * phase. See `pruner.dr7-removal.test.ts` for the contractless invariant.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  loadTopology,
  __resetTopologyCacheForTesting,
} from '../workflow/topology/loader.js';
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
`;

describe('pruner_integration_with_phase_contract_multi_phase_fixture', () => {
  beforeEach(() => {
    __resetTopologyCacheForTesting();
  });

  it('routes per-phase scoring through the typed contract', async () => {
    const file = writeTopology(MULTI_PHASE_TOPOLOGY);
    const topology = await loadTopology({ topologyPath: file });

    // ─── design (all-fresh) ─────────────────────────────────────────────────
    // Both signals fresh → not stale.
    expect(
      scoreStaleness(
        { lastActivityMinutes: 30, phaseTransitionMinutes: 30 },
        topology.phases.design.staleness!,
      ).isStale,
    ).toBe(false);
    // One signal stale → stale.
    expect(
      scoreStaleness(
        { lastActivityMinutes: 30, phaseTransitionMinutes: 9999 },
        topology.phases.design.staleness!,
      ).isStale,
    ).toBe(true);

    // ─── implement (any-fresh, branchActivity slack window) ─────────────────
    // lastActivity stale but branchActivity within 1440 → not stale.
    expect(
      scoreStaleness(
        { lastActivityMinutes: 9999, branchActivityMinutes: 600 },
        topology.phases.implement.staleness!,
      ).isStale,
    ).toBe(false);
    // Both stale → stale.
    expect(
      scoreStaleness(
        { lastActivityMinutes: 9999, branchActivityMinutes: 99_999 },
        topology.phases.implement.staleness!,
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
        topology.phases.review.staleness!,
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
        topology.phases.review.staleness!,
      ).isStale,
    ).toBe(true);
  });

  it('selecting which contract to pass at the orchestration boundary is a `topology.phases[name].staleness` lookup', async () => {
    const file = writeTopology(MULTI_PHASE_TOPOLOGY);
    const topology = await loadTopology({ topologyPath: file });

    const phasesUnderTest: ReadonlyArray<{
      phase: string;
      expectStale: boolean;
      state: Parameters<typeof scoreStaleness>[0];
    }> = [
      { phase: 'design', expectStale: false, state: { lastActivityMinutes: 5, phaseTransitionMinutes: 5 } },
      { phase: 'implement', expectStale: false, state: { lastActivityMinutes: 5, branchActivityMinutes: 5 } },
      { phase: 'review', expectStale: false, state: { lastActivityMinutes: 5, phaseTransitionMinutes: 5, branchActivityMinutes: 5 } },
    ];

    for (const { phase, expectStale, state } of phasesUnderTest) {
      const contract = topology.phases[phase].staleness!;
      const result = scoreStaleness(state, contract);
      expect({ phase, isStale: result.isStale }).toEqual({ phase, isStale: expectStale });
    }
  });
});
