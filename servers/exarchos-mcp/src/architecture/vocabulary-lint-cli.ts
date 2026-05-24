#!/usr/bin/env node
/**
 * CLI wrapper for `vocabulary-lint`. Sets exitCode 1 if any findings, 0 otherwise.
 * Wired into the root `package.json` as `npm run lint:invariants`.
 *
 * Uses `process.stdout.write` rather than `console.log` so the
 * NoConsoleInProduction guard in `src/logger.test.ts` stays clean — CLI
 * entry points are still production code under that test's scan.
 *
 * Uses `process.exitCode = N` (rather than `process.exit(N)`) so buffered
 * stdout writes flush completely before the process terminates — see
 * https://nodejs.org/api/process.html#processexitcode_1. With `process.exit`,
 * piped output can be truncated when the consumer drains slowly.
 */
import { scanRepoDefaults, scanCoverageClosure } from './vocabulary-lint.js';

const findings = scanRepoDefaults();
// Coverage-closure check (DR-8): every DIM-* must be specialized by an INV-*
// or carry an explicit `coverage: n/a` marker. Additive to the token scan;
// both feed the same non-zero exit so CI fails on either class of finding.
const coverageFindings = scanCoverageClosure();

const total = findings.length + coverageFindings.length;

if (total === 0) {
  process.stdout.write('vocabulary-lint: 0 findings (clean)\n');
  process.exitCode = 0;
} else {
  for (const f of findings) {
    process.stdout.write(`${f.file}:${f.line} ${f.kind} ${f.token}\n`);
  }
  for (const f of coverageFindings) {
    process.stdout.write(
      `${f.file}:${f.line} ${f.kind} ${f.token} (no specializing INV-* and no \`coverage: n/a\` marker)\n`,
    );
  }
  process.stdout.write(`vocabulary-lint: ${total} finding(s)\n`);
  process.exitCode = 1;
}
