import { describe, it, expect } from 'vitest';
import { fc } from '@fast-check/vitest';
import type { HumanGradedCase } from '../calibration-types.js';
import { computeConfusionMatrix, extractDisagreements } from '../calibration-metrics.js';

function makeCase(
  caseId: string,
  humanVerdict: boolean,
  rationale = 'human rationale',
): HumanGradedCase {
  return {
    caseId,
    skill: 'test-skill',
    rubricName: 'test-rubric',
    humanVerdict,
    humanScore: humanVerdict ? 1 : 0,
    humanRationale: rationale,
  };
}

function makeVerdicts(
  entries: Array<[string, boolean, string]>,
): Map<string, { verdict: boolean; reason: string }> {
  const map = new Map<string, { verdict: boolean; reason: string }>();
  for (const [id, verdict, reason] of entries) {
    map.set(id, { verdict, reason });
  }
  return map;
}

describe('computeConfusionMatrix', () => {
  it('ComputeConfusionMatrix_AllCorrect_PerfectScores', () => {
    const cases: HumanGradedCase[] = [
      makeCase('c1', true),
      makeCase('c2', true),
      makeCase('c3', true),
      makeCase('c4', false),
      makeCase('c5', false),
    ];
    const judgeVerdicts = makeVerdicts([
      ['c1', true, 'good'],
      ['c2', true, 'good'],
      ['c3', true, 'good'],
      ['c4', false, 'bad'],
      ['c5', false, 'bad'],
    ]);

    const report = computeConfusionMatrix(cases, judgeVerdicts, 'validation');

    expect(report.totalCases).toBe(5);
    expect(report.truePositives).toBe(3);
    expect(report.trueNegatives).toBe(2);
    expect(report.falsePositives).toBe(0);
    expect(report.falseNegatives).toBe(0);
    expect(report.tpr).toBe(1);
    expect(report.tnr).toBe(1);
    expect(report.accuracy).toBe(1);
    expect(report.f1).toBe(1);
    expect(report.disagreements).toHaveLength(0);
    expect(report.skill).toBe('test-skill');
    expect(report.rubricName).toBe('test-rubric');
    expect(report.split).toBe('validation');
  });

  it('ComputeConfusionMatrix_AllWrong_ZeroScores', () => {
    const cases: HumanGradedCase[] = [
      makeCase('c1', true),
      makeCase('c2', true),
      makeCase('c3', false),
      makeCase('c4', false),
    ];
    const judgeVerdicts = makeVerdicts([
      ['c1', false, 'wrong'],
      ['c2', false, 'wrong'],
      ['c3', true, 'wrong'],
      ['c4', true, 'wrong'],
    ]);

    const report = computeConfusionMatrix(cases, judgeVerdicts, 'test');

    expect(report.totalCases).toBe(4);
    expect(report.truePositives).toBe(0);
    expect(report.trueNegatives).toBe(0);
    expect(report.falsePositives).toBe(2);
    expect(report.falseNegatives).toBe(2);
    expect(report.tpr).toBe(0);
    expect(report.tnr).toBe(0);
    expect(report.accuracy).toBe(0);
    expect(report.f1).toBe(0);
    expect(report.disagreements).toHaveLength(4);
    expect(report.split).toBe('test');
  });

  /**
   * Two TP, one TN, one FP (c5), and one FN (c3). TPR is 2/3, TNR is 0.5, and accuracy is 0.6. Precision and
   * recall are both 2/3, so F1 is 2/3.
   */
  it('ComputeConfusionMatrix_MixedResults_CorrectTPRTNR', () => {
    const cases: HumanGradedCase[] = [
      makeCase('c1', true),
      makeCase('c2', true),
      makeCase('c3', true),
      makeCase('c4', false),
      makeCase('c5', false),
    ];
    const judgeVerdicts = makeVerdicts([
      ['c1', true, 'ok'],
      ['c2', true, 'ok'],
      ['c3', false, 'missed'],
      ['c4', false, 'ok'],
      ['c5', true, 'oops'],
    ]);

    const report = computeConfusionMatrix(cases, judgeVerdicts, 'validation');

    expect(report.truePositives).toBe(2);
    expect(report.trueNegatives).toBe(1);
    expect(report.falsePositives).toBe(1);
    expect(report.falseNegatives).toBe(1);
    expect(report.tpr).toBeCloseTo(2 / 3, 10);
    expect(report.tnr).toBeCloseTo(0.5, 10);
    expect(report.accuracy).toBeCloseTo(0.6, 10);
    expect(report.f1).toBeCloseTo(2 / 3, 10);
    expect(report.disagreements).toHaveLength(2);
  });

  /** With no actual positives, TPR is undefined, and the convention is 0. */
  it('ComputeConfusionMatrix_NoPositives_TPRIsZero', () => {
    const cases: HumanGradedCase[] = [
      makeCase('c1', false),
      makeCase('c2', false),
    ];
    const judgeVerdicts = makeVerdicts([
      ['c1', false, 'ok'],
      ['c2', false, 'ok'],
    ]);

    const report = computeConfusionMatrix(cases, judgeVerdicts, 'validation');

    expect(report.truePositives).toBe(0);
    expect(report.falseNegatives).toBe(0);
    expect(report.tpr).toBe(0);
    expect(report.tnr).toBe(1);
    expect(report.accuracy).toBe(1);
  });

  /** With no actual negatives, TNR is undefined, and the convention is 0. */
  it('ComputeConfusionMatrix_NoNegatives_TNRIsZero', () => {
    const cases: HumanGradedCase[] = [
      makeCase('c1', true),
      makeCase('c2', true),
    ];
    const judgeVerdicts = makeVerdicts([
      ['c1', true, 'ok'],
      ['c2', true, 'ok'],
    ]);

    const report = computeConfusionMatrix(cases, judgeVerdicts, 'validation');

    expect(report.trueNegatives).toBe(0);
    expect(report.falsePositives).toBe(0);
    expect(report.tnr).toBe(0);
    expect(report.tpr).toBe(1);
    expect(report.accuracy).toBe(1);
  });

  /** One true positive. TNR is 0 by convention, because there are no negatives. */
  it('ComputeConfusionMatrix_SingleCase_CorrectMetrics', () => {
    const cases: HumanGradedCase[] = [makeCase('c1', true)];
    const judgeVerdicts = makeVerdicts([['c1', true, 'correct']]);

    const report = computeConfusionMatrix(cases, judgeVerdicts, 'test');

    expect(report.totalCases).toBe(1);
    expect(report.truePositives).toBe(1);
    expect(report.trueNegatives).toBe(0);
    expect(report.falsePositives).toBe(0);
    expect(report.falseNegatives).toBe(0);
    expect(report.tpr).toBe(1);
    expect(report.tnr).toBe(0);
    expect(report.accuracy).toBe(1);
    expect(report.f1).toBe(1);
  });

  /** One FN (c1) and one FP (c2) give precision 0 and recall 0, so F1 is 0. */
  it('ComputeF1_PrecisionAndRecallZero_ReturnsZero', () => {
    const cases: HumanGradedCase[] = [
      makeCase('c1', true),
      makeCase('c2', false),
    ];
    const judgeVerdicts = makeVerdicts([
      ['c1', false, 'nope'],
      ['c2', true, 'yep'],
    ]);

    const report = computeConfusionMatrix(cases, judgeVerdicts, 'validation');

    expect(report.truePositives).toBe(0);
    expect(report.falsePositives).toBe(1);
    expect(report.falseNegatives).toBe(1);
    expect(report.f1).toBe(0);
  });
});

