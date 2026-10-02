// Tests for the Stryker report schema and the carrier aggregation of the mutation-adequacy gate.
// The score is killed / (total − noCoverage), and Killed and Timeout mutants count as killed.
// NoCoverage mutants leave the denominator, so uncovered code cannot lower the score.
// A malformed or empty report gives a typed degrade result and does not throw.

import { describe, it, expect } from 'vitest';

import {
  MutationReportSchema,
  aggregate,
  parseMutationReport,
} from '../../../../src/verbs/gates/mutation-adequacy.js';

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
  /** The score is 3 / (5 − 1). */
  it('MutationReportSchema_ValidStrykerReport_ParsesAndAggregates', () => {
    const report = strykerReport(['Killed', 'Killed', 'Killed', 'Survived', 'NoCoverage']);

    const parsed = MutationReportSchema.safeParse(report);
    expect(parsed.success).toBe(true);

    const carrier = aggregate(MutationReportSchema.parse(report));
    expect(carrier).toEqual({
      mutationScore: 0.75,
      killed: 3,
      survived: 1,
      noCoverage: 1,
      total: 5,
    });
  });

  /** Timeout counts as killed, so the score is 2 / (6 − 2). */
  it('AggregateCarrier_MixedMutantStates_ComputesScore', () => {
    const report = strykerReport([
      'Killed',
      'Timeout',
      'Survived',
      'Survived',
      'NoCoverage',
      'NoCoverage',
    ]);

    const carrier = aggregate(MutationReportSchema.parse(report));
    expect(carrier.killed).toBe(2);
    expect(carrier.survived).toBe(2);
    expect(carrier.noCoverage).toBe(2);
    expect(carrier.total).toBe(6);
    expect(carrier.mutationScore).toBe(0.5);
  });

  /** A zero denominator must give 0, not NaN. A NaN score breaks the threshold comparison. */
  it('AggregateCarrier_AllNoCoverage_ScoreIsZeroNotNaN', () => {
    const report = strykerReport(['NoCoverage', 'NoCoverage']);

    const carrier = aggregate(MutationReportSchema.parse(report));
    expect(carrier.total).toBe(2);
    expect(carrier.noCoverage).toBe(2);
    expect(carrier.mutationScore).toBe(0);
    expect(Number.isNaN(carrier.mutationScore)).toBe(false);
  });

  /** `parseMutationReport` returns a tagged result, so the handler can show a bad report as a Warning. */
  it('MutationReportSchema_MalformedReport_FailsClosed', () => {
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
