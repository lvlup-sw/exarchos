#!/usr/bin/env node
/**
 * lint-envelopes runs `eslint --config eslint.envelopes.config.js`. Its `lint-*.mjs` name lets the
 * enforcer-wiring checker see it. The dedicated config replaces the shared `eslint.config.js`.
 *
 * The `envelopes/no-handler-throw` rule requires a registered MCP action handler to return
 * `ToolResult.error` and not let a throw escape. This wrapper holds no rule logic.
 *
 * Default target: `src/verbs/**\/*.ts`. The self-test uses the `--target` and `--config` flags.
 *
 * Exit 0: clean. Exit 1: ESLint reports errors. Exit 2: fail-closed, for a missing or failed eslint.
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
 * ESLint's JS entry point, run under `process.execPath`. On Windows, `npx` is a `.cmd` shim that
 * `spawnSync` cannot launch since CVE-2024-27980. A missing eslint is a missing file here, so the
 * gate fails closed with no network fallback.
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

/** Passes through ESLint exit 0 and 1. Any other status, null included, exits 2 (fail-closed). */
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
