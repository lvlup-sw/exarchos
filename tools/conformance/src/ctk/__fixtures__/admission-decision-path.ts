/**
 * The admission decision path, in isolation.
 *
 * Before it opens its atomic transaction, the admission chokepoint
 * (`runTransitionCommand`) calls four pure functions: `selectEdge`,
 * `resolveRequirements`, `freezeRequirements` and `evaluatePolicy`. This module
 * composes only those four. It uses no event store, no clock, no gate runner and no
 * decision-record persistence.
 *
 * The admission latency bound excludes gate execution and report generation. Thus
 * the benchmark measures these four steps only, without the append. Identical inputs
 * give a byte-identical {@link AdmissionDecisionOutcome} and digest under any runtime.
 */

import { createHash } from 'node:crypto';

import {
  selectEdge,
  type EdgeCandidate,
} from '../../../../../src/workflow/admission/edge-condition-select.js';
import type { EdgeConditionFacts } from '../../../../../src/workflow/admission/edge-condition-evaluate.js';
import { resolveRequirements } from '../../../../../src/workflow/admission/requirement-resolution.js';
import type { RequirementContext } from '../../../../../src/workflow/admission/requirement-context.js';
import { freezeRequirements } from '../../../../../src/workflow/admission/freeze-requirements.js';
import {
  evaluatePolicy,
  type PolicyVerdict,
} from '../../../../../src/workflow/admission/policy-evaluation.js';
import type { EvidenceContradiction } from '../../../../../src/workflow/admission/select-evidence.js';
import type { PolicyAuthority } from '../../../../../src/workflow/admission/policy-authority.js';
import type {
  AdmissionEvidenceV1,
  ApprovalClass,
  EvidenceSubjectV1,
  PhaseAttemptId,
  WaiverProvenanceV1,
} from '../../../../../src/workflow/admission/types.js';

/** The inputs that one admission decision folds over. */
export interface AdmissionScenario {
  /** Stable identifier used in reports and digests. */
  readonly name: string;
  /** Topology candidates and facts for route selection. */
  readonly route: {
    readonly candidates: readonly EdgeCandidate[];
    readonly facts: EdgeConditionFacts;
  };
  /** Normalized requirement-resolution context. */
  readonly requirementContext: RequirementContext;
  readonly phaseAttemptId: PhaseAttemptId;
  readonly subject: EvidenceSubjectV1;
  readonly approvalClass?: ApprovalClass;
  readonly activeEvidence: readonly AdmissionEvidenceV1[];
  readonly contradictions?: readonly EvidenceContradiction[];
  readonly waivers?: readonly WaiverProvenanceV1[];
  readonly authority: PolicyAuthority;
  /** Trusted RFC3339 evaluation instant — never `Date.now()`. */
  readonly evaluatedAt: string;
  readonly freshnessHorizonMs: number;
  /** Declared expectations, pinned by the CTK. */
  readonly expect: {
    readonly route: 'selected' | 'blocked' | 'no-match';
    /** Only meaningful when `route === 'selected'`. */
    readonly verdict?: PolicyVerdict;
  };
}

/** The decision the path produced — the observable outcome, not the persisted record. */
export interface AdmissionDecisionOutcome {
  readonly route: 'selected' | 'blocked' | 'no-match';
  /** `null` when the route was not legal (no admission was evaluated). */
  readonly verdict: PolicyVerdict | null;
  /** The frozen requirement-set digest (content-addressed), or `null` if no admission. */
  readonly requirementSetDigest: string | null;
  /** The frozen requirement ids, in canonical order. */
  readonly requirementIds: readonly string[];
  readonly satisfiedCount: number;
  readonly waivedCount: number;
  readonly deniedCount: number;
  readonly indeterminateCount: number;
  /** Failures kept on record even under an allow (waived) verdict. */
  readonly recordedFailureCount: number;
}

