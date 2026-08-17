// ─── Reachability-graph generator / drift baseline (P05-05) ──────────────────
//
// PROGRAM-05, the closure capstone (CTR-013). Builds the reachability graph from
// the live authorities and writes the checked-in artifact
// (`generated/reachability-graph.json`) so closure is reviewable in a diff — the
// same "regenerate + review" gesture as P03-01's authority lock and P03-03's
// proof-fixture baseline. The co-located `generated.test.ts` fails when the
// checked-in graph drifts from a fresh build; running this generator is the
// re-approval gesture.
//
// Generation is GATED end-to-end: `collectReachabilityInputs()` compiles the
// live contract (which runs the P03-01 authority freeze) and validates the
// effect-provider map against the live ledger, so a blocked authority or a stale
// provider throws HERE rather than writing a stale graph.
//
// Usage (from servers/exarchos-mcp):
//   npx tsx src/contract/reachability/generate.ts
// ────────────────────────────────────────────────────────────────────────────

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { collectReachabilityInputs, type CollectOptions } from './collect.js';
import {
  buildReachabilityGraph,
  serializeReachabilityGraph,
  type ReachabilityGraph,
} from './graph.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** The checked-in generated-artifact directory. */
export const GENERATED_DIR = path.resolve(HERE, 'generated');

/** The checked-in reachability-graph baseline (the reviewable closure artifact). */
export const REACHABILITY_GRAPH_FILE = path.resolve(GENERATED_DIR, 'reachability-graph.json');

/** Build the live reachability graph from the real authorities. */
export function buildLiveReachabilityGraph(opts?: CollectOptions): ReachabilityGraph {
  return buildReachabilityGraph(collectReachabilityInputs(opts));
}

/** The canonical, byte-stable serialization written to disk (trailing newline). */
export function serializedGraphBaseline(opts?: CollectOptions): string {
  return serializeReachabilityGraph(buildLiveReachabilityGraph(opts));
}

export interface GenerateResult {
  readonly graphFile: string;
  readonly contentDigest: string;
  readonly fullyClosed: boolean;
  readonly totalActions: number;
  readonly closedActions: number;
}

/** Regenerate + write the checked-in reachability-graph baseline. */
export function generateReachabilityArtifact(opts?: CollectOptions): GenerateResult {
  const graph = buildLiveReachabilityGraph(opts);
  fs.mkdirSync(GENERATED_DIR, { recursive: true });
  fs.writeFileSync(REACHABILITY_GRAPH_FILE, serializeReachabilityGraph(graph), 'utf8');
  return {
    graphFile: REACHABILITY_GRAPH_FILE,
    contentDigest: graph.contentDigest,
    fullyClosed: graph.summary.fullyClosed,
    totalActions: graph.summary.totalActions,
    closedActions: graph.summary.closedActions,
  };
}

// Executed only when run directly (never on import) so importing this module in
// a test has no filesystem side effect (mirrors `compiler/generate.ts`).
function invokedDirectly(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return fs.realpathSync(entry) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  const result = generateReachabilityArtifact();
  process.stdout.write(`wrote reachability graph: ${result.graphFile}\n`);
  process.stdout.write(`content digest: ${result.contentDigest}\n`);
  process.stdout.write(
    `closure: ${result.closedActions}/${result.totalActions} actions closed ` +
      `(fullyClosed=${result.fullyClosed})\n`,
  );
}
