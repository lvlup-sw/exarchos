#!/usr/bin/env node
/**
 * Prefix-fingerprint CI gate (task T047, DR-12).
 *
 * Invoked from the root `npm run validate` chain. The purpose of this gate
 * is to catch silent drift in the rehydration document's stable-prefix
 * inputs (JSON schema shape + MCP tool description bytes). Any such drift
 * invalidates downstream prompt caches; DR-12 requires that the drift be
 * acknowledged by updating `PREFIX_FINGERPRINT` alongside the template edit
 * that caused it. CI fails when the committed hash does not match the live
 * computation.
 *
 *   Exit 0 — committed hash matches computed hash.
 *   Exit 1 — divergence (prints expected + actual to stderr).
 *   Exit 2 — usage / environment error (tsx not found, file unreadable).
 *
 * How we reach the hash:
 *   - The canonical computation lives in
 *     `servers/exarchos-mcp/src/projections/rehydration/fingerprint.ts`.
 *   - A tiny TS entrypoint (`fingerprint-cli.ts`, co-located with the
 *     module) prints `computePrefixFingerprint()` to stdout.
 *   - This `.mjs` shells out to `tsx` (devDep at the repo root) to execute
 *     that entrypoint. We deliberately avoid importing a compiled dist so
 *     the validate chain does not depend on a prior build step.
 *
 * Flags (primarily for testability):
 *   --fingerprint-file <path>   Path to the committed hash file. Defaults
 *                               to the co-located `PREFIX_FINGERPRINT`.
 *   --help                      Show usage.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';
import process from 'node:process';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..');
const DEFAULT_FINGERPRINT_FILE = path.join(
  REPO_ROOT,
  'servers',
  'exarchos-mcp',
  'src',
  'projections',
  'rehydration',
  'PREFIX_FINGERPRINT',
);
const CLI_ENTRY = path.join(
  REPO_ROOT,
  'servers',
  'exarchos-mcp',
  'src',
  'projections',
  'rehydration',
  'fingerprint-cli.ts',
);

/**
 * Resolve the tsx binary. Search order: root `node_modules/.bin/tsx` (the
 * devDep that is guaranteed installed by `npm install`), then the MCP
 * server's local `node_modules/.bin/tsx`, then `tsx` on PATH. We prefer
 * explicit paths over PATH so the check is reproducible across shells.
 *
 * @returns {string | null} absolute path to a tsx binary, or null if none.
 */
function resolveTsx() {
  const candidates = [
    path.join(REPO_ROOT, 'node_modules', '.bin', 'tsx'),
    path.join(
      REPO_ROOT,
      'servers',
      'exarchos-mcp',
      'node_modules',
      '.bin',
      'tsx',
    ),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  // PATH fallback — let spawnSync resolve it.
  return 'tsx';
}

/**
 * Parse argv. Returns `{ fingerprintFile }` or exits on usage error / help.
 *
 * @param {string[]} argv
 */
function parseArgs(argv) {
  let fingerprintFile = DEFAULT_FINGERPRINT_FILE;
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = argv[i + 1];
    switch (flag) {
      case '--fingerprint-file':
        if (!value) usageExit('--fingerprint-file requires a path');
        fingerprintFile = path.resolve(value);
        i++;
        break;
      case '-h':
      case '--help':
        printHelp();
        process.exit(0);
        break;
      default:
        usageExit(`unknown flag: ${flag}`);
    }
  }
  return { fingerprintFile };
}

/** @param {string} msg */
function usageExit(msg) {
  process.stderr.write(`check-prefix-fingerprint: ${msg}\n`);
  printHelp();
  process.exit(2);
}

function printHelp() {
  process.stderr.write(
    [
      'Usage: node scripts/check-prefix-fingerprint.mjs [--fingerprint-file <path>]',
      '',
      'Flags:',
      '  --fingerprint-file <path>  Path to the committed hash file.',
      '  --help                     Show this help message.',
      '',
      'Exit codes: 0 match, 1 divergence, 2 usage/env error.',
      '',
    ].join('\n'),
  );
}

/**
 * Invoke the TS entrypoint under tsx and return its stdout (the computed
 * hash). Exits 2 on spawn failure with a clear diagnostic.
 */
function computeHashViaTsx() {
  const tsx = resolveTsx();
  const result = spawnSync(tsx, [CLI_ENTRY], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env: { ...process.env },
  });

  if (result.error) {
    process.stderr.write(
      `check-prefix-fingerprint: failed to spawn tsx (${tsx}): ${result.error.message}\n`,
    );
    process.exit(2);
  }
  if (result.status !== 0) {
    process.stderr.write(
      'check-prefix-fingerprint: fingerprint computation failed\n' +
        `  tsx:    ${tsx}\n` +
        `  entry:  ${CLI_ENTRY}\n` +
        `  status: ${result.status}\n` +
        `  stderr: ${result.stderr ?? ''}\n`,
    );
    process.exit(2);
  }

  const computed = (result.stdout ?? '').trim();
  if (!/^[0-9a-f]{64}$/u.test(computed)) {
    process.stderr.write(
      `check-prefix-fingerprint: tsx stdout is not a sha256 hex digest: ${JSON.stringify(computed)}\n`,
    );
    process.exit(2);
  }
  return computed;
}

function main() {
  const { fingerprintFile } = parseArgs(process.argv.slice(2));

  if (!existsSync(fingerprintFile)) {
    process.stderr.write(
      `check-prefix-fingerprint: fingerprint file not found: ${fingerprintFile}\n`,
    );
    process.exit(2);
  }

  const expected = readFileSync(fingerprintFile, 'utf8').replace(/\s+$/u, '');
  const actual = computeHashViaTsx();

  if (expected === actual) {
    process.stdout.write(
      `check-prefix-fingerprint: OK (${actual})\n`,
    );
    process.exit(0);
  }

  process.stderr.write(
    [
      'check-prefix-fingerprint: FAIL — prefix fingerprint divergence (DR-12)',
      '',
      `  expected (from ${path.relative(REPO_ROOT, fingerprintFile)}):`,
      `    ${expected}`,
      '  actual   (computed from current schema + tool description):',
      `    ${actual}`,
      '',
      'If this divergence is intentional (you edited the stable-prefix inputs',
      'of the rehydration document), regenerate the committed hash:',
      '',
      '  cd servers/exarchos-mcp && npx tsx src/projections/rehydration/fingerprint-cli.ts \\',
      '    > src/projections/rehydration/PREFIX_FINGERPRINT',
      '',
      'and commit the updated file alongside the template change.',
      '',
    ].join('\n'),
  );
  process.exit(1);
}

main();
