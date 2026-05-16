#!/usr/bin/env node
/**
 * CLI wrapper for `vocabulary-lint`. Exits 1 if any findings, 0 otherwise.
 * Wired into the root `package.json` as `npm run lint:invariants`.
 */
import { scanRepoDefaults } from './vocabulary-lint.js';

const findings = scanRepoDefaults();

if (findings.length === 0) {
  console.log('vocabulary-lint: 0 findings (clean)');
  process.exit(0);
}

for (const f of findings) {
  console.log(`${f.file}:${f.line} ${f.kind} ${f.token}`);
}
console.log(`\nvocabulary-lint: ${findings.length} finding(s)`);
process.exit(1);
