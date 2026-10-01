#!/usr/bin/env node
/**
 * CI gate for the rehydration prefix fingerprint.
 *
 * The stable-prefix inputs of the rehydration document are the JSON schema shape
 * and the MCP tool description bytes. A change to them invalidates downstream
 * prompt caches. The gate fails until the same change updates the committed
 * `PREFIX_FINGERPRINT` hash.
 *
 *   Exit 0: the committed hash matches the computed hash.
 *   Exit 1: the hashes differ. The gate prints both to stderr.
 *   Exit 2: a usage or environment error.
 *
 * The gate runs `src/projections/rehydration/fingerprint-cli.ts` under `tsx`, so
 * it needs no prior build step.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';
import process from 'node:process';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..', '..', '..');
const DEFAULT_FINGERPRINT_FILE = path.join(
  REPO_ROOT,
  'src',
  'projections',
  'rehydration',
  'PREFIX_FINGERPRINT',
);
const CLI_ENTRY = path.join(
  REPO_ROOT,
  'src',
  'projections',
  'rehydration',
  'fingerprint-cli.ts',
);

/**
 * Resolves how to start `tsx` and returns `{ command, args }` for `spawnSync`.
 * It prefers `tsx/dist/cli.mjs` under `process.execPath` to the
 * `node_modules/.bin/tsx` shim. On win32 the shim has no `.exe` or `.cmd`
 * extension, so it cannot start without `shell: true`. If no candidate exists,
 * `spawnSync` resolves `tsx` on PATH.
 */
function resolveTsx() {
  const candidates = [
    path.join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs'),
    path.join(
      REPO_ROOT,
      'node_modules',
      'tsx',
      'dist',
      'cli.mjs',
    ),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return { command: process.execPath, args: [candidate] };
  }
  return { command: 'tsx', args: [] };
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
      'Usage: node tools/audit/gates/check-prefix-fingerprint.mjs [--fingerprint-file <path>]',
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
  const { command, args } = resolveTsx();
  const result = spawnSync(command, [...args, CLI_ENTRY], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env: { ...process.env },
  });

  if (result.error) {
    process.stderr.write(
      `check-prefix-fingerprint: failed to spawn tsx (${command}): ${result.error.message}\n`,
    );
    process.exit(2);
  }
  if (result.status !== 0) {
    process.stderr.write(
      'check-prefix-fingerprint: fingerprint computation failed\n' +
        `  tsx:    ${command} ${args.join(' ')}\n` +
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
      '  npx tsx src/projections/rehydration/fingerprint-cli.ts \\',
      '    > src/projections/rehydration/PREFIX_FINGERPRINT',
      '',
      'and commit the updated file alongside the template change.',
      '',
    ].join('\n'),
  );
  process.exit(1);
}

main();
