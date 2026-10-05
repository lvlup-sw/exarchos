/**
 * Unit tests for `loadTopology()`. The loader:
 * - parses `topology.yaml` through the typed Zod schema
 * - returns a frozen `Topology` object
 * - caches the result, so later calls return the same instance
 * - exposes `getTopology()`, which throws before the first load
 *
 * The loader takes the path as an explicit option, so the tests can run it in isolation.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  loadTopology,
  getTopology,
  __resetTopologyCacheForTesting,
} from '../../../../src/workflow/topology/loader.js';

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

  /** The cast bypasses the readonly types, so the runtime freeze is what rejects the write. The write throws because an ES module runs in strict mode. */
  it('reads topology.yaml, parses through Zod, returns frozen object', async () => {
    const file = writeTopology(COMPLETE_TOPOLOGY);
    const topology = await loadTopology({ topologyPath: file });

    expect(topology).toBeDefined();
    expect(topology.phases.design.staleness?.expectedMaxDwellMinutes).toBe(60);
    expect(topology.phases.implement.staleness?.freshnessRequires).toBe('any');

    expect(Object.isFrozen(topology)).toBe(true);
    expect(Object.isFrozen(topology.phases)).toBe(true);
    expect(Object.isFrozen(topology.phases.design)).toBe(true);

    expect(() => {
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

/** Concurrent first loads of a well-formed topology share one cached Promise and return one `Topology` instance. */
describe('Topology_ConcurrentFirstLoad_SharesPromiseAndReturnsOneInstance', () => {
  beforeEach(() => {
    __resetTopologyCacheForTesting();
  });

  it('N concurrent loadTopology() calls converge on the same cached Topology instance', async () => {
    const file = writeTopology(COMPLETE_TOPOLOGY);

    const N = 8;
    const results = await Promise.all(
      Array.from({ length: N }, () => loadTopology({ topologyPath: file })),
    );

    for (const r of results) {
      expect(r).toBe(results[0]);
    }
  });
});
