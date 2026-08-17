/**
 * T5c.1 (DR-7 hard-cut, v2.11) — Topology loader must HARD-THROW when any
 * phase lacks a `staleness` block.
 *
 * v2.10 emitted `phase.contract_missing` advisory events at startup and let
 * the pruner fall back to a single-signal heuristic. v2.11 (DR-7) removes
 * the advisory branch entirely: the loader rejects topology sources whose
 * phases do not all declare a typed `staleness` contract.
 *
 * The thrown error MUST:
 *   - name every offending phase ID (aggregated, not first-fail), so an
 *     operator who edits `topology.yaml` sees the full set of phases
 *     they need to repair on a single startup attempt;
 *   - carry an actionable instruction to add the `staleness` block
 *     (INV-5a — "agent-self-correction breadcrumb" — design 2026-05-09).
 *
 * Together these properties replace the v2.10 advisory-emit branch:
 * instead of best-effort logging + heuristic fallback, malformed topology
 * is now a startup-blocking, structurally diagnosable error.
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
    // Capture and inspect the error to assert all three are named.
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
    // The breadcrumb must instruct the operator to add a `staleness` block.
    expect(message.toLowerCase()).toContain('staleness');
  });

  // The "does NOT emit phase.contract_missing events" test from earlier
  // drafts is gone: the `emit` option itself was deleted from
  // `LoadTopologyOptions` (the loader has no emission surface to test
  // against). The throw is covered by the aggregate cases above.

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
