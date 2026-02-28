import { loadGoldStandard } from '../evals/calibration-types.js';
import { filterBySplit } from '../evals/calibration-split.js';
import { computeConfusionMatrix } from '../evals/calibration-metrics.js';
import { createDefaultRegistry } from '../evals/graders/index.js';
import { discoverSuites } from '../evals/harness.js';
import type { CalibrateInput, CalibrationReport } from '../evals/calibration-types.js';
import type { JudgeVerdict } from '../evals/calibration-metrics.js';
import type { CommandResult } from '../cli.js';

/**
 * Build a lookup map from `${skill}:${assertionName}` to the assertion's config
 * for all llm-rubric assertions across discovered suites. This allows the
 * calibration handler to pass the full rubric text and outputPath to the grader.
 */
export function buildRubricConfigMap(
  suites: Awaited<ReturnType<typeof discoverSuites>>,
): Map<string, Record<string, unknown>> {
  const map = new Map<string, Record<string, unknown>>();
  for (const suite of suites) {
    const skill = suite.config.metadata.skill;
    for (const assertion of suite.config.assertions) {
      if (assertion.type === 'llm-rubric' && assertion.config) {
        const key = `${skill}:${assertion.name}`;
        map.set(key, assertion.config as Record<string, unknown>);
      }
    }
  }
  return map;
}

/**
 * Handle the eval-calibrate CLI command.
 *
 * Loads a gold standard JSONL, filters by split, resolves rubric configs from
 * suite.json files, runs LLM graders against human verdicts, computes a
 * confusion matrix, and outputs a CalibrationReport.
 */
export async function handleCalibrate(
  input: CalibrateInput,
  evalsDir: string,
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

  // Discover suites and build rubric config lookup
  let rubricConfigMap: Map<string, Record<string, unknown>>;
  try {
    const suites = await discoverSuites(evalsDir);
    rubricConfigMap = buildRubricConfigMap(suites);
  } catch (err: unknown) {
    return {
      error: {
        code: 'SUITE_DISCOVERY_FAILED',
        message: `Failed to discover eval suites: ${err instanceof Error ? err.message : String(err)}`,
      },
    };
  }

  // Run LLM grader against each case
  const registry = createDefaultRegistry();
  let grader: ReturnType<typeof registry.resolve>;
  try {
    grader = registry.resolve('llm-rubric');
  } catch (err: unknown) {
    return {
      error: {
        code: 'GRADER_RESOLVE_FAILED',
        message: `Failed to resolve llm-rubric grader: ${err instanceof Error ? err.message : String(err)}`,
      },
    };
  }
  const judgeVerdicts = new Map<string, JudgeVerdict>();
  let skippedCount = 0;

  for (const c of filteredCases) {
    // Look up the full assertion config (rubric text + outputPath) from suite.json
    const rubricKey = `${c.skill}:${c.rubricName}`;
    const assertionConfig = rubricConfigMap.get(rubricKey);
    if (!assertionConfig) {
      return {
        error: {
          code: 'RUBRIC_NOT_FOUND',
          message: `No llm-rubric assertion named '${c.rubricName}' found in suite for skill '${c.skill}'`,
        },
      };
    }

    let result: Awaited<ReturnType<typeof grader.grade>>;
    try {
      result = await grader.grade(
        c.graderOutput ?? {},
        c.graderOutput ?? {},
        {},
        assertionConfig,
      );
    } catch (err: unknown) {
      return {
        error: {
          code: 'GRADING_FAILED',
          message: `Failed to grade case ${c.caseId}: ${err instanceof Error ? err.message : String(err)}`,
        },
      };
    }

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
