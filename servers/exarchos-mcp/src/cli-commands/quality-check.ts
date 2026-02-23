import {
  getOrCreateEventStore,
  getOrCreateMaterializer,
  queryDeltaEvents,
} from '../views/tools.js';
import { CODE_QUALITY_VIEW } from '../views/code-quality-view.js';
import type { CodeQualityViewState } from '../views/code-quality-view.js';
import { detectRegressions } from '../quality/regression-detector.js';
import type { QualityRegressionData, FailureTracker } from '../quality/regression-detector.js';
import type { CommandResult } from '../cli.js';

export interface QualityCheckResult extends CommandResult {
  readonly regressions?: ReadonlyArray<QualityRegressionData>;
  readonly summary?: {
    readonly totalSkills: number;
    readonly totalGates: number;
    readonly regressionCount: number;
    readonly status: 'clean' | 'regressions-detected';
  };
}

export async function handleQualityCheck(
  stdinData: Record<string, unknown>,
  stateDir: string,
): Promise<QualityCheckResult> {
  try {
    const store = getOrCreateEventStore(stateDir);
    const materializer = getOrCreateMaterializer(stateDir);
    const streamId = (typeof stdinData['workflowId'] === 'string' ? stdinData['workflowId'] : undefined) ?? 'default';

    const events = await queryDeltaEvents(store, materializer, streamId, CODE_QUALITY_VIEW);
    const view = materializer.materialize<CodeQualityViewState>(
      streamId,
      CODE_QUALITY_VIEW,
      events,
    );
    // _failureTrackers is a non-enumerable property set by code-quality-view.ts
    const regressions = detectRegressions(view as CodeQualityViewState & { _failureTrackers?: Record<string, FailureTracker> });

    return {
      regressions,
      summary: {
        totalSkills: Object.keys(view.skills).length,
        totalGates: Object.keys(view.gates).length,
        regressionCount: regressions.length,
        status: regressions.length === 0 ? 'clean' : 'regressions-detected',
      },
    };
  } catch (err) {
    return {
      error: {
        code: 'QUALITY_CHECK_ERROR',
        message: err instanceof Error ? err.message : String(err),
      },
    };
  }
}
