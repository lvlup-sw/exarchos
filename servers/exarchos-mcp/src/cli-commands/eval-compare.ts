import * as fs from 'node:fs/promises';
import { compareRuns } from '../evals/comparison.js';
import type { RunSummary } from '../evals/types.js';
import type { CommandResult } from '../cli.js';

/**
 * Load a RunSummary from a JSON file path.
 */
async function loadRunSummary(filePath: string): Promise<RunSummary> {
  const content = await fs.readFile(filePath, 'utf-8');
  return JSON.parse(content) as RunSummary;
}

/**
 * Handle the eval-compare CLI command.
 *
 * Compares two eval run summaries (baseline vs candidate) and produces
 * a comparison report identifying regressions, improvements, and score deltas.
 */
export async function handleEvalCompare(
  stdinData: Record<string, unknown>,
  _stateDir: string,
): Promise<CommandResult> {
  const baselinePath = stdinData['baseline'];
  const candidatePath = stdinData['candidate'];

  if (typeof baselinePath !== 'string' || baselinePath.length === 0) {
    return {
      error: {
        code: 'MISSING_BASELINE',
        message: 'Required field "baseline" (file path or run ID) is missing or empty.',
      },
    };
  }

  if (typeof candidatePath !== 'string' || candidatePath.length === 0) {
    return {
      error: {
        code: 'MISSING_CANDIDATE',
        message: 'Required field "candidate" (file path or run ID) is missing or empty.',
      },
    };
  }

  let baseline: RunSummary;
  let candidate: RunSummary;

  try {
    baseline = await loadRunSummary(baselinePath);
  } catch (err: unknown) {
    return {
      error: {
        code: 'LOAD_FAILED',
        message: `Failed to load baseline: ${err instanceof Error ? err.message : String(err)}`,
      },
    };
  }

  try {
    candidate = await loadRunSummary(candidatePath);
  } catch (err: unknown) {
    return {
      error: {
        code: 'LOAD_FAILED',
        message: `Failed to load candidate: ${err instanceof Error ? err.message : String(err)}`,
      },
    };
  }

  const report = compareRuns(baseline, candidate);

  return {
    verdict: report.verdict,
    report,
    baseline: { runId: baseline.runId, suiteId: baseline.suiteId },
    candidate: { runId: candidate.runId, suiteId: candidate.suiteId },
  };
}
