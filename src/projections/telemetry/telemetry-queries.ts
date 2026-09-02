// ─── Telemetry Query Abstraction ──────────────────────────────────────────────
//
// Encapsulates telemetry materialization behind a query API, isolating the
// orchestrate layer from direct telemetry projection internals.
// ────────────────────────────────────────────────────────────────────────────

import { foldToTail } from '../fold-at-tail.js';
import { getOrCreateMaterializer, queryDeltaEvents } from '../views/tools.js';
import { TELEMETRY_VIEW } from './telemetry-projection.js';
import type { TelemetryViewState } from './telemetry-projection.js';
import type { EventStore } from '../../events/store.js';

// ─── Runtime Metrics Interface ───────────────────────────────────────────────

export interface RuntimeMetrics {
  readonly sessionTokens: number;
  readonly toolCount: number;
  readonly totalInvocations: number;
}

// ─── Zero Metrics Constant ───────────────────────────────────────────────────

const ZERO_METRICS: RuntimeMetrics = {
  sessionTokens: 0,
  toolCount: 0,
  totalInvocations: 0,
};

// ─── Query Functions ─────────────────────────────────────────────────────────

/**
 * Query runtime metrics from the telemetry projection.
 * Returns zero metrics on any failure (graceful degradation).
 */
export async function queryRuntimeMetrics(
  store: EventStore,
  stateDir: string,
): Promise<RuntimeMetrics> {
  try {
    const materializer = getOrCreateMaterializer(stateDir);
    const { view: telemetry } = await foldToTail<TelemetryViewState>(
      store,
      materializer,
      'telemetry',
      TELEMETRY_VIEW,
    );

    return {
      sessionTokens: telemetry.totalTokens,
      toolCount: Object.keys(telemetry.tools).length,
      totalInvocations: telemetry.totalInvocations,
    };
  } catch {
    return ZERO_METRICS;
  }
}

/**
 * Query the full telemetry view state for hint generation.
 * Returns null on any failure (graceful degradation).
 */
export async function queryTelemetryState(
  store: EventStore,
  stateDir: string,
): Promise<TelemetryViewState | null> {
  try {
    const materializer = getOrCreateMaterializer(stateDir);
    return (await foldToTail<TelemetryViewState>(store, materializer, 'telemetry', TELEMETRY_VIEW)).view;
  } catch {
    return null;
  }
}