describe('extractDisagreements', () => {
  /** The judge agrees on c1. c2 is an FP and c3 is an FN, so they are the two disagreements. */
  it('ExtractDisagreements_MismatchedVerdicts_ReturnsDetails', () => {
    const cases: HumanGradedCase[] = [
      makeCase('c1', true, 'human says pass'),
      makeCase('c2', false, 'human says fail'),
      makeCase('c3', true, 'human says pass again'),
    ];
    const judgeVerdicts = makeVerdicts([
      ['c1', true, 'judge agrees'],
      ['c2', true, 'judge disagrees'],
      ['c3', false, 'judge missed'],
    ]);

    const disagreements = extractDisagreements(cases, judgeVerdicts);

    expect(disagreements).toHaveLength(2);

    const fp = disagreements.find(d => d.caseId === 'c2');
    expect(fp).toBeDefined();
    expect(fp!.humanVerdict).toBe(false);
    expect(fp!.judgeVerdict).toBe(true);
    expect(fp!.humanRationale).toBe('human says fail');
    expect(fp!.judgeReason).toBe('judge disagrees');

    const fn = disagreements.find(d => d.caseId === 'c3');
    expect(fn).toBeDefined();
    expect(fn!.humanVerdict).toBe(true);
    expect(fn!.judgeVerdict).toBe(false);
    expect(fn!.humanRationale).toBe('human says pass again');
    expect(fn!.judgeReason).toBe('judge missed');
  });

  it('ExtractDisagreements_AllAgree_ReturnsEmpty', () => {
    const cases: HumanGradedCase[] = [
      makeCase('c1', true),
      makeCase('c2', false),
    ];
    const judgeVerdicts = makeVerdicts([
      ['c1', true, 'ok'],
      ['c2', false, 'ok'],
    ]);

    const disagreements = extractDisagreements(cases, judgeVerdicts);
    expect(disagreements).toHaveLength(0);
  });
});

