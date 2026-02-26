import { loadGoldStandard } from '../evals/calibration-types.js';
import { filterBySplit } from '../evals/calibration-split.js';
import { computeConfusionMatrix, extractDisagreements } from '../evals/calibration-metrics.js';
import { createDefaultRegistry } from '../evals/graders/index.js';
import type { CalibrateInput, CalibrationReport, ConfusionMatrix } from '../evals/calibration-types.js';
import type { VerdictPair } from '../evals/calibration-metrics.js';
import type { CommandResult } from '../cli.js';

const EMPTY_CONFUSION_MATRIX: ConfusionMatrix = {
  truePositives: 0,
  falsePositives: 0,
  trueNegatives: 0,
  falseNegatives: 0,
  accuracy: 0,
  precision: 0,
  recall: 0,
  f1: 0,
};

/**
 * Handle the eval-calibrate CLI command.
 *
 * Loads a gold standard JSONL, filters by split, runs LLM graders against
 * human verdicts, computes a confusion matrix, and outputs a CalibrationReport.
 */
export async function handleCalibrate(
  input: CalibrateInput,
): Promise<CommandResult> {
  // Load gold standard cases
  let allCases: ReturnType<typeof loadGoldStandard>;
  try {
    allCases = loadGoldStandard(input.goldStandardPath);
  } catch (err: unknown) {
    return {
      error: {
        code: 'LOAD_FAILED',
        message: `Failed to load gold standard: ${err instanceof Error ? err.message : String(err)}`,
      },
    };
  }

  // Filter by split
  const splitCases = filterBySplit(allCases, input.split);

  // Optionally filter by skill
  const filteredCases = input.skill
    ? splitCases.filter((c) => c.skill === input.skill)
    : splitCases;

  // Empty split: return empty report
  if (filteredCases.length === 0) {
    return {
      report: {
        split: input.split,
        totalCases: 0,
        gradedCases: 0,
        skippedCases: 0,
        confusionMatrix: EMPTY_CONFUSION_MATRIX,
        disagreements: [],
        ...(input.skill ? { skill: input.skill } : {}),
      } satisfies CalibrationReport,
    };
  }

  // Run LLM grader against each case
  const registry = createDefaultRegistry();
  const grader = registry.resolve('llm-rubric');
  const verdictPairs: VerdictPair[] = [];
  let skippedCount = 0;

  for (const c of filteredCases) {
    const result = await grader.grade(
      { output: c.output },
      { output: c.output },
      {},
      { rubric: c.rubric },
    );

    // Check if grader skipped (e.g., no API key)
    const isSkipped = result.details?.['skipped'] === true;
    if (isSkipped) {
      skippedCount++;
      continue;
    }

    const judgeVerdict: 'pass' | 'fail' = result.passed ? 'pass' : 'fail';
    verdictPairs.push({
      caseId: c.id,
      skill: c.skill,
      humanVerdict: c.humanVerdict,
      judgeVerdict,
      rubric: c.rubric,
      output: c.output,
      reason: result.reason,
    });
  }

  // Compute confusion matrix and extract disagreements
  const confusionMatrix = computeConfusionMatrix(verdictPairs);
  const disagreements = extractDisagreements(verdictPairs);

  const report: CalibrationReport = {
    split: input.split,
    totalCases: filteredCases.length,
    gradedCases: verdictPairs.length,
    skippedCases: skippedCount,
    confusionMatrix,
    disagreements,
    ...(input.skill ? { skill: input.skill } : {}),
  };

  return { report };
}
