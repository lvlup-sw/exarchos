// ─── Telemetry Query Abstraction ──────────────────────────────────────────────
//
// Encapsulates telemetry materialization behind a query API, isolating the
// orchestrate layer from direct telemetry projection internals.
// ────────────────────────────────────────────────────────────────────────────

import { getOrCreateMaterializer, queryDeltaEvents } from '../views/tools.js';
import { TELEMETRY_VIEW } from './telemetry-projection.js';
import type { TelemetryViewState } from './telemetry-projection.js';
import type { EventStore } from '../event-store/store.js';

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
    const telemetryEvents = await queryDeltaEvents(store, materializer, 'telemetry', TELEMETRY_VIEW);
    const telemetry = materializer.materialize<TelemetryViewState>('telemetry', TELEMETRY_VIEW, telemetryEvents);

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
    const telemetryEvents = await queryDeltaEvents(store, materializer, 'telemetry', TELEMETRY_VIEW);
    return materializer.materialize<TelemetryViewState>('telemetry', TELEMETRY_VIEW, telemetryEvents);
  } catch {
    return null;
  }
}
