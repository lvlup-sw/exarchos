import type { NextAction } from '../../../next-action.js';
import type { AttributionEntry } from '../../quality/attribution.js';
import type { QualityHint } from '../../quality/hints.js';
import type { SkillCorrelation } from '../../quality/quality-correlation.js';
import type { PrStatus } from '../shepherd-status-view.js';
import { scopeHiddenAffordance } from './inventory-contract.js';

// ─── DR-8 (Task 024): generalized ANALYTIC / correlation-view contract ───────
//
// Task 013 migrated the inventory / list-shaped views. This batch generalizes
// the SAME contract to the analytic + correlation views in this file
// (`code_quality`, `eval_results`, `quality_hints`, `quality_correlation`,
// `quality_attribution`, `session_provenance`, `delegation_readiness`,
// `synthesis_readiness`, `shepherd_status`, `provenance`):
//   • compact-by-default — each view strips its heaviest SECONDARY sub-structure
//     by default and restores it under `detail: true` (the universal facet);
//   • `page` metadata on the views whose dominant payload is a nested LIST
//     (`quality_hints` hints, `quality_attribution` entries, `shepherd_status`
//     prs, `provenance` requirements);
//   • P5 scope perceivability (`scope` + `unscopedTotal`) on the FILTER-scoped
//     views (`code_quality` / `eval_results` / `quality_hints`).
// Each migrated view carries a DR-2-style token-budget test and rides Task 003's
// dispatch-core backstop. Additive / backward-compatible: `detail: true` returns
// today's full projection, so existing default-shape consumers keep reading the
// same fields. `telemetry`'s handler lives in `projections/telemetry/tools.ts` (out of this
// file); its `--compact` reduction is Task 014.

interface AnalyticScope {
  readonly scope: 'filtered' | 'all';
  readonly unscopedTotal: number;
  readonly nextActions: NextAction[];
}

/**
 * DR-8 P5 scope facet for a FILTER-scoped analytic view. `unscopedTotal` is the
 * PRE-filter count of the dominant record/list; `scope` is `'filtered'` whenever
 * a filter arg is active. Surfaces `scopeHiddenAffordance` on `next_actions`
 * whenever the filter hid rows (`unscopedTotal > scopedTotal`) so the elided
 * rows stay perceivable — the same escape hatch the inventory batch (Task 013)
 * uses for its filter-scoped views.
 */
export function analyticScope(
  verb: string,
  filterActive: boolean,
  unscopedTotal: number,
  scopedTotal: number,
): AnalyticScope {
  const scope: 'filtered' | 'all' = filterActive ? 'filtered' : 'all';
  const nextActions: NextAction[] = [];
  if (unscopedTotal > scopedTotal) {
    nextActions.push(scopeHiddenAffordance(verb, unscopedTotal - scopedTotal));
  }
  return { scope, unscopedTotal, nextActions };
}

/** DR-8 compact `QualityHint`: drop the advisory calibration fields; `detail:true` restores them. */
export type CompactQualityHint = Omit<QualityHint, 'affectedPromptPaths' | 'confidenceLevel'>;
export function compactQualityHint(h: QualityHint): CompactQualityHint {
  const { affectedPromptPaths: _paths, confidenceLevel: _conf, ...rest } = h;
  return rest;
}

/** DR-8 compact `SkillCorrelation`: keep the headline (pass rate + eval score); `detail:true` restores the trends. */
export type CompactSkillCorrelation = Pick<SkillCorrelation, 'skill' | 'gatePassRate' | 'evalScore'>;
export function compactSkillCorrelation(c: SkillCorrelation): CompactSkillCorrelation {
  return { skill: c.skill, gatePassRate: c.gatePassRate, evalScore: c.evalScore };
}

/** DR-8 compact `AttributionEntry`: drop the secondary roll-up counts; `detail:true` restores them. */
type CompactAttributionEntry = Omit<AttributionEntry, 'selfCorrectionRate' | 'regressionCount' | 'sampleSize'>;
export function compactAttributionEntry(e: AttributionEntry): CompactAttributionEntry {
  const { selfCorrectionRate: _self, regressionCount: _reg, sampleSize: _size, ...rest } = e;
  return rest;
}

/** DR-8 compact `PrStatus`: drop the per-severity breakdown; `detail:true` restores it. */
export type CompactPrStatus = Omit<PrStatus, 'unresolvedBySeverity'>;
export function compactPrStatus(p: PrStatus): CompactPrStatus {
  const { unresolvedBySeverity: _sev, ...rest } = p;
  return rest;
}
