/**
 * T43 — ACCEPTANCE: phase contract loader + scorer (DR-7, v2.11 hard-cut).
 *
 * Validates DR-7 end-to-end on the v2.11 hard-cut surface:
 *   - typed `loadTopology()` parses `topology.yaml` into immutable `Topology`
 *   - pruner `scoreStaleness(state, contract)` honors typed contract:
 *       reduces over declared signals per `freshnessRequires`
 *   - missing `staleness` block on any phase → loader THROWS (covered by
 *     `loader.dr7-removal.test.ts`); the v2.10 advisory-fallback path
 *     (`phase.contract_missing` emit + single-signal heuristic) was
 *     removed in Phase 5c.
 *
 * Single fixture: complete contracts (every phase declares staleness).
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

    // Every phase has a typed contract.
    expect(topology.phases.design.staleness).toBeDefined();
    expect(topology.phases.implement.staleness).toBeDefined();

    // Scorer with `freshnessRequires: 'all'`: stale iff ANY declared signal is stale.
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

    // Scorer with `freshnessRequires: 'any'`: stale iff ALL declared signals stale.
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

    // v2.11 (DR-7): topology with any phase missing `staleness` is
    // rejected at load time. The aggregated error names every offending
    // phase ID for INV-5a self-correction.
    await expect(
      loadTopology({ topologyPath: path.join(tmp, 'topology.yaml') }),
    ).rejects.toThrow(/implement[\s\S]*review|review[\s\S]*implement/);
  });
});
