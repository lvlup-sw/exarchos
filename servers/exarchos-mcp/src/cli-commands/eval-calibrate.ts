import { loadGoldStandard } from '../evals/calibration-types.js';
import { filterBySplit } from '../evals/calibration-split.js';
import { computeConfusionMatrix } from '../evals/calibration-metrics.js';
import { createDefaultRegistry } from '../evals/graders/index.js';
import type { CalibrateInput, CalibrationReport } from '../evals/calibration-types.js';
import type { JudgeVerdict } from '../evals/calibration-metrics.js';
import type { CommandResult } from '../cli.js';

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
  let allCases: Awaited<ReturnType<typeof loadGoldStandard>>;
  try {
    allCases = await loadGoldStandard(input.goldStandardPath);
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

  // Empty split: return zeroed report
  if (filteredCases.length === 0) {
    const emptyReport: CalibrationReport = {
      skill: input.skill ?? '',
      rubricName: '',
      split: input.split,
      totalCases: 0,
      truePositives: 0,
      trueNegatives: 0,
      falsePositives: 0,
      falseNegatives: 0,
      tpr: 0,
      tnr: 0,
      accuracy: 0,
      f1: 0,
      disagreements: [],
    };
    return { report: emptyReport };
  }

  // Run LLM grader against each case
  const registry = createDefaultRegistry();
  const grader = registry.resolve('llm-rubric');
  const judgeVerdicts = new Map<string, JudgeVerdict>();
  let skippedCount = 0;

  for (const c of filteredCases) {
    const result = await grader.grade(
      { output: c.graderOutput ?? {} },
      { output: c.graderOutput ?? {} },
      {},
      { rubric: c.rubricName },
    );

    // Check if grader skipped (e.g., no API key)
    const isSkipped = result.details?.['skipped'] === true;
    if (isSkipped) {
      skippedCount++;
      continue;
    }

    judgeVerdicts.set(c.caseId, {
      verdict: result.passed,
      reason: result.reason,
    });
  }

  // Compute confusion matrix (returns full CalibrationReport)
  const report = computeConfusionMatrix(filteredCases, judgeVerdicts, input.split);

  return {
    report,
    gradedCases: judgeVerdicts.size,
    skippedCases: skippedCount,
  };
}
