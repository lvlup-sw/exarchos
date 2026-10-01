/**
 * Shared helpers for the compact contract of the analytic and correlation views.
 *
 * Each view returns a compact payload by default and the full projection under
 * `detail: true`. The `compact*` helpers drop the secondary fields. A view with a
 * filter argument reports `scope` and `unscopedTotal` through {@link analyticScope}.
 */

import type { NextAction } from '../../../next-action.js';
import type { AttributionEntry } from '../../quality/attribution.js';
import type { QualityHint } from '../../quality/hints.js';
import type { SkillCorrelation } from '../../quality/quality-correlation.js';
import type { PrStatus } from '../shepherd-status-view.js';
import { scopeHiddenAffordance } from './inventory-contract.js';

interface AnalyticScope {
  readonly scope: 'filtered' | 'all';
  readonly unscopedTotal: number;
  readonly nextActions: NextAction[];
}

/**
 * The scope facet for a view with a filter. `unscopedTotal` is the count before the
 * filter, and `scope` is `'filtered'` when a filter argument is active. When the filter
 * hides rows, it adds `scopeHiddenAffordance` to `nextActions`, so the caller knows
 * about the hidden rows.
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

/** A `QualityHint` without the calibration fields. `detail: true` restores them. */
export type CompactQualityHint = Omit<QualityHint, 'affectedPromptPaths' | 'confidenceLevel'>;
export function compactQualityHint(h: QualityHint): CompactQualityHint {
  const { affectedPromptPaths: _paths, confidenceLevel: _conf, ...rest } = h;
  return rest;
}

/** A `SkillCorrelation` with the pass rate and eval score only. `detail: true` restores the other fields. */
export type CompactSkillCorrelation = Pick<SkillCorrelation, 'skill' | 'gatePassRate' | 'evalScore'>;
export function compactSkillCorrelation(c: SkillCorrelation): CompactSkillCorrelation {
  return { skill: c.skill, gatePassRate: c.gatePassRate, evalScore: c.evalScore };
}

/** An `AttributionEntry` without the secondary counts. `detail: true` restores them. */
type CompactAttributionEntry = Omit<AttributionEntry, 'selfCorrectionRate' | 'regressionCount' | 'sampleSize'>;
export function compactAttributionEntry(e: AttributionEntry): CompactAttributionEntry {
  const { selfCorrectionRate: _self, regressionCount: _reg, sampleSize: _size, ...rest } = e;
  return rest;
}

/** A `PrStatus` without the count for each severity. `detail: true` restores it. */
export type CompactPrStatus = Omit<PrStatus, 'unresolvedBySeverity'>;
export function compactPrStatus(p: PrStatus): CompactPrStatus {
  const { unresolvedBySeverity: _sev, ...rest } = p;
  return rest;
}
