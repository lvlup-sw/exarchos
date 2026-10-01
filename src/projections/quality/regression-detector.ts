/**
 * Finds quality regressions in the failure trackers of the code-quality view, and
 * appends `quality.regression` events for them. A tracker key has the form `gate:skill`.
 */

import type { EventStore } from '../../events/store.js';

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

const REGRESSION_THRESHOLD = 3;

/**
 * Returns the trackers in `_failureTrackers` with at least `REGRESSION_THRESHOLD`
 * consecutive failures. It skips a key that has no `:` separator.
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

/**
 * Appends one `quality.regression` event for each regression. It ignores a failed
 * append, so an append error does not stop the caller.
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
    }
  }
}