const EMPTY_OUTCOME = (
  route: 'blocked' | 'no-match',
): AdmissionDecisionOutcome => ({
  route,
  verdict: null,
  requirementSetDigest: null,
  requirementIds: [],
  satisfiedCount: 0,
  waivedCount: 0,
  deniedCount: 0,
  indeterminateCount: 0,
  recordedFailureCount: 0,
});

/**
 * Runs the decision path for one scenario (route, resolve, freeze, evaluate) and
 * returns the observable decision. The chokepoint does the same work before it opens
 * its transaction. The append, the persisted record and any remediation report are
 * out of scope.
 */
export function decideAdmission(
  scenario: AdmissionScenario,
): AdmissionDecisionOutcome {
  const route = selectEdge(scenario.route.candidates, scenario.route.facts);
  if (route.outcome === 'no-match') return EMPTY_OUTCOME('no-match');
  if (route.outcome === 'blocked') return EMPTY_OUTCOME('blocked');

  const resolved = resolveRequirements(scenario.requirementContext);

  const frozen = freezeRequirements({
    resolved,
    phaseAttemptId: scenario.phaseAttemptId,
    subject: scenario.subject,
    ...(scenario.approvalClass !== undefined
      ? { approvalClass: scenario.approvalClass }
      : {}),
  });

  const evaluation = evaluatePolicy({
    requirements: frozen.requirements,
    obligations: resolved,
    activeEvidence: scenario.activeEvidence,
    ...(scenario.contradictions !== undefined
      ? { contradictions: scenario.contradictions }
      : {}),
    ...(scenario.waivers !== undefined ? { waivers: scenario.waivers } : {}),
    authority: scenario.authority,
    evaluatedAt: scenario.evaluatedAt,
    freshnessHorizonMs: scenario.freshnessHorizonMs,
  });

  let satisfiedCount = 0;
  let waivedCount = 0;
  let deniedCount = 0;
  let indeterminateCount = 0;
  for (const entry of evaluation.requirementEvaluations) {
    switch (entry.status) {
      case 'satisfied':
        satisfiedCount += 1;
        break;
      case 'waived':
        waivedCount += 1;
        break;
      case 'denied':
        deniedCount += 1;
        break;
      case 'indeterminate':
        indeterminateCount += 1;
        break;
    }
  }

  return {
    route: 'selected',
    verdict: evaluation.verdict,
    requirementSetDigest: frozen.requirementSetDigest.value,
    requirementIds: frozen.requirements.map((r) => r.requirementId),
    satisfiedCount,
    waivedCount,
    deniedCount,
    indeterminateCount,
    recordedFailureCount: evaluation.recordedFailures.length,
  };
}

type CanonicalJson =
  | null
  | boolean
  | number
  | string
  | readonly CanonicalJson[]
  | { readonly [key: string]: CanonicalJson };

function canonicalJson(value: CanonicalJson): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, CanonicalJson>).sort(
    ([a], [b]) => (a < b ? -1 : a > b ? 1 : 0),
  );
  return `{${entries
    .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
    .join(',')}}`;
}

/** A stable, runtime-independent digest of a decision outcome. */
export function outcomeDigest(outcome: AdmissionDecisionOutcome): string {
  return createHash('sha256')
    .update(canonicalJson(outcome as unknown as CanonicalJson), 'utf8')
    .digest('hex');
}

/**
 * The canonical digest of a whole corpus's decisions, in name order — the
 * fingerprint the cross-runtime parity proof compares across Node and Bun.
 */
export function corpusDigest(scenarios: readonly AdmissionScenario[]): string {
  const rows = [...scenarios]
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .map((scenario) => ({
      name: scenario.name,
      outcome: decideAdmission(scenario) as unknown as CanonicalJson,
    }));
  return createHash('sha256')
    .update(canonicalJson(rows as unknown as CanonicalJson), 'utf8')
    .digest('hex');
}

