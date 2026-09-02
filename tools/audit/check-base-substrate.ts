/**
 * check-base-substrate.ts — preflight validation for test-suite consolidation waves.
 *
 * Verifies that the #1719 coverage substrate is present on the base branch before
 * dispatching consolidation tasks. Asserts both:
 *   - tools/audit/coverage-baseline.json exists
 *   - tools/audit/gates/check-coverage-ratchet.mjs exists
 *
 * Exit 0 ("substrate present") when BOTH files exist.
 * Exit 1 ("substrate missing — abort dispatch") when either is absent.
 *
 * Accepts optional `--root <dir>` argument (default: cwd) to set the repo root
 * so the check can be unit-tested against arbitrary directory trees.
 */

import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const EXIT_OK = 0;
const EXIT_MISSING = 1;

export interface SubstrateCheckDeps {
  readonly fileExists: (filePath: string) => boolean;
  readonly log: (message: string) => void;
  readonly errlog: (message: string) => void;
}

/**
 * Verify the base-substrate files are present. Accepts a repoRoot (defaults to cwd)
 * so tests can point at arbitrary trees.
 */
export function checkBaseSubstrate(deps: SubstrateCheckDeps, repoRoot: string): number {
  const coverageBaseline = path.join(repoRoot, 'tools', 'audit', 'coverage-baseline.json');
  const coverageRatchet = path.join(repoRoot, 'tools', 'audit', 'gates', 'check-coverage-ratchet.mjs');

  const coverageBaselineExists = deps.fileExists(coverageBaseline);
  const coverageRatchetExists = deps.fileExists(coverageRatchet);

  if (!coverageBaselineExists && !coverageRatchetExists) {
    deps.errlog(
      '[check-base-substrate] FAIL: Both substrate files are missing:\n' +
        `  - ${coverageBaseline}\n` +
        `  - ${coverageRatchet}\n` +
        'The base branch is not ready for consolidation waves. Merge #1719 or a later commit to main.',
    );
    return EXIT_MISSING;
  }

  if (!coverageBaselineExists) {
    deps.errlog(
      '[check-base-substrate] FAIL: Substrate file missing:\n' +
        `  - ${coverageBaseline}\n` +
        'The base branch is not ready for consolidation waves. Merge #1719 or a later commit to main.',
    );
    return EXIT_MISSING;
  }

  if (!coverageRatchetExists) {
    deps.errlog(
      '[check-base-substrate] FAIL: Substrate file missing:\n' +
        `  - ${coverageRatchet}\n` +
        'The base branch is not ready for consolidation waves. Merge #1719 or a later commit to main.',
    );
    return EXIT_MISSING;
  }

  deps.log(
    '[check-base-substrate] OK: Base-substrate files present (' +
      `${path.basename(coverageBaseline)}, ${path.basename(coverageRatchet)}).`,
  );
  return EXIT_OK;
}

// ─── production wiring (only runs when invoked as a CLI) ────────────────────

function invokedAsCli(): boolean {
  const entry = process.argv[1];
  return entry !== undefined && path.resolve(entry) === fileURLToPath(import.meta.url);
}

function parseArgs(): { root: string } {
  const flag = process.argv.indexOf('--root');
  if (flag === -1) return { root: process.cwd() };
  // `--root` with no following argument previously produced `undefined`, which
  // then reached `path.join` and failed with a message about the wrong thing.
  // Fail on the actual mistake instead. (Surfaced by task 066, the first
  // typecheck this tree has ever had.)
  const value = process.argv[flag + 1];
  if (value === undefined) {
    throw new Error('[check-base-substrate] `--root` requires a directory path');
  }
  return { root: value };
}

if (invokedAsCli()) {
  const { root } = parseArgs();
  const exitCode = checkBaseSubstrate(
    {
      fileExists: existsSync,
      log: (message) => process.stdout.write(`${message}\n`),
      errlog: (message) => process.stderr.write(`${message}\n`),
    },
    root,
  );
  process.exit(exitCode);
}
