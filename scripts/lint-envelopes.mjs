#!/usr/bin/env node
/**
 * lint-envelopes — error-envelope lint wrapper (#1706 DR-2).
 *
 * A thin `node` wrapper around `eslint --config eslint.envelopes.config.js`,
 * hosted as a `scripts/lint-*.mjs` PRIMARY so `scripts/check-enforcer-wiring.mjs`'s
 * manifest walker (pattern `^(check|lint)-.+\.(mjs|sh)$`) can see and reconcile
 * it — a bare `eslint …` invocation inline in a workflow step is invisible to
 * that walker. Runs on the UNFILTERED `grep-gates` lane, never the filtered
 * `test-root` `lint:windows` step (`ci.yml:114`), because `eslint.envelopes.config.js`
 * is a DEDICATED flat config (`--config` REPLACES the default `eslint.config.js`
 * ESLint would otherwise auto-discover) that is never merged into the shared
 * config `lint:windows` loads.
 *
 * The custom `envelopes/no-handler-throw` rule (`eslint-rules/no-handler-throw.js`)
 * enforces DR-1: a registered MCP action handler must return `ToolResult.error`,
 * never let a throw abnormally complete it. This wrapper is pure plumbing — it
 * owns none of that rule logic, only invocation + exit-code propagation.
 *
 * Default target: `servers/exarchos-mcp/src/orchestrate/**\/*.ts` — the
 * registration-set surface the rule type-checks. `--target`/`--config` exist
 * ONLY for testability (`scripts/lint-envelopes.test.sh` drives controlled
 * fixtures through the real wrapper without depending on the real tree's
 * current violation count); production usage (`npm run lint:envelopes`, the
 * `grep-gates` CI step) never passes them.
 *
 * Exit 0 — clean (ESLint reports zero errors).
 * Exit 1 — ESLint reports one or more errors (a registered handler can
 *          abnormally complete via a throw).
 * Exit 2 — fail-closed: eslint is not installed or could not be spawned, or
 *          exited for a reason other than reporting lint errors (e.g. a
 *          missing/unreadable `--config` path).
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';
import process from 'node:process';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..');
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
const DEFAULT_TARGET = 'servers/exarchos-mcp/src/orchestrate/**/*.ts';

const EXIT_CLEAN = 0;
const EXIT_VIOLATION = 1;
const EXIT_FAILCLOSED = 2;

function printUsage() {
  process.stderr.write(
    'Usage: node scripts/lint-envelopes.mjs [--config <path>] [--target <glob>]\n' +
      '\n' +
      '  --config <path>   ESLint flat-config file (default: eslint.envelopes.config.js).\n' +
      '  --target <glob>   File(s) to lint (default: servers/exarchos-mcp/src/orchestrate/**/*.ts).\n' +
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