/** Latency percentiles over a sample of millisecond timings. */
export interface PercentileStats {
  readonly count: number;
  readonly minMs: number;
  readonly maxMs: number;
  readonly meanMs: number;
  readonly p50Ms: number;
  readonly p90Ms: number;
  readonly p99Ms: number;
}

/**
 * Computes nearest-rank percentiles over a sample of millisecond timings. The rank
 * for percentile `p` is `ceil(p / 100 * n)`, clamped to `[1, n]`. An empty sample
 * gives all-zero stats.
 */
export function computePercentiles(samplesMs: readonly number[]): PercentileStats {
  if (samplesMs.length === 0) {
    return { count: 0, minMs: 0, maxMs: 0, meanMs: 0, p50Ms: 0, p90Ms: 0, p99Ms: 0 };
  }
  const sorted = [...samplesMs].sort((a, b) => a - b);
  const n = sorted.length;
  const at = (p: number): number => {
    const rank = Math.min(n, Math.max(1, Math.ceil((p / 100) * n)));
    return sorted[rank - 1] ?? 0;
  };
  const sum = sorted.reduce((acc, x) => acc + x, 0);
  return {
    count: n,
    minMs: sorted[0] ?? 0,
    maxMs: sorted[n - 1] ?? 0,
    meanMs: sum / n,
    p50Ms: at(50),
    p90Ms: at(90),
    p99Ms: at(99),
  };
}

export interface MeasureOptions {
  /** Measured iterations (each times one full corpus pass). */
  readonly iterations: number;
  /** Unmeasured warm-up passes to pay JIT / allocation costs first. */
  readonly warmup: number;
}

export interface MeasurementResult {
  readonly stats: PercentileStats;
  /** A guard against a vacuous benchmark: how many decisions each pass made. */
  readonly decisionsPerIteration: number;
}

/**
 * Times the decision path over the whole corpus `iterations` times, after `warmup`
 * unmeasured passes. Each sample is the mean per-decision latency of one corpus pass,
 * so the p99 is over per-pass means. To measure the worst single decision, pass a
 * one-scenario corpus.
 *
 * Each pass adds outcome counts to a `sink` value that the loop checks. Thus a
 * runtime that removes dead code cannot remove the work.
 */
export function measureAdmissionDecisionPath(
  scenarios: readonly AdmissionScenario[],
  options: MeasureOptions,
): MeasurementResult {
  const runPass = (): number => {
    let sink = 0;
    for (const scenario of scenarios) {
      const outcome = decideAdmission(scenario);
      sink += outcome.requirementIds.length + outcome.satisfiedCount;
      if (outcome.verdict === undefined) sink += 1;
    }
    return sink;
  };

  for (let i = 0; i < options.warmup; i += 1) runPass();

  const perDecision: number[] = [];
  const decisions = Math.max(1, scenarios.length);
  for (let i = 0; i < options.iterations; i += 1) {
    const start = performance.now();
    const sink = runPass();
    const elapsed = performance.now() - start;
    perDecision.push(elapsed / decisions);
    if (sink < 0) throw new Error('unreachable: sink underflow');
  }

  return {
    stats: computePercentiles(perDecision),
    decisionsPerIteration: scenarios.length,
  };
}

/**
 * Times the decision path of one scenario, with one decision per sample. This is the
 * strict single-decision p99. The first `warmup` decisions are not measured. The loop
 * reads each outcome, so a runtime cannot remove the decision.
 */
export function measureSingleDecision(
  scenario: AdmissionScenario,
  options: MeasureOptions,
): PercentileStats {
  for (let i = 0; i < options.warmup; i += 1) decideAdmission(scenario);
  const samples: number[] = [];
  for (let i = 0; i < options.iterations; i += 1) {
    const start = performance.now();
    const outcome = decideAdmission(scenario);
    const elapsed = performance.now() - start;
    if (outcome.requirementIds.length < 0) throw new Error('unreachable');
    samples.push(elapsed);
  }
  return computePercentiles(samples);
}
