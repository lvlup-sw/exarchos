/**
 * Builds the reachability graph from the live authorities and writes
 * `generated/reachability-graph.json`, so a diff shows each closure change. A test fails when
 * the checked-in graph differs from a fresh build. To regenerate it under Node, run
 * `node src/contract/reachability/regenerate.mjs`, which adds the `bun:sqlite` alias.
 *
 * `collectReachabilityInputs()` compiles the live contract and checks the effect providers. Thus
 * a blocked authority or a stale provider throws before the write.
 */

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

/** The checked-in reachability graph baseline. */
export const REACHABILITY_GRAPH_FILE = path.resolve(GENERATED_DIR, 'reachability-graph.json');

/** Build the live reachability graph from the real authorities. */
export function buildLiveReachabilityGraph(opts?: CollectOptions): ReachabilityGraph {
  return buildReachabilityGraph(collectReachabilityInputs(opts));
}

/** The canonical serialization that the generator writes to disk. */
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

/** Writes the reachability graph baseline to `generated/`. */
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

/** True when this module is the process entry. Importing the module thus writes no file. */
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
