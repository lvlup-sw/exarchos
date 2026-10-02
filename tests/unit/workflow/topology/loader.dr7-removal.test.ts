/**
 * The topology loader must throw when any phase lacks a `staleness` block.
 *
 * The thrown error must:
 * - name every phase without the block, so the operator can repair all of them after one startup attempt.
 * - tell the operator to add the `staleness` block.
 *
 * Malformed topology is a startup-blocking error. The loader has no advisory branch, no heuristic fallback, and no emit option.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { loadTopology, __resetTopologyCacheForTesting } from '../../../../src/workflow/topology/loader.js';

function writeTopology(yamlBody: string): string {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'topology-loader-dr7-'));
  const file = path.join(tmp, 'topology.yaml');
  fs.writeFileSync(file, yamlBody, 'utf-8');
  return file;
}

describe('Topology_LoadWithMissingContracts_ThrowsAndAggregatesPhaseIds_DR7', () => {
  beforeEach(() => {
    __resetTopologyCacheForTesting();
  });

  it('throws when any phase lacks a staleness block, naming the offending phase', async () => {
    const file = writeTopology(`
phases:
  design:
    staleness:
      expectedMaxDwellMinutes: 60
      freshnessRequires: all
      signals:
        - name: lastActivity
          thresholdMinutes: 60
  implement: {}
`);
    await expect(loadTopology({ topologyPath: file })).rejects.toThrow(/implement/);
  });

  it('aggregates ALL missing phase IDs in the thrown error (not first-fail)', async () => {
    const file = writeTopology(`
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
  cleanup: {}
`);
    await expect(loadTopology({ topologyPath: file })).rejects.toThrow(
      /implement[\s\S]*review[\s\S]*cleanup|review[\s\S]*implement|cleanup[\s\S]*implement/,
    );
    let err: unknown;
    try {
      __resetTopologyCacheForTesting();
      await loadTopology({ topologyPath: file });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(Error);
    const message = (err as Error).message;
    expect(message).toContain('implement');
    expect(message).toContain('review');
    expect(message).toContain('cleanup');
  });

  it('includes an INV-5a self-correction breadcrumb instructing operator to add staleness blocks', async () => {
    const file = writeTopology(`
phases:
  implement: {}
`);
    let err: unknown;
    try {
      await loadTopology({ topologyPath: file });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(Error);
    const message = (err as Error).message;
    expect(message.toLowerCase()).toContain('staleness');
  });

  it('still loads a complete topology (every phase has a staleness block) without throwing', async () => {
    const file = writeTopology(`
phases:
  design:
    staleness:
      expectedMaxDwellMinutes: 60
      freshnessRequires: all
      signals:
        - name: lastActivity
          thresholdMinutes: 60
`);
    const topology = await loadTopology({ topologyPath: file });
    expect(topology.phases.design.staleness).toBeDefined();
  });
});
