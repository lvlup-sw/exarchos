#!/usr/bin/env node
/**
 * CLI wrapper for `vocabulary-lint`. Exits 1 if any findings, 0 otherwise.
 * Wired into the root `package.json` as `npm run lint:invariants`.
 *
 * Uses `process.stdout.write` rather than `console.log` so the
 * NoConsoleInProduction guard in `src/logger.test.ts` stays clean — CLI
 * entry points are still production code under that test's scan.
 */
import { scanRepoDefaults } from './vocabulary-lint.js';

const findings = scanRepoDefaults();

if (findings.length === 0) {
  process.stdout.write('vocabulary-lint: 0 findings (clean)\n');
  process.exit(0);
}

for (const f of findings) {
  process.stdout.write(`${f.file}:${f.line} ${f.kind} ${f.token}\n`);
}
process.stdout.write(`\nvocabulary-lint: ${findings.length} finding(s)\n`);
process.exit(1);
