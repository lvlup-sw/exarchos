// ─── mutation-adequacy — report schema + carrier aggregation (RED→GREEN) ────
//
// Task 001 (design §4.1 parse half, §4.6 carrier): an internal Zod schema
// mirroring Stryker's `mutation-testing-report-schema` (the de-facto
// cross-language mutation-report standard) plus a pure `aggregate(report)` that
// folds the per-file mutant lists into the fixed carrier
// `{ mutationScore, killed, survived, noCoverage, total }`.
//
// Mutation score follows the Stryker convention asserted explicitly here:
//   score = killed / (total − noCoverage)
// where `killed` counts detected mutants (Killed + Timeout) and `total` counts
// every mutant with a covered/measurable verdict (NoCoverage excluded from the
// denominator — uncovered code can't lower the score for tests that exist).
//
// Fail-closed: a malformed/empty report returns a typed DEGRADE signal, never a
// throw — the doctor-grade robustness the action depends on (design §4.1 #4).
// ────────────────────────────────────────────────────────────────────────────

import { describe, it, expect } from 'vitest';

import {
  MutationReportSchema,
  aggregate,
  parseMutationReport,
} from './mutation-adequacy.js';

/** Minimal valid Stryker report fixture with a mix of mutant verdicts. */
function strykerReport(mutantStatuses: readonly string[]): unknown {
  return {
    schemaVersion: '1',
    thresholds: { high: 80, low: 60 },
    files: {
      'src/calc.ts': {
        language: 'typescript',
        source: 'export const add = (a: number, b: number) => a + b;\n',
        mutants: mutantStatuses.map((status, i) => ({
          id: `m${i}`,
          mutatorName: 'ArithmeticOperator',
          status,
          location: {
            start: { line: i + 1, column: 1 },
            end: { line: i + 1, column: 10 },
          },
        })),
      },
    },
  };
}

describe('MutationReportSchema (Stryker mutation-testing-report-schema)', () => {
  it('MutationReportSchema_ValidStrykerReport_ParsesAndAggregates', () => {
    // 3 Killed, 1 Survived, 1 NoCoverage across one file.
    const report = strykerReport(['Killed', 'Killed', 'Killed', 'Survived', 'NoCoverage']);

    const parsed = MutationReportSchema.safeParse(report);
    expect(parsed.success).toBe(true);

    const carrier = aggregate(MutationReportSchema.parse(report));
    // total = 5; noCoverage = 1; killed = 3; survived = 1
    // score = killed / (total − noCoverage) = 3 / (5 − 1) = 0.75
    expect(carrier).toEqual({
      mutationScore: 0.75,
      killed: 3,
      survived: 1,
      noCoverage: 1,
      total: 5,
    });
  });

  it('AggregateCarrier_MixedMutantStates_ComputesScore', () => {
    // Timeout counts as killed (detected). CompileError / Ignored / Pending do
    // not count toward killed or survived but DO count toward total (they have a
    // measurable, non-NoCoverage verdict), so they pull the score down — they
    // are not "no coverage", they are unresolved.
    const report = strykerReport([
      'Killed',
      'Timeout', // detected → killed
      'Survived',
      'Survived',
      'NoCoverage',
      'NoCoverage',
    ]);

    const carrier = aggregate(MutationReportSchema.parse(report));
    // killed = 2 (Killed + Timeout), survived = 2, noCoverage = 2, total = 6
    // score = 2 / (6 − 2) = 0.5
    expect(carrier.killed).toBe(2);
    expect(carrier.survived).toBe(2);
    expect(carrier.noCoverage).toBe(2);
    expect(carrier.total).toBe(6);
    expect(carrier.mutationScore).toBe(0.5);
  });

  it('AggregateCarrier_AllNoCoverage_ScoreIsZeroNotNaN', () => {
    // Guard the denominator: total − noCoverage = 0 must yield 0, never NaN
    // (a NaN score would silently poison the advisory threshold comparison).
    const report = strykerReport(['NoCoverage', 'NoCoverage']);

    const carrier = aggregate(MutationReportSchema.parse(report));
    expect(carrier.total).toBe(2);
    expect(carrier.noCoverage).toBe(2);
    expect(carrier.mutationScore).toBe(0);
    expect(Number.isNaN(carrier.mutationScore)).toBe(false);
  });

  it('MutationReportSchema_MalformedReport_FailsClosed', () => {
    // A degrade SIGNAL, never a throw. parseMutationReport returns a tagged
    // result so the handler can map a bad report to a Warning carrier.
    const malformed = { schemaVersion: '1', files: { bad: { mutants: 'not-an-array' } } };

    const result = parseMutationReport(malformed);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(typeof result.reason).toBe('string');
      expect(result.reason.length).toBeGreaterThan(0);
    }
  });

  it('parseMutationReport_EmptyString_FailsClosedNoThrow', () => {
    const result = parseMutationReport('');
    expect(result.ok).toBe(false);
  });

  it('parseMutationReport_ValidJsonString_ParsesAndReturnsCarrier', () => {
    const json = JSON.stringify(strykerReport(['Killed', 'Survived']));

    const result = parseMutationReport(json);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.carrier.killed).toBe(1);
      expect(result.carrier.survived).toBe(1);
      expect(result.carrier.total).toBe(2);
      expect(result.carrier.mutationScore).toBe(0.5);
    }
  });
});
