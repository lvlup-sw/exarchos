import type { HumanGradedCase, CalibrationReport } from './calibration-types.js';

// ─── Types ─────────────────────────────────────────────────────────────────

export interface JudgeVerdict {
  verdict: boolean;
  reason: string;
}

export interface Disagreement {
  caseId: string;
  humanVerdict: boolean;
  judgeVerdict: boolean;
  humanRationale: string;
  judgeReason: string;
}

// ─── extractDisagreements ──────────────────────────────────────────────────

/**
 * Filter human-graded cases to only those where the judge verdict disagrees
 * with the human verdict, returning structured disagreement details.
 */
export function extractDisagreements(
  cases: HumanGradedCase[],
  judgeVerdicts: Map<string, JudgeVerdict>,
): Disagreement[] {
  const disagreements: Disagreement[] = [];

  for (const humanCase of cases) {
    const judgeResult = judgeVerdicts.get(humanCase.caseId);
    if (!judgeResult) continue;

    if (humanCase.humanVerdict !== judgeResult.verdict) {
      disagreements.push({
        caseId: humanCase.caseId,
        humanVerdict: humanCase.humanVerdict,
        judgeVerdict: judgeResult.verdict,
        humanRationale: humanCase.humanRationale,
        judgeReason: judgeResult.reason,
      });
    }
  }

  return disagreements;
}

// ─── computeConfusionMatrix ────────────────────────────────────────────────

/**
 * Compute a full confusion matrix and derived metrics (TPR, TNR, accuracy, F1)
 * by comparing judge verdicts against a human gold standard.
 *
 * Convention for undefined rates:
 * - TPR is 0 when there are no actual positives (TP + FN = 0)
 * - TNR is 0 when there are no actual negatives (TN + FP = 0)
 * - F1 is 0 when precision + recall = 0
 */
export function computeConfusionMatrix(
  cases: HumanGradedCase[],
  judgeVerdicts: Map<string, JudgeVerdict>,
  split: 'validation' | 'test',
): CalibrationReport {
  let tp = 0;
  let tn = 0;
  let fp = 0;
  let fn = 0;

  for (const humanCase of cases) {
    const judgeResult = judgeVerdicts.get(humanCase.caseId);
    if (!judgeResult) continue;

    const humanPass = humanCase.humanVerdict;
    const judgePass = judgeResult.verdict;

    if (humanPass && judgePass) {
      tp++;
    } else if (!humanPass && !judgePass) {
      tn++;
    } else if (!humanPass && judgePass) {
      fp++;
    } else {
      // humanPass && !judgePass
      fn++;
    }
  }

  const total = tp + tn + fp + fn;

  // Derived rates with safe division
  const tpr = safeDivide(tp, tp + fn);
  const tnr = safeDivide(tn, tn + fp);
  const accuracy = safeDivide(tp + tn, total);
  const precision = safeDivide(tp, tp + fp);
  const recall = tpr;
  const f1 = safeDivide(2 * precision * recall, precision + recall);

  // Extract skill and rubricName from the first case
  const firstCase = cases[0];
  const skill = firstCase?.skill ?? '';
  const rubricName = firstCase?.rubricName ?? '';

  const disagreements = extractDisagreements(cases, judgeVerdicts);

  return {
    skill,
    rubricName,
    split,
    totalCases: total,
    truePositives: tp,
    trueNegatives: tn,
    falsePositives: fp,
    falseNegatives: fn,
    tpr,
    tnr,
    accuracy,
    f1,
    disagreements,
  };
}

// ─── Utilities ─────────────────────────────────────────────────────────────

/**
 * Safe division: returns 0 when the denominator is 0.
 */
function safeDivide(numerator: number, denominator: number): number {
  if (denominator === 0) return 0;
  return numerator / denominator;
}
