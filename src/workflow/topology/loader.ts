/**
 * Typed phase-contract loader. `loadTopology()` parses `topology.yaml` once at
 * startup into a frozen, typed `Topology`. `getTopology()` returns it after
 * that.
 *
 * Every phase must declare a typed `staleness` block. The load rejects a
 * topology with phases that have no `staleness`, and the error names each of
 * those phases. The topology path is an explicit option, so a test can load
 * the module in isolation. `dispatch/core/context.ts` passes the production
 * path.
 */
import * as fs from 'node:fs/promises';
import { parse as parseYaml } from 'yaml';
import { logger } from '../../logger.js';
import { TopologySchema, type Topology } from './phase-contract.js';

const topologyLogger = logger.child({ subsystem: 'topology' });

export interface LoadTopologyOptions {
  /** Absolute path to `topology.yaml`. */
  topologyPath: string;
}

let cached: Topology | undefined;

/**
 * The shared Promise of the in-flight first load, so concurrent first loads
 * parse and validate `topology.yaml` once. The first caller sets it before any
 * await. A rejection clears it, so a transient I/O failure does not block every
 * later load.
 */
let loadingPromise: Promise<Topology> | undefined;

let explicitTopologyRequested = false;

/**
 * Recursively freeze a topology object. `Object.freeze` is shallow, and callers
 * must not change `phases` or a nested `staleness` block.
 */
function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value;
  for (const key of Object.keys(value as object)) {
    deepFreeze((value as Record<string, unknown>)[key]);
  }
  return Object.freeze(value);
}

/**
 * Load, validate, and cache the topology. It collects every phase without a
 * `staleness` block before it throws, so one startup attempt shows the full
 * repair set in a stable order.
 */
export async function loadTopology(options: LoadTopologyOptions): Promise<Topology> {
  explicitTopologyRequested = true;
  if (cached !== undefined) return cached;
  if (loadingPromise !== undefined) return loadingPromise;

  const inflight = (async (): Promise<Topology> => {
    const raw = await fs.readFile(options.topologyPath, 'utf-8');
    const parsed = parseYaml(raw) as unknown;
    const topology = TopologySchema.parse(parsed);

    const missingPhaseNames: string[] = [];
    for (const [phaseName, phaseEntry] of Object.entries(topology.phases)) {
      if (phaseEntry.staleness === undefined) {
        missingPhaseNames.push(phaseName);
      }
    }

    if (missingPhaseNames.length > 0) {
      const message =
        `Topology validation failed (DR-7): ${missingPhaseNames.length} phase(s) ` +
        `missing required \`staleness\` contract: ${missingPhaseNames.join(', ')}. ` +
        `Add a \`staleness\` block to each listed phase in topology.yaml ` +
        `(declare \`expectedMaxDwellMinutes\`, \`signals\`, and \`freshnessRequires\`).`;
      topologyLogger.error(
        { missingPhases: missingPhaseNames, count: missingPhaseNames.length },
        message,
      );
      throw new Error(message);
    }

    cached = deepFreeze(topology);
    return cached;
  })();
  loadingPromise = inflight;
  try {
    return await inflight;
  } catch (err) {
    loadingPromise = undefined;
    throw err;
  }
}

/**
 * Synchronous accessor for the loaded topology after startup. It throws when
 * `loadTopology()` has not run, so lifecycle wiring stays explicit and no read
 * loads the topology lazily.
 */
export function getTopology(): Topology {
  if (cached === undefined) {
    throw new Error(
      'Topology not loaded: call loadTopology() before getTopology() (lifecycle wires this at startup; see DR-7 / T58).',
    );
  }
  return cached;
}

/**
 * True once a caller has asked `loadTopology()` for a topology file, whether
 * or not the load succeeded. Staleness scoring reads it to tell a project with
 * no topology file from a project whose topology file failed to load.
 */
export function isExplicitTopologyRequested(): boolean {
  return explicitTopologyRequested;
}

/** Test-only cache reset. Not exported through the package barrel. */
export function __resetTopologyCacheForTesting(): void {
  cached = undefined;
  loadingPromise = undefined;
  explicitTopologyRequested = false;
}
