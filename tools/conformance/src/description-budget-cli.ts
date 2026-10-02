#!/usr/bin/env node
/**
 * CLI for the MCP description token-budget guard. CI runs it as `npm run desc:budget-guard`.
 * It exits 1 when an enforced description is over its budget, and 0 otherwise.
 *
 * It sets `process.exitCode`, not `process.exit(N)`, so that buffered stdout flushes before
 * exit. Without this, a piped consumer can get a truncated report.
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
