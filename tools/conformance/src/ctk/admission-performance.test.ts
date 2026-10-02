/**
 * Measures the p99 of the isolated admission decision path against a 15 ms budget.
 * The budget excludes gate execution and report generation. The evidence is already
 * present, and the path persists no decision record. The suite takes two
 * measurements:
 *
 * 1. The worst single decision (gate, approval and corroboration), one per sample.
 * 2. The mean per-decision latency across the whole corpus.
 *
 * The suite always logs the measured p99. On win32 it skips the hard 15 ms assertion
 * because timer jitter on the runner causes false failures. Linux CI enforces it.
 */

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

/** Logs one line that a grep can find, so every runner records the numbers, win32 included. */
function report(label: string, stats: PercentileStats): void {
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
  /**
   * Checks that the measurement made real decisions. The 500 ms bound is a tripwire
   * for a catastrophic regression that is safe on every runner. The tests below
   * enforce the 15 ms bound outside win32.
   */
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

    expect(single.count).toBe(3000);
    expect(corpus.decisionsPerIteration).toBe(admissionScenarioCorpus.length);
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

  /**
   * The measured path returns a decision and persists nothing. The outcome is a pure
   * value with no stream sequence, so the measurement excludes the append.
   */
  it('AdmissionDecisionPath_ExcludesTheAtomicAppend_ByConstruction', () => {
    const outcome = decideAdmission(worstCaseScenario);
    expect(outcome).not.toHaveProperty('sequence');
    expect(outcome).not.toHaveProperty('streamId');
    expect(outcome.verdict).toBe('allow');
  });
});
