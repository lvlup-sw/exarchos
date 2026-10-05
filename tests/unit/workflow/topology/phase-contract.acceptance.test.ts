/**
 * Acceptance test for the phase contract loader and scorer.
 *
 * - `loadTopology()` parses `topology.yaml` into a frozen `Topology`.
 * - `scoreStaleness(state, contract)` reduces over the declared signals per `freshnessRequires`.
 * - A phase without a `staleness` block makes the loader throw. `loader.dr7-removal.test.ts` covers the detail.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { loadTopology, __resetTopologyCacheForTesting } from '../../../../src/workflow/topology/loader.js';
import { scoreStaleness } from '../../../../src/pruner/score.js';

interface CapturedEvent {
  streamId: string;
  type: string;
  data: unknown;
}

function writeTopologyFile(dir: string, body: string): string {
  const file = path.join(dir, 'topology.yaml');
  fs.writeFileSync(file, body, 'utf-8');
  return file;
}

describe('PhaseContract_LoaderAndScorer_HonorsTypedContractAndEmitsMissingEvent', () => {
  /**
   * With `freshnessRequires: 'all'`, a phase is stale when any declared signal is stale.
   * With `'any'`, a phase is stale only when all declared signals are stale.
   */
  it('complete contracts: pruner uses contract; scorer reduces over declared signals; no missing-event', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'phase-contract-acc-complete-'));
    const yaml = `
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
      expectedMaxDwellMinutes: 120
      freshnessRequires: any
      signals:
        - name: lastActivity
          thresholdMinutes: 120
        - name: branchActivity
          thresholdMinutes: 120
`;
    writeTopologyFile(tmp, yaml);
    __resetTopologyCacheForTesting();
    const topology = await loadTopology({ topologyPath: path.join(tmp, 'topology.yaml') });

    expect(topology.phases.design.staleness).toBeDefined();
    expect(topology.phases.implement.staleness).toBeDefined();

    const designContract = topology.phases.design.staleness!;
    const allFresh = scoreStaleness(
      {
        lastActivityMinutes: 10,
        phaseTransitionMinutes: 10,
      },
      designContract,
    );
    expect(allFresh.isStale).toBe(false);

    const oneStale = scoreStaleness(
      {
        lastActivityMinutes: 10,
        phaseTransitionMinutes: 9999,
      },
      designContract,
    );
    expect(oneStale.isStale).toBe(true);

    const implementContract = topology.phases.implement.staleness!;
    const anyFresh = scoreStaleness(
      {
        lastActivityMinutes: 9999,
        branchActivityMinutes: 10,
      },
      implementContract,
    );
    expect(anyFresh.isStale).toBe(false);

    const allStale = scoreStaleness(
      {
        lastActivityMinutes: 9999,
        branchActivityMinutes: 9999,
      },
      implementContract,
    );
    expect(allStale.isStale).toBe(true);
  });

  /** The error names every phase without a `staleness` block. */
  it('partial contracts: loader THROWS (v2.11 hard-cut); no advisory-fallback path remains', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'phase-contract-acc-partial-'));
    const yaml = `
phases:
  design:
    staleness:
      expectedMaxDwellMinutes: 60
      freshnessRequires: all
      signals:
        - name: lastActivity
          thresholdMinutes: 60
  implement: {}
  review: {}
`;
    writeTopologyFile(tmp, yaml);
    __resetTopologyCacheForTesting();

    await expect(
      loadTopology({ topologyPath: path.join(tmp, 'topology.yaml') }),
    ).rejects.toThrow(/implement[\s\S]*review|review[\s\S]*implement/);
  });
});
