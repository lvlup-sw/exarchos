import { describe, it, expect } from 'vitest';
import { fc } from '@fast-check/vitest';
import type { HumanGradedCase } from '../calibration-types.js';
import { computeConfusionMatrix, extractDisagreements } from '../calibration-metrics.js';

// ─── Helpers ───────────────────────────────────────────────────────────────

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

// ─── computeConfusionMatrix ────────────────────────────────────────────────

describe('computeConfusionMatrix', () => {
  it('ComputeConfusionMatrix_AllCorrect_PerfectScores', () => {
    // Arrange: 3 true positives + 2 true negatives = all correct
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

    // Act
    const report = computeConfusionMatrix(cases, judgeVerdicts, 'validation');

    // Assert
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
    // Arrange: judge always disagrees with human
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

    // Act
    const report = computeConfusionMatrix(cases, judgeVerdicts, 'test');

    // Assert
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

  it('ComputeConfusionMatrix_MixedResults_CorrectTPRTNR', () => {
    // Arrange: 2 TP, 1 TN, 1 FP, 1 FN
    const cases: HumanGradedCase[] = [
      makeCase('c1', true),   // TP
      makeCase('c2', true),   // TP
      makeCase('c3', true),   // FN (judge says false)
      makeCase('c4', false),  // TN
      makeCase('c5', false),  // FP (judge says true)
    ];
    const judgeVerdicts = makeVerdicts([
      ['c1', true, 'ok'],
      ['c2', true, 'ok'],
      ['c3', false, 'missed'],
      ['c4', false, 'ok'],
      ['c5', true, 'oops'],
    ]);

    // Act
    const report = computeConfusionMatrix(cases, judgeVerdicts, 'validation');

    // Assert
    expect(report.truePositives).toBe(2);
    expect(report.trueNegatives).toBe(1);
    expect(report.falsePositives).toBe(1);
    expect(report.falseNegatives).toBe(1);
    // TPR = TP / (TP + FN) = 2 / (2 + 1) = 2/3
    expect(report.tpr).toBeCloseTo(2 / 3, 10);
    // TNR = TN / (TN + FP) = 1 / (1 + 1) = 0.5
    expect(report.tnr).toBeCloseTo(0.5, 10);
    // Accuracy = (TP + TN) / total = 3 / 5 = 0.6
    expect(report.accuracy).toBeCloseTo(0.6, 10);
    // Precision = TP / (TP + FP) = 2/3
    // Recall = TP / (TP + FN) = 2/3
    // F1 = 2 * (2/3 * 2/3) / (2/3 + 2/3) = 2/3
    expect(report.f1).toBeCloseTo(2 / 3, 10);
    expect(report.disagreements).toHaveLength(2);
  });

  it('ComputeConfusionMatrix_NoPositives_TPRIsZero', () => {
    // Arrange: all human verdicts are false (no positives)
    const cases: HumanGradedCase[] = [
      makeCase('c1', false),
      makeCase('c2', false),
    ];
    const judgeVerdicts = makeVerdicts([
      ['c1', false, 'ok'],
      ['c2', false, 'ok'],
    ]);

    // Act
    const report = computeConfusionMatrix(cases, judgeVerdicts, 'validation');

    // Assert — no actual positives, so TPR is undefined; convention: 0
    expect(report.truePositives).toBe(0);
    expect(report.falseNegatives).toBe(0);
    expect(report.tpr).toBe(0);
    expect(report.tnr).toBe(1);
    expect(report.accuracy).toBe(1);
  });

  it('ComputeConfusionMatrix_NoNegatives_TNRIsZero', () => {
    // Arrange: all human verdicts are true (no negatives)
    const cases: HumanGradedCase[] = [
      makeCase('c1', true),
      makeCase('c2', true),
    ];
    const judgeVerdicts = makeVerdicts([
      ['c1', true, 'ok'],
      ['c2', true, 'ok'],
    ]);

    // Act
    const report = computeConfusionMatrix(cases, judgeVerdicts, 'validation');

    // Assert — no actual negatives, so TNR is undefined; convention: 0
    expect(report.trueNegatives).toBe(0);
    expect(report.falsePositives).toBe(0);
    expect(report.tnr).toBe(0);
    expect(report.tpr).toBe(1);
    expect(report.accuracy).toBe(1);
  });

  it('ComputeConfusionMatrix_SingleCase_CorrectMetrics', () => {
    // Arrange: single true positive
    const cases: HumanGradedCase[] = [makeCase('c1', true)];
    const judgeVerdicts = makeVerdicts([['c1', true, 'correct']]);

    // Act
    const report = computeConfusionMatrix(cases, judgeVerdicts, 'test');

    // Assert
    expect(report.totalCases).toBe(1);
    expect(report.truePositives).toBe(1);
    expect(report.trueNegatives).toBe(0);
    expect(report.falsePositives).toBe(0);
    expect(report.falseNegatives).toBe(0);
    expect(report.tpr).toBe(1);
    expect(report.tnr).toBe(0); // no negatives → convention 0
    expect(report.accuracy).toBe(1);
    expect(report.f1).toBe(1);
  });

  it('ComputeF1_PrecisionAndRecallZero_ReturnsZero', () => {
    // Arrange: 1 FP, 1 FN — precision=0, recall=0
    const cases: HumanGradedCase[] = [
      makeCase('c1', true),  // FN: judge says false
      makeCase('c2', false), // FP: judge says true
    ];
    const judgeVerdicts = makeVerdicts([
      ['c1', false, 'nope'],
      ['c2', true, 'yep'],
    ]);

    // Act
    const report = computeConfusionMatrix(cases, judgeVerdicts, 'validation');

    // Assert — precision = TP/(TP+FP) = 0/1 = 0, recall = TP/(TP+FN) = 0/1 = 0 → F1 = 0
    expect(report.truePositives).toBe(0);
    expect(report.falsePositives).toBe(1);
    expect(report.falseNegatives).toBe(1);
    expect(report.f1).toBe(0);
  });
});

// ─── extractDisagreements ──────────────────────────────────────────────────

describe('extractDisagreements', () => {
  it('ExtractDisagreements_MismatchedVerdicts_ReturnsDetails', () => {
    // Arrange
    const cases: HumanGradedCase[] = [
      makeCase('c1', true, 'human says pass'),
      makeCase('c2', false, 'human says fail'),
      makeCase('c3', true, 'human says pass again'),
    ];
    const judgeVerdicts = makeVerdicts([
      ['c1', true, 'judge agrees'],   // agree — not a disagreement
      ['c2', true, 'judge disagrees'], // disagree: FP
      ['c3', false, 'judge missed'],   // disagree: FN
    ]);

    // Act
    const disagreements = extractDisagreements(cases, judgeVerdicts);

    // Assert
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

// ─── Property-Based Tests ──────────────────────────────────────────────────

describe('Calibration Metrics Property Tests', () => {
  // Arbitrary generators
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
          // Generate matching judge verdicts deterministically from fast-check
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
          // Pair up: use min(cases, verdicts) to build the map
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

  it('PerfectClassifier_AllCorrect_PerfectMetrics', () => {
    fc.assert(
      fc.property(
        fc.array(arbHumanCase, { minLength: 1, maxLength: 50 }),
        (cases) => {
          // Judge agrees with every human verdict
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

          // TPR = 1 if there are any positives, else 0
          const hasPositives = cases.some(c => c.humanVerdict);
          const hasNegatives = cases.some(c => !c.humanVerdict);

          if (hasPositives) {
            expect(report.tpr).toBe(1);
          }
          if (hasNegatives) {
            expect(report.tnr).toBe(1);
          }
          if (hasPositives) {
            // F1 is defined when there are positives
            expect(report.f1).toBe(1);
          }
        },
      ),
    );
  });
});
