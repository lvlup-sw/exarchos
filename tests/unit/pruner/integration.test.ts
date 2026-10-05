/**
 * Loads a topology from YAML and scores it through the pure scoring layer of the
 * pruner. The fixture covers both `freshnessRequires` modes, `all` and `any`.
 * The loader throws on a phase with no `staleness` block, so each fixture phase
 * declares a contract. `pruner.dr7-removal.test.ts` covers a phase with no contract.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  loadTopology,
  __resetTopologyCacheForTesting,
} from '../../../src/workflow/topology/loader.js';
import { scoreStaleness } from '../../../src/pruner/score.js';

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

  /**
   * Each phase gets one fresh state and one stale state. `design` and `review`
   * need every signal fresh. `implement` needs one fresh signal, and `branchActivity`
   * inside its 1440-minute threshold keeps the phase fresh after `lastActivity` is stale.
   */
  it('routes per-phase scoring through the typed contract', async () => {
    const file = writeTopology(MULTI_PHASE_TOPOLOGY);
    const topology = await loadTopology({ topologyPath: file });

    expect(
      scoreStaleness(
        { lastActivityMinutes: 30, phaseTransitionMinutes: 30 },
        topology.phases.design.staleness!,
      ).isStale,
    ).toBe(false);
    expect(
      scoreStaleness(
        { lastActivityMinutes: 30, phaseTransitionMinutes: 9999 },
        topology.phases.design.staleness!,
      ).isStale,
    ).toBe(true);

    expect(
      scoreStaleness(
        { lastActivityMinutes: 9999, branchActivityMinutes: 600 },
        topology.phases.implement.staleness!,
      ).isStale,
    ).toBe(false);
    expect(
      scoreStaleness(
        { lastActivityMinutes: 9999, branchActivityMinutes: 99_999 },
        topology.phases.implement.staleness!,
      ).isStale,
    ).toBe(true);

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
