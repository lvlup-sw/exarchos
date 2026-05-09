/**
 * T44 — Topology loader unit tests.
 *
 * Asserts that `loadTopology()`:
 *   - reads and parses `topology.yaml` through the typed Zod schema
 *   - returns an immutable (frozen) `Topology` object
 *   - caches the result so subsequent calls return the same instance
 *   - exposes `getTopology()` accessor that throws when called before load
 *
 * The loader takes the path as an explicit option to keep the module
 * testable in isolation. T58 (Phase 8) will wire this into `lifecycle.ts`
 * with the canonical project topology path.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  loadTopology,
  getTopology,
  __resetTopologyCacheForTesting,
} from './loader.js';

interface CapturedEvent {
  streamId: string;
  type: string;
  data: unknown;
}

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

function writeTopology(yamlBody: string): string {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'topology-loader-'));
  const file = path.join(tmp, 'topology.yaml');
  fs.writeFileSync(file, yamlBody, 'utf-8');
  return file;
}

const COMPLETE_TOPOLOGY = `
phases:
  design:
    staleness:
      expectedMaxDwellMinutes: 60
      freshnessRequires: all
      signals:
        - name: lastActivity
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

describe('TopologyLoader_LoadOnce_ReturnsImmutableTopology', () => {
  beforeEach(() => {
    __resetTopologyCacheForTesting();
  });

  it('reads topology.yaml, parses through Zod, returns frozen object', async () => {
    const file = writeTopology(COMPLETE_TOPOLOGY);
    const topology = await loadTopology({ topologyPath: file });

    expect(topology).toBeDefined();
    expect(topology.phases.design.staleness?.expectedMaxDwellMinutes).toBe(60);
    expect(topology.phases.implement.staleness?.freshnessRequires).toBe('any');

    // Object is frozen.
    expect(Object.isFrozen(topology)).toBe(true);
    expect(Object.isFrozen(topology.phases)).toBe(true);
    expect(Object.isFrozen(topology.phases.design)).toBe(true);

    // Mutation attempts are silently ignored or throw in strict mode.
    expect(() => {
      // Cast through unknown to bypass readonly types — runtime freeze should reject the write.
      (topology.phases as unknown as Record<string, unknown>).newPhase = {};
    }).toThrow();
  });

  it('subsequent calls return the same cached instance', async () => {
    const file = writeTopology(COMPLETE_TOPOLOGY);
    const a = await loadTopology({ topologyPath: file });
    const b = await loadTopology({ topologyPath: file });
    expect(b).toBe(a);
  });

  it('getTopology() throws when called before loadTopology()', () => {
    expect(() => getTopology()).toThrow(/load.*before/i);
  });

  it('getTopology() returns the cached topology after loadTopology()', async () => {
    const file = writeTopology(COMPLETE_TOPOLOGY);
    const loaded = await loadTopology({ topologyPath: file });
    expect(getTopology()).toBe(loaded);
  });
});

// ─── T47: phase.contract_missing emission on load ─────────────────────────────

const PARTIAL_TOPOLOGY = `
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

describe('Topology_StartupWithMissingContracts_EmitsPhaseContractMissingPerPhaseOnce', () => {
  beforeEach(() => {
    __resetTopologyCacheForTesting();
  });

  it('emits phase.contract_missing exactly once per phase missing the staleness block', async () => {
    const file = writeTopology(PARTIAL_TOPOLOGY);
    const sink = makeEventSink();
    await loadTopology({ topologyPath: file, emit: sink.emit });

    const missing = sink.events.filter((e) => e.type === 'phase.contract_missing');
    expect(missing).toHaveLength(2);
    const phaseNames = missing.map((e) => (e.data as { phaseName: string }).phaseName).sort();
    expect(phaseNames).toEqual(['implement', 'review']);
  });

  it('subsequent calls within the same process do NOT re-emit', async () => {
    const file = writeTopology(PARTIAL_TOPOLOGY);
    const sink = makeEventSink();
    await loadTopology({ topologyPath: file, emit: sink.emit });
    await loadTopology({ topologyPath: file, emit: sink.emit });
    await loadTopology({ topologyPath: file, emit: sink.emit });

    const missing = sink.events.filter((e) => e.type === 'phase.contract_missing');
    expect(missing).toHaveLength(2);
  });

  it('falls back to a no-op when no emit function is provided (loader testable in isolation)', async () => {
    const file = writeTopology(PARTIAL_TOPOLOGY);
    // Should not throw; emission silently skipped.
    const topology = await loadTopology({ topologyPath: file });
    expect(topology.phases.implement.staleness).toBeUndefined();
    expect(topology.phases.review.staleness).toBeUndefined();
  });

  it('emits no events when every phase has a contract', async () => {
    const file = writeTopology(COMPLETE_TOPOLOGY);
    const sink = makeEventSink();
    await loadTopology({ topologyPath: file, emit: sink.emit });
    expect(sink.events.filter((e) => e.type === 'phase.contract_missing')).toHaveLength(0);
  });
});

// ─── T71: concurrent first-load must not duplicate parse / emission ───────────
//
// CodeRabbit finding #11 (Major) — `loadTopology()` only checks the `cached`
// field. Two concurrent first-time callers can both pass the `!cached` check,
// both parse `topology.yaml`, and both emit `phase.contract_missing` per
// missing phase before either assigns `cached`. INV-1 says the same trigger
// (one startup) must yield the same number of events; the race violates this.
//
// Fix mirrors T63's Promise-cached singleton pattern in `atomic-appender.ts`.
describe('Topology_ConcurrentFirstLoad_DoesNotDuplicateContractMissingEmission', () => {
  beforeEach(() => {
    __resetTopologyCacheForTesting();
  });

  it('two concurrent loadTopology() calls emit phase.contract_missing exactly once per missing phase', async () => {
    const file = writeTopology(PARTIAL_TOPOLOGY);
    const sink = makeEventSink();

    const [a, b] = await Promise.all([
      loadTopology({ topologyPath: file, emit: sink.emit }),
      loadTopology({ topologyPath: file, emit: sink.emit }),
    ]);

    // Both callers see the same Topology instance (cache invariant).
    expect(b).toBe(a);

    // Two missing phases (`implement`, `review`) — exactly two emissions.
    const missing = sink.events.filter((e) => e.type === 'phase.contract_missing');
    expect(missing).toHaveLength(2);
    const phaseNames = missing.map((e) => (e.data as { phaseName: string }).phaseName).sort();
    expect(phaseNames).toEqual(['implement', 'review']);
  });

  it('N concurrent loadTopology() calls emit phase.contract_missing exactly once per missing phase', async () => {
    const file = writeTopology(PARTIAL_TOPOLOGY);
    const sink = makeEventSink();

    const N = 8;
    const results = await Promise.all(
      Array.from({ length: N }, () => loadTopology({ topologyPath: file, emit: sink.emit })),
    );

    // All callers converge on the same Topology instance.
    for (const r of results) {
      expect(r).toBe(results[0]);
    }

    // Still exactly two emissions despite N first-callers.
    const missing = sink.events.filter((e) => e.type === 'phase.contract_missing');
    expect(missing).toHaveLength(2);
  });
});
