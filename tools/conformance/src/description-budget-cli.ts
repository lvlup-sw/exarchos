#!/usr/bin/env node
/**
 * CLI wrapper for the MCP description token-budget guard (issue #1321, R-E).
 * Wired into the root `package.json` as `npm run desc:budget-guard` and run in
 * CI (sibling to the other structural guards). Exits 1 if any enforced
 * description exceeds its budget, 0 otherwise.
 *
 * Uses `process.stdout.write` rather than `console.log` so the
 * NoConsoleInProduction guard (`src/logger.test.ts`) stays clean — CLI entry
 * points are production code under that scan — and `process.exitCode = N`
 * rather than `process.exit(N)` so buffered stdout flushes before exit (a
 * piped consumer can otherwise truncate the report). Mirrors
 * `vocabulary-lint-cli.ts`.
 */
import { formatBudgetReport } from './description-budget.js';
import { auditLiveDescriptionBudgets } from './bindings/index.js';

const report = auditLiveDescriptionBudgets();

process.stdout.write(`${formatBudgetReport(report)}\n`);

if (report.pass) {
  process.exitCode = 0;
} else {
  process.stdout.write(
    `\ndescription-budget: FAIL — ${report.offenders.length} description(s) over budget (#1321).\n`,
  );
  process.exitCode = 1;
}
