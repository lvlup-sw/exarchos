// ─── P07-04 exit-proof (e) — admission decision-path performance ─────────────
//
// The exit proof: "admission p99 is under 15 ms EXCLUDING gate execution and
// report generation." This suite measures the p99 of the isolated admission
// DECISION path — route → resolve → freeze → evaluate (see
// `admission-decision-path.ts`) — with evidence already supplied (gates ran
// upstream) and no persisted decision record / remediation report (downstream).
//
// Two measurements are taken:
//   1. the WORST single-decision path (the strongest lattice point: gate +
//      approval + corroboration) timed one decision per sample — the strict
//      reading of "admission p99";
//   2. the mean per-decision latency across the whole diverse corpus.
//
// The measured p99 is ALWAYS logged (so the Windows dev box still reports a real
// number), and the hard `< 15 ms` assertion is SKIPPED on win32 — the same
// precedent as `poc.acceptance.test.ts`'s throughput bench (#1620): the
// windows-latest runner's timer/allocation jitter would false-fail a wall-clock
// bound that Linux CI enforces truthfully.

import { describe, it, expect } from 'vitest';

import {
  admissionScenarioCorpus,
  worstCaseScenario,
} from './__fixtures__/admission-scenario-corpus.js';
import {
  measureAdmissionDecisionPath,
  measureSingleDecision,
  decideAdmission,
  type PercentileStats,
} from './__fixtures__/admission-decision-path.js';

const ADMISSION_P99_BUDGET_MS = 15;

function report(label: string, stats: PercentileStats): void {
  // A single, greppable line so the actual number is captured on every runner,
  // including win32 where the hard assertion is skipped.
  // eslint-disable-next-line no-console
  console.log(
    `[P07-04 admission-perf] ${label} ` +
      `count=${stats.count} min=${stats.minMs.toFixed(4)}ms ` +
      `mean=${stats.meanMs.toFixed(4)}ms p50=${stats.p50Ms.toFixed(4)}ms ` +
      `p90=${stats.p90Ms.toFixed(4)}ms p99=${stats.p99Ms.toFixed(4)}ms ` +
      `max=${stats.maxMs.toFixed(4)}ms`,
  );
}

describe('admission decision-path performance (exit-proof e)', () => {
  it('AdmissionDecisionPath_MeasuresP99_AndAlwaysReportsTheNumber', () => {
    const single = measureSingleDecision(worstCaseScenario, {
      iterations: 3000,
      warmup: 500,
    });
    report(`worst-single-decision [${worstCaseScenario.name}]`, single);

    const corpus = measureAdmissionDecisionPath(admissionScenarioCorpus, {
      iterations: 1000,
      warmup: 100,
    });
    report('corpus-per-decision', corpus.stats);

    // Non-vacuous guard: the measurement actually ran real decisions.
    expect(single.count).toBe(3000);
    expect(corpus.decisionsPerIteration).toBe(admissionScenarioCorpus.length);
    // A catastrophic-regression tripwire that is safe on every runner (three
    // orders of magnitude above the real number) — the true 15 ms bound is
    // enforced below on non-win32.
    expect(single.p99Ms).toBeLessThan(500);
  });

  it.skipIf(process.platform === 'win32')(
    'AdmissionDecisionPath_WorstSingleDecisionP99_IsUnder15ms',
    () => {
      const single = measureSingleDecision(worstCaseScenario, {
        iterations: 3000,
        warmup: 500,
      });
      report(`[asserted] worst-single-decision [${worstCaseScenario.name}]`, single);
      expect(single.p99Ms).toBeLessThan(ADMISSION_P99_BUDGET_MS);
    },
  );

  it.skipIf(process.platform === 'win32')(
    'AdmissionDecisionPath_CorpusPerDecisionP99_IsUnder15ms',
    () => {
      const corpus = measureAdmissionDecisionPath(admissionScenarioCorpus, {
        iterations: 1000,
        warmup: 100,
      });
      report('[asserted] corpus-per-decision', corpus.stats);
      expect(corpus.stats.p99Ms).toBeLessThan(ADMISSION_P99_BUDGET_MS);
    },
  );

  it('AdmissionDecisionPath_ExcludesTheAtomicAppend_ByConstruction', () => {
    // The measured path returns a decision WITHOUT persisting it: no event
    // store handle is touched. This is the structural reason the measurement
    // excludes the append and report generation. Proven here by the outcome
    // shape — a pure value, not a persisted record with a stream sequence.
    const outcome = decideAdmission(worstCaseScenario);
    expect(outcome).not.toHaveProperty('sequence');
    expect(outcome).not.toHaveProperty('streamId');
    expect(outcome.verdict).toBe('allow');
  });
});
