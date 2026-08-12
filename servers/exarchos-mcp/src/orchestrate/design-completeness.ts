// ─── Design Completeness Gate — DEPRECATED alias (DR-9, #1581 task 013) ──────
//
// The design+plan collapse (DR-4/DR-6) retired the standalone
// design-completeness gate: its acceptance-criteria ("error-coverage") check is
// folded into `check_plan_coverage` (task 011), and it is excised from the gate
// chains (task 014). This handler is kept for ONE minor version as a deprecated
// alias that DELEGATES to `check_plan_coverage` so external callers/scripts that
// still invoke `check_design_completeness` keep working instead of hitting an
// UNKNOWN_ACTION. Removal of the alias is a tracked follow-up.
// ─────────────────────────────────────────────────────────────────────────────

import type { ToolResult } from '../format.js';
import type { EventStore } from '../events/store.js';
import { handlePlanCoverage } from './plan-coverage.js';
import { resolveWorkflowState } from './resolve-state.js';

export const DESIGN_COMPLETENESS_DEPRECATION_NOTICE =
  'check_design_completeness is deprecated and now delegates to check_plan_coverage on the unified docs/specs/ artifact (the acceptance-criteria check folded into plan-coverage in #1581). Migrate callers to check_plan_coverage; this alias will be removed in a future minor version.';

/**
 * Deprecated alias for `check_plan_coverage`.
 *
 * In the collapsed world design and plan are ONE `docs/specs/` artifact, so the
 * resolved artifact path is passed to plan-coverage as BOTH `designPath` and
 * `planPath`. Resolution priority: explicit `designPath`/`planPath` arg →
 * `artifacts.plan`/`artifacts.design` recorded in workflow state. The
 * delegated plan-coverage result is returned verbatim with a `deprecated`
 * marker + notice so callers can detect (and migrate off) the alias.
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

  // Resolve the unified artifact path: explicit arg first, then the workflow
  // state's recorded artifacts (plan preferred — it is the unified spec under
  // the collapse — then design for legacy two-artifact resume, DR-9 / task 020).
  let artifactPath = args.designPath || args.planPath;
  if (!artifactPath) {
    const streamId = args.featureId;
    const stateFile = args.stateFile ?? `${stateDir}/${streamId}.state.json`;
    const resolved = await resolveWorkflowState({ stateFile, featureId: streamId, eventStore });
    if ('error' in resolved) {
      // Propagate an infrastructure read failure rather than masking it as a
      // missing-artifact INVALID_INPUT.
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

  // Delegate to check_plan_coverage. plan-coverage owns the substantive
  // coverage check AND the folded acceptance-criteria finding (task 011).
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
