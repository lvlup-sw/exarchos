#!/usr/bin/env node
/**
 * CLI wrapper for `vocabulary-lint`, run as `npm run lint:invariants`. It sets exit code 1 on any finding.
 * It merges the findings of `scanRepoDefaults` (the `.md` surfaces) and `scanRegistryActions` (the live MCP registry).
 *
 * It writes with `process.stdout.write`, so the console guard in `tests/unit/logger.test.ts` stays clean.
 * It sets `process.exitCode` and does not call `process.exit`.
 * Thus piped output flushes completely before the process stops.
 */
import { scanRepoDefaults, scanRegistryActions } from './vocabulary-lint.js';

const findings = [...scanRepoDefaults(), ...(await scanRegistryActions())];

if (findings.length === 0) {
  process.stdout.write('vocabulary-lint: 0 findings (clean)\n');
  process.exitCode = 0;
} else {
  for (const f of findings) {
    process.stdout.write(`${f.file}:${f.line} ${f.kind} ${f.token}\n`);
  }
  process.stdout.write(`vocabulary-lint: ${findings.length} finding(s)\n`);
  process.exitCode = 1;
}
