/**
 * T43 — ACCEPTANCE: phase contract loader + scorer + missing-event emission.
 *
 * Validates DR-7 end-to-end:
 *   - typed `loadTopology()` parses `topology.yaml` into immutable `Topology`
 *   - pruner `scoreStaleness(state, contract)` honors typed contract when
 *     present (reduces over declared signals per `freshnessRequires`)
 *   - missing `staleness` block falls back to v2.9 single-signal heuristic
 *   - `phase.contract_missing` is emitted once per missing phase at load
 *
 * Two fixtures: complete contracts (every phase declares staleness) and
 * partial contracts (some declare, some don't). Reuses the loader and
 * scorer modules from T44–T48. T58 will wire the loader into
 * `lifecycle.ts`; this acceptance test exercises the modules directly.
 *
 * Kept RED until T44+T45+T46+T47+T48 are GREEN.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { loadTopology, __resetTopologyCacheForTesting } from './loader.js';
import { scoreStaleness } from '../pruner/score.js';

interface CapturedEvent {
  streamId: string;
  type: string;
  data: unknown;
}

/** Minimal in-memory event sink — captures emissions without a real EventStore. */
function makeEventSink(): {
  events: CapturedEvent[];
  emit: (streamId: string, event: { type: string; data: unknown }) => Promise<void>;
} {
  const events: CapturedEvent[] = [];
  return {
    events,
    emit: async (streamId, event) => {
      events.push({ streamId, type: event.type, data: event.data });
    },
  };
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
    const sink = makeEventSink();
    const topology = await loadTopology({ topologyPath: path.join(tmp, 'topology.yaml'), emit: sink.emit });

    // Every phase has a typed contract.
    expect(topology.phases.design.staleness).toBeDefined();
    expect(topology.phases.implement.staleness).toBeDefined();

    // No missing-contract events when every phase has a contract.
    expect(sink.events.filter((e) => e.type === 'phase.contract_missing')).toHaveLength(0);

    // Scorer with `freshnessRequires: 'all'`: stale iff ANY declared signal is stale.
    const designContract = topology.phases.design.staleness;
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
    const implementContract = topology.phases.implement.staleness;
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

  it('partial contracts: pruner uses contract for declared phases; falls back to single-signal otherwise; emits per missing phase', async () => {
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
    const sink = makeEventSink();
    const topology = await loadTopology({ topologyPath: path.join(tmp, 'topology.yaml'), emit: sink.emit });

    // Declared phase has the contract; undeclared phases do not.
    expect(topology.phases.design.staleness).toBeDefined();
    expect(topology.phases.implement.staleness).toBeUndefined();
    expect(topology.phases.review.staleness).toBeUndefined();

    // Two missing-contract events emitted at load (one per missing phase).
    const missing = sink.events.filter((e) => e.type === 'phase.contract_missing');
    expect(missing).toHaveLength(2);
    const phaseNames = missing.map((e) => (e.data as { phaseName: string }).phaseName).sort();
    expect(phaseNames).toEqual(['implement', 'review']);

    // Scorer for declared phase uses the contract.
    const designResult = scoreStaleness(
      {
        lastActivityMinutes: 9999,
      },
      topology.phases.design.staleness,
    );
    expect(designResult.isStale).toBe(true);

    // Scorer for undeclared phase falls back to v2.9 single-signal heuristic
    // when contract is undefined: stale iff `lastActivityMinutes` exceeds the
    // caller-provided threshold (default 20160 = 14 days).
    const implementFallbackStale = scoreStaleness(
      { lastActivityMinutes: 99_999, thresholdMinutes: 60 },
      topology.phases.implement.staleness,
    );
    expect(implementFallbackStale.isStale).toBe(true);

    const implementFallbackFresh = scoreStaleness(
      { lastActivityMinutes: 10, thresholdMinutes: 60 },
      topology.phases.implement.staleness,
    );
    expect(implementFallbackFresh.isStale).toBe(false);
  });
});
