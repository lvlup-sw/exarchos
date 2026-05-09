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
