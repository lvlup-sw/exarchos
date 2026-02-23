// ─── Quality Regression Detector ────────────────────────────────────────────
//
// Extracts regression data from the CodeQualityView's internal failure
// trackers and emits quality.regression events to the event store.
//
// The failure tracker structure mirrors what code-quality-view.ts uses
// internally: a Record<string, FailureTracker> keyed by "gate:skill".
// ────────────────────────────────────────────────────────────────────────────

import type { EventStore } from '../event-store/store.js';

// ─── Interfaces ─────────────────────────────────────────────────────────────

export interface FailureTracker {
  count: number;
  firstCommit: string;
  lastCommit: string;
}

export interface QualityRegressionData {
  skill: string;
  gate: string;
  consecutiveFailures: number;
  firstFailureCommit: string;
  lastFailureCommit: string;
  detectedAt: string;
}

// ─── Regression Threshold ───────────────────────────────────────────────────

const REGRESSION_THRESHOLD = 3;

// ─── Detector ───────────────────────────────────────────────────────────────

/**
 * Detect quality regressions from view state failure trackers.
 *
 * Reads the `_failureTrackers` property from the view state (which is
 * the internal tracking state from CodeQualityView) and returns entries
 * where consecutive failures meet or exceed the threshold (3).
 */
export function detectRegressions(
  viewState: { _failureTrackers?: Record<string, FailureTracker> },
): QualityRegressionData[] {
  const trackers = viewState._failureTrackers;
  if (!trackers) return [];

  const regressions: QualityRegressionData[] = [];
  const now = new Date().toISOString();

  for (const [key, tracker] of Object.entries(trackers)) {
    if (tracker.count < REGRESSION_THRESHOLD) continue;

    // Key format is "gate:skill" as used in code-quality-view.ts
    const separatorIndex = key.indexOf(':');
    if (separatorIndex === -1) continue;

    const gate = key.slice(0, separatorIndex);
    const skill = key.slice(separatorIndex + 1);

    regressions.push({
      skill,
      gate,
      consecutiveFailures: tracker.count,
      firstFailureCommit: tracker.firstCommit,
      lastFailureCommit: tracker.lastCommit,
      detectedAt: now,
    });
  }

  return regressions;
}

// ─── Event Emitter ──────────────────────────────────────────────────────────

/**
 * Emit quality.regression events for each detected regression.
 *
 * Fire-and-forget: individual append failures are silently swallowed
 * so callers are never blocked by event emission errors.
 */
export async function emitRegressionEvents(
  regressions: QualityRegressionData[],
  streamId: string,
  eventStore: EventStore,
): Promise<void> {
  for (const regression of regressions) {
    try {
      await eventStore.append(streamId, {
        type: 'quality.regression',
        data: {
          skill: regression.skill,
          gate: regression.gate,
          consecutiveFailures: regression.consecutiveFailures,
          firstFailureCommit: regression.firstFailureCommit,
          lastFailureCommit: regression.lastFailureCommit,
          detectedAt: regression.detectedAt,
        },
      });
    } catch {
      // Intentionally swallowed — event emission is fire-and-forget
    }
  }
}
