/**
 * Preflight check for test-suite consolidation. It confirms that the coverage
 * baseline and the coverage ratchet gate exist under the repo root.
 *
 * Exit 0 when both files exist. Exit 1 when one or both are missing.
 * `--root <dir>` sets the repo root. The default is the current directory.
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
 * Returns 0 when `coverage-baseline.json` and `gates/check-coverage-ratchet.mjs`
 * exist under `<repoRoot>/tools/audit`, and 1 when one or both are missing.
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

function invokedAsCli(): boolean {
  const entry = process.argv[1];
  return entry !== undefined && path.resolve(entry) === fileURLToPath(import.meta.url);
}

/**
 * Reads `--root <dir>`. Throws when the flag has no value, so that the error
 * names the real mistake and not a later `path.join` failure.
 */
function parseArgs(): { root: string } {
  const flag = process.argv.indexOf('--root');
  if (flag === -1) return { root: process.cwd() };
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
