import type { RunSummary, EvalResult } from '../types.js';

const MAX_DESCRIPTION_LENGTH = 60;

/**
 * Truncate a string to a maximum length, adding ellipsis if needed.
 */
function truncate(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen - 1) + '\u2026';
}

/**
 * Format a single eval result line.
 */
function formatCaseResult(result: EvalResult): string {
  const indicator = result.passed ? '\u2713' : '\u2717';
  const desc = truncate(result.caseId, MAX_DESCRIPTION_LENGTH);
  const scorePct = (result.score * 100).toFixed(0);
  const line = `  ${indicator} ${desc}  score: ${scorePct}%  ${result.duration}ms`;

  if (result.passed) return line;

  // Show failed assertions
  const failedAssertions = result.assertions.filter((a) => !a.passed);
  const assertionLines = failedAssertions.map(
    (a) => `    \u2514\u2500 ${a.name}: ${a.reason}`,
  );

  return [line, ...assertionLines].join('\n');
}

/**
 * Format a run summary for a single suite into a printable string.
 */
export function formatRunSummary(summary: RunSummary): string {
  const headerLine = `\u2500\u2500 ${summary.suiteId} ${'─'.repeat(Math.max(0, 60 - summary.suiteId.length))}`;
  const caseLines = summary.results.map(formatCaseResult);

  const avgPct = (summary.avgScore * 100).toFixed(0);
  const skippedSuffix = summary.skipped > 0 ? ` (${summary.skipped} LLM assertions skipped)` : '';
  const footer = `${summary.total} cases: ${summary.passed} passed, ${summary.failed} failed | avg score: ${avgPct}% | ${summary.duration}ms${skippedSuffix}`;

  const sections = [headerLine];
  if (caseLines.length > 0) {
    sections.push(caseLines.join('\n'));
  }
  sections.push(footer);

  return sections.join('\n');
}

/**
 * Format multiple suite summaries into a combined report.
 * Only shows a grand total line when there is more than one suite.
 */
export function formatMultiSuiteReport(summaries: RunSummary[]): string {
  const sections = summaries.map(formatRunSummary);

  if (summaries.length > 1) {
    const totals = summaries.reduce(
      (acc, s) => ({
        cases: acc.cases + s.total,
        passed: acc.passed + s.passed,
        failed: acc.failed + s.failed,
        duration: acc.duration + s.duration,
        weightedScore: acc.weightedScore + s.avgScore * s.total,
      }),
      { cases: 0, passed: 0, failed: 0, duration: 0, weightedScore: 0 },
    );
    const grandAvg = totals.cases > 0 ? totals.weightedScore / totals.cases : 0;
    const avgPct = (grandAvg * 100).toFixed(0);

    const grandTotal = `\n${'═'.repeat(66)}\n${totals.cases} cases: ${totals.passed} passed, ${totals.failed} failed | avg score: ${avgPct}% | ${totals.duration}ms`;
    sections.push(grandTotal);
  }

  return sections.join('\n\n');
}
