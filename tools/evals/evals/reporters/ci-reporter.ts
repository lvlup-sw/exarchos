import type { RunSummary, EvalResult } from '../types.js';

/**
 * Escape a string for use in a GitHub Actions annotation message body.
 * See: https://github.com/actions/toolkit/blob/main/packages/core/src/command.ts
 */
export function escapeCommandValue(value: string): string {
  return value.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
}

/**
 * Escape a string for use in a GitHub Actions annotation property (title, file, etc.).
 * Properties additionally need `:` and `,` escaped.
 */
export function escapeCommandProperty(value: string): string {
  return escapeCommandValue(value).replace(/:/g, '%3A').replace(/,/g, '%2C');
}

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
        const title = escapeCommandProperty(`Eval Regression: ${result.caseId}`);
        const message = escapeCommandValue(formatFailedAssertions(result));
        lines.push(`::error title=${title}::${message}`);
      }
    }

    // Notice annotation for suite summary
    const scorePct = (summary.avgScore * 100).toFixed(1);
    const skippedSuffix = summary.skipped > 0 ? `, ${summary.skipped} LLM skipped` : '';
    const noticeTitle = escapeCommandProperty(`Eval: ${summary.suiteId}`);
    const noticeMsg = escapeCommandValue(
      `${summary.passed}/${summary.total} passed (${scorePct}%)${skippedSuffix}`,
    );
    lines.push(`::notice title=${noticeTitle}::${noticeMsg}`);
  }

  return lines.join('\n');
}
