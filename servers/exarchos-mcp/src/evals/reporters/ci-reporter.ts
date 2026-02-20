import type { RunSummary, EvalResult } from '../types.js';

/**
 * Format failed assertion reasons into a single line for annotations.
 */
export function formatFailedAssertions(result: EvalResult): string {
  const failed = result.assertions.filter((a) => !a.passed);
  if (failed.length === 0) return 'No assertion details';
  return failed.map((a) => `${a.name}: ${a.reason}`).join('; ');
}

/**
 * Format eval summaries as GitHub Actions annotations.
 *
 * Uses `::error` for failed cases and `::notice` for suite summaries.
 * See: https://docs.github.com/en/actions/using-workflows/workflow-commands-for-github-actions#setting-an-error-message
 */
export function formatCIReport(summaries: RunSummary[]): string {
  if (summaries.length === 0) return '';

  const lines: string[] = [];

  for (const summary of summaries) {
    // Error annotations for each failed case
    for (const result of summary.results) {
      if (!result.passed) {
        lines.push(
          `::error title=Eval Regression: ${result.caseId}::${formatFailedAssertions(result)}`,
        );
      }
    }

    // Notice annotation for suite summary
    const scorePct = (summary.avgScore * 100).toFixed(1);
    lines.push(
      `::notice title=Eval: ${summary.suiteId}::${summary.passed}/${summary.total} passed (${scorePct}%)`,
    );
  }

  return lines.join('\n');
}