describe('Calibration Metrics Property Tests', () => {
  const arbHumanCase = fc.record({
    caseId: fc.uuid(),
    skill: fc.constant('test-skill'),
    rubricName: fc.constant('test-rubric'),
    humanVerdict: fc.boolean(),
    humanScore: fc.double({ min: 0, max: 1, noNaN: true }),
    humanRationale: fc.string({ minLength: 1 }),
  });

  const arbJudgeVerdict = fc.record({
    verdict: fc.boolean(),
    reason: fc.string({ minLength: 1 }),
  });

  it('AccuracyIdentity_TPTNFPFNSumEqualsTotal', () => {
    fc.assert(
      fc.property(
        fc.array(arbHumanCase, { minLength: 1, maxLength: 50 }),
        fc.array(fc.boolean(), { minLength: 50, maxLength: 50 }),
        (cases, verdicts) => {
          const judgeVerdicts = new Map<string, { verdict: boolean; reason: string }>();
          for (let i = 0; i < cases.length; i++) {
            judgeVerdicts.set(cases[i].caseId, {
              verdict: verdicts[i % verdicts.length],
              reason: 'auto',
            });
          }

          const report = computeConfusionMatrix(cases, judgeVerdicts, 'validation');
          expect(
            report.truePositives + report.trueNegatives +
            report.falsePositives + report.falseNegatives
          ).toBe(report.totalCases);
        },
      ),
    );
  });

  it('ScoreRange_AllMetricsBetweenZeroAndOne', () => {
    fc.assert(
      fc.property(
        fc.array(arbHumanCase, { minLength: 1, maxLength: 50 }),
        fc.array(arbJudgeVerdict, { minLength: 1, maxLength: 50 }),
        (cases, verdicts) => {
          const judgeVerdicts = new Map<string, { verdict: boolean; reason: string }>();
          const limit = Math.min(cases.length, verdicts.length);
          for (let i = 0; i < limit; i++) {
            judgeVerdicts.set(cases[i].caseId, verdicts[i]);
          }

          const report = computeConfusionMatrix(
            cases.slice(0, limit),
            judgeVerdicts,
            'test',
          );

          expect(report.tpr).toBeGreaterThanOrEqual(0);
          expect(report.tpr).toBeLessThanOrEqual(1);
          expect(report.tnr).toBeGreaterThanOrEqual(0);
          expect(report.tnr).toBeLessThanOrEqual(1);
          expect(report.accuracy).toBeGreaterThanOrEqual(0);
          expect(report.accuracy).toBeLessThanOrEqual(1);
          expect(report.f1).toBeGreaterThanOrEqual(0);
          expect(report.f1).toBeLessThanOrEqual(1);
        },
      ),
    );
  });

  /**
   * A judge that agrees with every human verdict gets accuracy 1. TPR and F1 are 1 when positives exist, and
   * TNR is 1 when negatives exist.
   */
  it('PerfectClassifier_AllCorrect_PerfectMetrics', () => {
    fc.assert(
      fc.property(
        fc.array(arbHumanCase, { minLength: 1, maxLength: 50 }),
        (cases) => {
          const judgeVerdicts = new Map<string, { verdict: boolean; reason: string }>();
          for (const c of cases) {
            judgeVerdicts.set(c.caseId, {
              verdict: c.humanVerdict,
              reason: 'agree',
            });
          }

          const report = computeConfusionMatrix(cases, judgeVerdicts, 'validation');

          expect(report.accuracy).toBe(1);
          expect(report.disagreements).toHaveLength(0);

          const hasPositives = cases.some(c => c.humanVerdict);
          const hasNegatives = cases.some(c => !c.humanVerdict);

          if (hasPositives) {
            expect(report.tpr).toBe(1);
          }
          if (hasNegatives) {
            expect(report.tnr).toBe(1);
          }
          if (hasPositives) {
            expect(report.f1).toBe(1);
          }
        },
      ),
    );
  });
});
