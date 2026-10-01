#!/usr/bin/env node
/**
 * lint-envelopes: the error-envelope lint wrapper.
 *
 * A thin `node` wrapper around `eslint --config eslint.envelopes.config.js`. It is a `lint-*.mjs`
 * primary, so the enforcer-wiring checker can see it, and it runs on the unfiltered `grep-gates`
 * lane. The dedicated config replaces the shared `eslint.config.js` and is never merged into it.
 *
 * The `envelopes/no-handler-throw` rule requires a registered MCP action handler to return
 * `ToolResult.error`, never to let a throw escape. This wrapper owns no rule logic.
 *
 * Default target: `src/verbs/**\/*.ts`. The `--target` and `--config` flags exist for the self-test.
 *
 * Exit 0: clean. Exit 1: ESLint reports errors. Exit 2: fail-closed, because eslint is missing,
 * cannot start, or exits for another reason, such as a missing `--config` path.
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';
import process from 'node:process';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..', '..', '..');
const DEFAULT_CONFIG = path.join(REPO_ROOT, 'eslint.envelopes.config.js');
/**
 * ESLint's own JS entry point. Spawned under `process.execPath` rather than
 * shelling out to `npx`: `npx` is a `.cmd` shim on Windows and raw `spawnSync`
 * cannot launch one since CVE-2024-27980, so `spawnSync('npx', …)` returned
 * `status: null` on every Windows host — this wrapper's fail-closed arm then
 * reported "could not spawn eslint" and the lane never ran the rule at all.
 *
 * Resolving the entry point also keeps the property `--no-install` was there
 * for: a missing/un-installed eslint is a MISSING FILE here, so it fails closed
 * locally with no network fallback to reason about.
 */
const ESLINT_CLI = path.join(REPO_ROOT, 'node_modules', 'eslint', 'bin', 'eslint.js');
const DEFAULT_TARGET = 'src/verbs/**/*.ts';

const EXIT_CLEAN = 0;
const EXIT_VIOLATION = 1;
const EXIT_FAILCLOSED = 2;

function printUsage() {
  process.stderr.write(
    'Usage: node tools/audit/gates/lint-envelopes.mjs [--config <path>] [--target <glob>]\n' +
      '\n' +
      '  --config <path>   ESLint flat-config file (default: eslint.envelopes.config.js).\n' +
      '  --target <glob>   File(s) to lint (default: src/verbs/**/*.ts).\n' +
      '                    Both flags exist for testability only.\n',
  );
}

function fail(msg) {
  process.stderr.write(`lint-envelopes: ${msg}\n`);
  printUsage();
  process.exit(EXIT_FAILCLOSED);
}

function parseArgs(argv) {
  const args = { config: DEFAULT_CONFIG, target: DEFAULT_TARGET };
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      printUsage();
      process.exit(EXIT_CLEAN);
    } else if (arg === '--config') {
      const value = argv[++i];
      if (!value) fail('--config requires a path argument');
      args.config = path.resolve(value);
    } else if (arg === '--target') {
      const value = argv[++i];
      if (!value) fail('--target requires a glob argument');
      args.target = value;
    } else {
      fail(`Unknown argument: ${arg}`);
    }
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv);

  if (!existsSync(ESLINT_CLI)) {
    process.stderr.write(
      `lint-envelopes: eslint not installed at ${ESLINT_CLI} (fail-closed). ` +
        "Run 'npm install'.\n",
    );
    process.exit(EXIT_FAILCLOSED);
  }

  let result;
  try {
    result = spawnSync(
      process.execPath,
      [ESLINT_CLI, '--config', args.config, args.target],
      { cwd: REPO_ROOT, stdio: 'inherit' },
    );
  } catch (err) {
    process.stderr.write(
      `lint-envelopes: could not spawn eslint (fail-closed): ${err.message}\n`,
    );
    process.exit(EXIT_FAILCLOSED);
  }

  if (result.error) {
    process.stderr.write(
      `lint-envelopes: could not spawn eslint (fail-closed): ${result.error.message}\n`,
    );
    process.exit(EXIT_FAILCLOSED);
  }

  // ESLint's own exit codes: 0 clean, 1 lint errors found, 2 a fatal/usage
  // error (e.g. a missing config file, an unparseable glob). Propagate
  // directly rather than remapping — an unexpected/null status is treated as
  // fail-closed rather than assumed clean.
  const status = result.status;
  if (status === EXIT_CLEAN || status === EXIT_VIOLATION) {
    process.exit(status);
  }
  process.stderr.write(
    `lint-envelopes: eslint exited ${String(status)} (fail-closed)\n`,
  );
  process.exit(EXIT_FAILCLOSED);
}

main();
