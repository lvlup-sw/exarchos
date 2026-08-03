// ─── P07-04 / Transition task 038 — admission decision path (isolated) ───────
//
// The P06 admission chokepoint (`runTransitionCommand`) does five things and
// then appends: (1) selects the legal ROUTE, (2) RESOLVES the requirement
// lattice, (3) FREEZES it into content-addressed records, (4) EVALUATES the
// three-valued policy verdict, and only then (5) APPENDS the decision +
// lifecycle events in one atomic transaction.
//
// The P07-04 exit proof bounds the DECISION itself — "admission p99 under 15 ms
// EXCLUDING gate execution and report generation." Gate execution is upstream
// (evidence is supplied here, already produced), and report generation / the
// atomic append are downstream. So the thing to measure is steps (1)–(4) in
// isolation: `selectEdge` → `resolveRequirements` → `freezeRequirements` →
// `evaluatePolicy`. This module composes exactly those four pure functions —
// the SAME ones the real chokepoint calls before it opens its transaction — and
// nothing else. No event store, no clock, no gate runner, no decision-record
// persistence.
//
// It is pure and deterministic, which is also what the cross-runtime and replay
// suites lean on: identical inputs yield a byte-identical {@link
// AdmissionDecisionOutcome} and digest under any runtime.

import { createHash } from 'node:crypto';

import {
  selectEdge,
  type EdgeCandidate,
} from '../../workflow/admission/edge-condition-select.js';
import type { EdgeConditionFacts } from '../../workflow/admission/edge-condition-evaluate.js';
import { resolveRequirements } from '../../workflow/admission/requirement-resolution.js';
import type { RequirementContext } from '../../workflow/admission/requirement-context.js';
import { freezeRequirements } from '../../workflow/admission/freeze-requirements.js';
import {
  evaluatePolicy,
  type PolicyVerdict,
} from '../../workflow/admission/policy-evaluation.js';
import type { EvidenceContradiction } from '../../workflow/admission/select-evidence.js';
import type { PolicyAuthority } from '../../workflow/admission/policy-authority.js';
import type {
  AdmissionEvidenceV1,
  ApprovalClass,
  EvidenceSubjectV1,
  PhaseAttemptId,
  WaiverProvenanceV1,
} from '../../workflow/admission/types.js';

// ─── Scenario input — everything a decision folds over ───────────────────────

export interface AdmissionScenario {
  /** Stable identifier used in reports and digests. */
  readonly name: string;
  /** Topology candidates + facts for route selection (P06-02). */
  readonly route: {
    readonly candidates: readonly EdgeCandidate[];
    readonly facts: EdgeConditionFacts;
  };
  /** Normalized requirement-resolution context (P06-03). */
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
 * Run the admission DECISION path for one scenario — route → resolve → freeze →
 * evaluate — and return the observable decision. This is the exact work the
 * P06-05 chokepoint performs BEFORE opening its atomic transaction; the append,
 * the persisted decision record, and any remediation report are deliberately
 * out of scope (the P07-04 exit-proof exclusions).
 */
export function decideAdmission(
  scenario: AdmissionScenario,
): AdmissionDecisionOutcome {
  // 1. Route legality (P06-02).
  const route = selectEdge(scenario.route.candidates, scenario.route.facts);
  if (route.outcome === 'no-match') return EMPTY_OUTCOME('no-match');
  if (route.outcome === 'blocked') return EMPTY_OUTCOME('blocked');

  // 2. Resolve the obligation lattice (P06-03).
  const resolved = resolveRequirements(scenario.requirementContext);

  // 3. Freeze it into content-addressed records (P06-05).
  const frozen = freezeRequirements({
    resolved,
    phaseAttemptId: scenario.phaseAttemptId,
    subject: scenario.subject,
    ...(scenario.approvalClass !== undefined
      ? { approvalClass: scenario.approvalClass }
      : {}),
  });

  // 4. Evaluate the three-valued policy verdict (P06-04).
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

// ─── Content-addressed digest of an outcome (cross-runtime / replay compare) ──

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

// ─── Percentile measurement ──────────────────────────────────────────────────

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
 * Nearest-rank percentile over a sample of millisecond timings. `p` is in
 * `[0, 100]`. Empty input yields all-zero stats (a caller-visible degenerate).
 */
export function computePercentiles(samplesMs: readonly number[]): PercentileStats {
  if (samplesMs.length === 0) {
    return { count: 0, minMs: 0, maxMs: 0, meanMs: 0, p50Ms: 0, p90Ms: 0, p99Ms: 0 };
  }
  const sorted = [...samplesMs].sort((a, b) => a - b);
  const n = sorted.length;
  const at = (p: number): number => {
    // Nearest-rank: rank = ceil(p/100 * n), clamped to [1, n].
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
 * Time the admission decision path over the whole corpus, `iterations` times,
 * after `warmup` unmeasured passes. Each measured sample is the mean per-decision
 * latency of one full corpus pass (so a large, diverse corpus is amortized into
 * a representative per-decision time, and the p99 is over per-pass means). To
 * pin the WORST single-decision path instead, pass a one-scenario corpus.
 *
 * The returned `sink` accumulator is intentionally observed via the outcome
 * counts so a dead-code-eliminating runtime cannot elide the work.
 */
export function measureAdmissionDecisionPath(
  scenarios: readonly AdmissionScenario[],
  options: MeasureOptions,
): MeasurementResult {
  const runPass = (): number => {
    let sink = 0;
    for (const scenario of scenarios) {
      const outcome = decideAdmission(scenario);
      // Touch the result so the call cannot be optimized away.
      sink += outcome.requirementIds.length + outcome.satisfiedCount;
      if (outcome.verdict === undefined) sink += 1; // never true; keeps `sink` live
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
 * Time a SINGLE scenario's decision path, one decision per measured sample —
 * the strict "worst single-decision p99" the exit proof bounds. `warmup`
 * samples are discarded first.
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
    // Observe the outcome so the decision cannot be elided.
    if (outcome.requirementIds.length < 0) throw new Error('unreachable');
    samples.push(elapsed);
  }
  return computePercentiles(samples);
}
