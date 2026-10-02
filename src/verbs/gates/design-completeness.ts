/**
 * check_design_completeness: a deprecated alias that delegates to
 * `check_plan_coverage`. Design and plan are one unified spec artifact, and
 * plan coverage holds the acceptance-criteria check. The alias keeps old
 * callers working instead of failing with UNKNOWN_ACTION.
 */

import type { ToolResult } from '../../format.js';
import type { EventStore } from '../../events/store.js';
import { handlePlanCoverage } from './plan-coverage.js';
import { resolveWorkflowState } from '../resolve-state.js';

export const DESIGN_COMPLETENESS_DEPRECATION_NOTICE =
  'check_design_completeness is deprecated and now delegates to check_plan_coverage on the unified docs/specs/ artifact (the acceptance-criteria check folded into plan-coverage in #1581). Migrate callers to check_plan_coverage; this alias will be removed in a future minor version.';

/**
 * Deprecated alias for `check_plan_coverage`. Design and plan are one spec
 * artifact, so the resolved path goes to plan coverage as both `designPath`
 * and `planPath`. The path comes from `designPath`, then `planPath`, then
 * `artifacts.plan` and `artifacts.design` in the workflow state. A state read
 * error returns as is, not as a missing artifact. A successful result carries
 * a `deprecated` marker and the notice. A failed result returns unchanged.
 */
export async function handleDesignCompleteness(
  args: { featureId: string; stateFile?: string; designPath?: string; planPath?: string },
  stateDir: string,
  eventStore: EventStore,
): Promise<ToolResult> {
  if (!args.featureId) {
    return {
      success: false,
      error: { code: 'INVALID_INPUT', message: 'featureId is required' },
    };
  }

  let artifactPath = args.designPath || args.planPath;
  if (!artifactPath) {
    const streamId = args.featureId;
    const stateFile = args.stateFile ?? `${stateDir}/${streamId}.state.json`;
    const resolved = await resolveWorkflowState({ stateFile, featureId: streamId, eventStore });
    if ('error' in resolved) {
      return resolved.error;
    }
    const artifacts = resolved.state.artifacts;
    if (artifacts && typeof artifacts === 'object' && !Array.isArray(artifacts)) {
      const rec = artifacts as Record<string, unknown>;
      const candidate = rec.plan || rec.design;
      if (typeof candidate === 'string' && candidate.length > 0) {
        artifactPath = candidate;
      }
    }
  }

  if (!artifactPath) {
    return {
      success: false,
      error: {
        code: 'INVALID_INPUT',
        message: `${DESIGN_COMPLETENESS_DEPRECATION_NOTICE} Could not resolve a unified artifact path — pass designPath, or record artifacts.plan/design in workflow state.`,
      },
    };
  }

  const result = await handlePlanCoverage(
    { featureId: args.featureId, designPath: artifactPath, planPath: artifactPath },
    stateDir,
    eventStore,
  );

  if (!result.success) {
    return result;
  }

  return {
    success: true,
    data: {
      ...(result.data as Record<string, unknown>),
      deprecated: true,
      deprecationNotice: DESIGN_COMPLETENESS_DEPRECATION_NOTICE,
    },
  };
}
