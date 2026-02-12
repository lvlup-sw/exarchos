/**
 * Display formatting helpers for the Exarchos installer.
 *
 * Provides functions to format headers, prerequisite reports,
 * install summaries, and progress lines for terminal output.
 */

import type { PrerequisiteReport } from './prerequisites.js';

/** Result of a single install operation for display purposes. */
export interface InstallResult {
  /** Display label for the operation. */
  readonly label: string;
  /** Completion status. */
  readonly status: 'done' | 'skip' | 'fail';
  /** Optional detail message. */
  readonly detail?: string;
}

/** Status indicator characters. */
const STATUS_ICONS = {
  done: '\u2713', // ✓
  skip: '~',
  fail: '\u2717', // ✗
} as const;

/**
 * Format a header banner for the installer.
 *
 * @param title - The application title.
 * @param version - The version string.
 * @returns A formatted banner string.
 */
export function formatHeader(title: string, version: string): string {
  const line = `${title} v${version} \u2014 SDLC Workflow Automation`;
  const separator = '='.repeat(line.length);
  return `${line}\n${separator}`;
}

/**
 * Format a prerequisite check report for display.
 *
 * Shows each prerequisite with its version and found/not-found status.
 * Blockers include install hints.
 *
 * @param report - The prerequisite report to format.
 * @returns A formatted multi-line string.
 */
export function formatPrerequisiteReport(report: PrerequisiteReport): string {
  const lines: string[] = [];

  for (const result of report.results) {
    const icon = result.found && result.meetsMinVersion
      ? STATUS_ICONS.done
      : STATUS_ICONS.fail;
    const version = result.version ? ` (${result.version})` : '';
    const hint = !result.found || !result.meetsMinVersion
      ? ` — ${result.installHint}`
      : '';
    lines.push(`  ${icon} ${result.command}${version}${hint}`);
  }

  if (report.blockers.length > 0) {
    lines.push('');
    lines.push('Blockers:');
    for (const blocker of report.blockers) {
      lines.push(`  ${STATUS_ICONS.fail} ${blocker}`);
    }
  }

  return lines.join('\n');
}

/**
 * Format an install summary from a list of results.
 *
 * @param results - The install results to summarize.
 * @returns A formatted multi-line string.
 */
export function formatInstallSummary(results: InstallResult[]): string {
  const lines = results.map((r) => formatProgressLine(r.label, r.status, r.detail));
  return lines.join('\n');
}

/**
 * Format a single progress line with status indicator.
 *
 * @param label - The operation label.
 * @param status - The completion status.
 * @param detail - Optional detail message.
 * @returns A formatted single-line string.
 */
export function formatProgressLine(
  label: string,
  status: 'done' | 'skip' | 'fail',
  detail?: string,
): string {
  const icon = STATUS_ICONS[status];
  const suffix = detail ? ` — ${detail}` : '';
  return `  ${icon} ${label}${suffix}`;
}
