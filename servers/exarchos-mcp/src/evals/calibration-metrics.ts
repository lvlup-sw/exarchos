import type { ConfusionMatrix, Disagreement, HumanGradedCase } from './calibration-types.js';

/**
 * A single verdict comparison: human vs. judge.
 */
export interface VerdictPair {
  caseId: string;
  skill: string;
  humanVerdict: 'pass' | 'fail';
  judgeVerdict: 'pass' | 'fail';
  rubric: string;
  output: string;
  reason: string;
}

/**
 * Compute a confusion matrix from a list of verdict pairs.
 * "Positive" = pass, "Negative" = fail.
 */
export function computeConfusionMatrix(pairs: VerdictPair[]): ConfusionMatrix {
  let tp = 0;
  let fp = 0;
  let tn = 0;
  let fn = 0;

  for (const pair of pairs) {
    if (pair.humanVerdict === 'pass' && pair.judgeVerdict === 'pass') tp++;
    else if (pair.humanVerdict === 'fail' && pair.judgeVerdict === 'pass') fp++;
    else if (pair.humanVerdict === 'fail' && pair.judgeVerdict === 'fail') tn++;
    else if (pair.humanVerdict === 'pass' && pair.judgeVerdict === 'fail') fn++;
  }

  const total = tp + fp + tn + fn;
  const accuracy = total > 0 ? (tp + tn) / total : 0;
  const precision = tp + fp > 0 ? tp / (tp + fp) : 0;
  const recall = tp + fn > 0 ? tp / (tp + fn) : 0;
  const f1 = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;

  return {
    truePositives: tp,
    falsePositives: fp,
    trueNegatives: tn,
    falseNegatives: fn,
    accuracy,
    precision,
    recall,
    f1,
  };
}

/**
 * Extract disagreements from verdict pairs (cases where human and judge disagree).
 */
export function extractDisagreements(pairs: VerdictPair[]): Disagreement[] {
  return pairs
    .filter((p) => p.humanVerdict !== p.judgeVerdict)
    .map((p) => ({
      caseId: p.caseId,
      skill: p.skill,
      humanVerdict: p.humanVerdict,
      judgeVerdict: p.judgeVerdict,
      rubric: p.rubric,
      output: p.output,
      reason: p.reason,
    }));
}
