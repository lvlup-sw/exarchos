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
 *
 * Runs the four `.md`-surface scan (`scanRepoDefaults`) and the MCP registry
 * action scan (`scanRegistryActions`, DR-4/DR-5, issue #1706 task 005) and
 * merges their findings into one report sharing a single exit-code contract
 * — a finding from either source flips the same non-zero exit, printed in
 * the same `file:line kind token` format. `scanRegistryActions` uses its
 * default loader (a lazy `import()` of the real registry), so this CLI run
 * exercises the live MCP composite-tool set, not a fixture.
 */
import { scanRepoDefaults, scanRegistryActions } from './vocabulary-lint.js';

const findings = [...scanRepoDefaults(), ...(await scanRegistryActions())];

// The coverage-closure check (DR-8) was removed with the axiom excision
// (#1477) — the DIM-* axiom dimensions and the `axiom_overlap` field it
// depended on no longer exist. The token scan is now the sole lint pass.
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
