/**
 * Typed phase-contract loader (DR-7).
 *
 * Exposes `loadTopology()` for one-time-at-startup parsing of
 * `topology.yaml` into a frozen, typed `Topology` object, and
 * `getTopology()` for subsequent in-process accessors.
 *
 * Design notes:
 *   - The loader is testable in isolation: the canonical topology path
 *     and an event emitter are explicit options, not hard-coded
 *     dependencies. T58 (Phase 8) wires this into `lifecycle.ts` with
 *     the production path and the canonical event store.
 *   - `phase.contract_missing` is emitted exactly once per phase missing
 *     a `staleness` block on first successful load. Repeat calls return
 *     the cached topology and do not re-emit.
 */
import * as fs from 'node:fs/promises';
import { parse as parseYaml } from 'yaml';
import { logger } from '../logger.js';
import { TopologySchema, type Topology } from './phase-contract.js';

const topologyLogger = logger.child({ subsystem: 'topology' });

/**
 * Minimal event-emission shape — caller (lifecycle wiring) supplies an
 * adapter over `EventStore.append`. Kept structural so unit tests pass
 * an in-memory sink.
 */
export type TopologyEventEmitter = (
  streamId: string,
  event: { type: 'phase.contract_missing'; data: { phaseName: string } },
) => Promise<void>;

export interface LoadTopologyOptions {
  /** Absolute path to `topology.yaml`. T58 supplies the project default. */
  topologyPath: string;
  /**
   * Optional event emitter. When present, the loader emits
   * `phase.contract_missing` once per missing-contract phase on first
   * load. Absent → emission is a no-op (loader stays usable in pure
   * unit contexts that don't need the event side effect).
   */
  emit?: TopologyEventEmitter;
}

let cached: Topology | undefined;

/** Stream ID for substrate-level events emitted at startup. */
const STARTUP_STREAM = '_substrate';

/**
 * Recursively freeze a topology object. `Object.freeze` is shallow, but
 * the design contract is "immutable Topology object" — callers must not
 * mutate `phases` or any nested `staleness` block.
 */
function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value;
  for (const key of Object.keys(value as object)) {
    deepFreeze((value as Record<string, unknown>)[key]);
  }
  return Object.freeze(value);
}

export async function loadTopology(options: LoadTopologyOptions): Promise<Topology> {
  if (cached !== undefined) return cached;

  const raw = await fs.readFile(options.topologyPath, 'utf-8');
  const parsed = parseYaml(raw) as unknown;
  const topology = TopologySchema.parse(parsed);

  // Walk phases once. Collect names missing the `staleness` block so we
  // can both:
  //   - emit `phase.contract_missing` per missing phase (when an event
  //     sink is wired — T58 supplies it from lifecycle); and
  //   - surface a single warn-level log line listing every missing
  //     phase, so operators see the gap even when running in a context
  //     without an event sink (CLI dry-runs, test harnesses).
  //
  // We build the list before any `await` to keep the per-phase emission
  // order deterministic.
  const missingPhaseNames: string[] = [];
  for (const [phaseName, phaseEntry] of Object.entries(topology.phases)) {
    if (phaseEntry.staleness === undefined) {
      missingPhaseNames.push(phaseName);
    }
  }

  if (missingPhaseNames.length > 0) {
    topologyLogger.warn(
      { missingPhases: missingPhaseNames, count: missingPhaseNames.length },
      'phase.contract_missing — phases lack typed staleness contracts; pruner falls back to single-signal heuristic',
    );
  }

  if (options.emit) {
    for (const phaseName of missingPhaseNames) {
      await options.emit(STARTUP_STREAM, {
        type: 'phase.contract_missing',
        data: { phaseName },
      });
    }
  }

  cached = deepFreeze(topology);
  return cached;
}

/**
 * Synchronous accessor for code that needs the loaded topology after
 * startup. Throws if `loadTopology()` has not yet been called — forces
 * lifecycle wiring to be explicit (T58) rather than allowing silent
 * lazy-load on first read.
 */
export function getTopology(): Topology {
  if (cached === undefined) {
    throw new Error(
      'Topology not loaded: call loadTopology() before getTopology() (lifecycle wires this at startup; see DR-7 / T58).',
    );
  }
  return cached;
}

/** Test-only cache reset. Not exported through the package barrel. */
export function __resetTopologyCacheForTesting(): void {
  cached = undefined;
}
