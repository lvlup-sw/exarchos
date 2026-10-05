import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import {
  REACHABILITY_GRAPH_FILE,
  buildLiveReachabilityGraph,
  serializedGraphBaseline,
} from '../../../../src/contract/reachability/generate.js';
import { serializeReachabilityGraph } from '../../../../src/contract/reachability/graph.js';

/**
 * The checked-in reachability graph is the closure artifact that a reviewer reads. A change to
 * the registry, the bindings, the effect ledger or the contract surface fails this guard.
 * `node src/contract/reachability/regenerate.mjs` regenerates the baseline.
 */
describe('generated reachability graph — drift guard', () => {
  it('the checked-in baseline matches a fresh build of the live graph', () => {
    const onDisk = fs.readFileSync(REACHABILITY_GRAPH_FILE, 'utf8');
    expect(serializedGraphBaseline()).toBe(onDisk);
  });

  it('regeneration is byte-stable (the determinism exit proof at the artifact boundary)', () => {
    expect(serializedGraphBaseline()).toBe(serializedGraphBaseline());
  });

  it('serializes byte-identically from a re-built graph object', () => {
    const graph = buildLiveReachabilityGraph();
    expect(serializeReachabilityGraph(graph)).toBe(fs.readFileSync(REACHABILITY_GRAPH_FILE, 'utf8'));
  });

  it('the checked-in graph is fully closed with a well-formed content digest', () => {
    const graph = buildLiveReachabilityGraph();
    expect(graph.summary.fullyClosed).toBe(true);
    expect(graph.contentDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
});
