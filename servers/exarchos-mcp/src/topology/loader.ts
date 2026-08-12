/**
 * Typed phase-contract loader (DR-7, v2.11 hard-cut).
 *
 * Exposes `loadTopology()` for one-time-at-startup parsing of
 * `topology.yaml` into a frozen, typed `Topology` object, and
 * `getTopology()` for subsequent in-process accessors.
 *
 * v2.11 (DR-7) semantics:
 *   - Every phase MUST declare a typed `staleness` block. Topology sources
 *     containing one or more phases without `staleness` are REJECTED at
 *     load time with a structured `Error` aggregating every offending
 *     phase ID and an INV-5a self-correction breadcrumb.
 *   - The pre-v2.11 advisory branch (warn-and-emit `phase.contract_missing`
 *     with single-signal heuristic fallback in the pruner) was removed in
 *     this phase. The event TYPE remains registered in `events/schemas.ts`
 *     for replay of v2.10-era events; the loader no longer emits it.
 *
 * Design notes:
 *   - The loader is testable in isolation: the canonical topology path
 *     is an explicit option, not a hard-coded dependency. `core/context.ts`
 *     wires this into `initializeContext()` with the production path.
 */
import * as fs from 'node:fs/promises';
import { parse as parseYaml } from 'yaml';
import { logger } from '../logger.js';
import { TopologySchema, type Topology } from './phase-contract.js';

const topologyLogger = logger.child({ subsystem: 'topology' });

export interface LoadTopologyOptions {
  /** Absolute path to `topology.yaml`. T58 supplies the project default. */
  topologyPath: string;
}

let cached: Topology | undefined;

/**
 * Promise-cached singleton for the in-flight first-load (T71).
 *
 * Concurrent first-loads share this Promise to avoid:
 *   - duplicate `topology.yaml` parse + Zod validation work, and
 *   - duplicate `phase.contract_missing` emissions per missing phase
 *     (CodeRabbit finding #11; INV-1 violation — the same startup
 *     trigger must produce the same event count).
 *
 * Pattern mirrors `atomic-appender.ts`'s `sqliteBackendPromise`
 * (T63): the first caller assigns this field SYNCHRONOUSLY before any
 * await, so all concurrent callers converge on a single Promise. Once
 * the Promise resolves, `cached` is populated and the cached path
 * short-circuits; on rejection the Promise is cleared so the next
 * caller can retry from a clean slate (transient I/O failures must
 * not permanently poison the loader).
 */
let loadingPromise: Promise<Topology> | undefined;

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
  // Concurrent first-load short-circuit (T71). If another caller is
  // already mid-flight, await the same Promise instead of re-parsing
  // and re-emitting `phase.contract_missing`. See the singleton
  // invariant on `loadingPromise` above.
  if (loadingPromise !== undefined) return loadingPromise;

  // Build the in-flight Promise SYNCHRONOUSLY before any await. This
  // is the single point where the singleton invariant is enforced —
  // any sibling caller arriving between here and resolution sees a
  // non-undefined `loadingPromise` and converges on this same handle.
  const inflight = (async (): Promise<Topology> => {
    const raw = await fs.readFile(options.topologyPath, 'utf-8');
    const parsed = parseYaml(raw) as unknown;
    const topology = TopologySchema.parse(parsed);

    // DR-7 v2.11 hard-cut — aggregate ALL phases lacking a `staleness`
    // block, then THROW. Pre-v2.11 the loader logged a warn line and
    // emitted `phase.contract_missing` advisory events; both branches
    // are gone. Operators must repair every offending phase before
    // startup proceeds.
    //
    // We aggregate (not first-fail) so a single startup attempt surfaces
    // the entire repair set — INV-5a self-correction breadcrumb. The
    // ordered walk over `Object.entries(topology.phases)` keeps the
    // error-message phase order deterministic for snapshot-style tests.
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
    // Clear the cached Promise so a subsequent call can retry from a
    // clean slate. Without this, a transient parse / I/O failure
    // would permanently poison the loader.
    loadingPromise = undefined;
    throw err;
  }
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
  loadingPromise = undefined;
}
