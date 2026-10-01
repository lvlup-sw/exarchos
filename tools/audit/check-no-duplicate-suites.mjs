#!/usr/bin/env node
/**
 * check-no-duplicate-suites.mjs: a ratchet against duplicate test locations.
 *
 * It fails on a legacy `src/__tests__/<area>/<base>.test.ts` twin of a co-located
 * `src/<area>/<base>.test.ts` subject when the twin is not in the allowlist.
 * It uses `enumeratePairs` from `consolidate-suite.mjs`, so the ratchet and that tool
 * share one pair definition. It uses no brace glob, because `git ls-files '{a,b}'`
 * does not expand the braces and matches nothing.
 *
 * The pair id is `<area>/<basename>`, so `workflow/schemas` and `event-store/schemas`
 * are different subjects.
 */
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';
import process from 'node:process';
import {
  enumeratePairs,
  DEFAULT_SRC_ROOT,
  EXIT_OK,
  EXIT_FINDING,
  EXIT_USAGE,
} from './consolidate-suite.mjs';

export { EXIT_OK, EXIT_FINDING, EXIT_USAGE };

/**
 * Pair ids that can keep a legacy `__tests__` twin. It is empty, because the target
 * tree has no twins. An entry for a current twin locks in the defect that the ratchet
 * removes. Add an id only for a temporary twin, with a reason. It is frozen.
 * @type {readonly string[]}
 */
export const ALLOWLIST = Object.freeze([]);

/**
 * Returns each pair whose `<area>/<basename>` id is not in `allowlist`.
 * The match uses the full id, so an entry never waives a same-basename pair in another area.
 * @param {{ id: string, legacyPath: string, canonicalPath: string }[]} pairs
 * @param {readonly string[]} allowlist
 * @returns {{ id: string, legacyPath: string, canonicalPath: string }[]}
 */
export function findViolations(pairs, allowlist) {
  const allowed = new Set(allowlist);
  return pairs.filter((p) => !allowed.has(p.id));
}

const USAGE = `check-no-duplicate-suites — duplicate-location ratchet (DR-1)

Usage:
  check-no-duplicate-suites [--src <dir>] [--json]

Fails (exit 1) if any co-located subject still has a legacy __tests__ twin that
is not in the (empty) allowlist. Passes (exit 0) on a twin-free tree.

Options:
  --src <dir>   override the governed source root (default: the MCP src tree).
  --json        emit the violation list as JSON.
  --help        show this help.
`;

/**
 * @param {string[]} argv
 * @returns {{ src?: string, json: boolean, help: boolean }}
 */
function parseArgs(argv) {
  /** @type {{ src?: string, json: boolean, help: boolean }} */
  const out = { json: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (tok === '--src') out.src = argv[++i];
    else if (tok === '--json') out.json = true;
    else if (tok === '--help') out.help = true;
  }
  return out;
}

/**
 * In-process CLI body. It returns an exit code and does not call `process.exit`.
 * All output goes through the injected `log` and `errlog`.
 * @param {string[]} argv
 * @param {{ srcRoot?: string, log?: (m: string) => void, errlog?: (m: string) => void }} [opts]
 * @returns {number}
 */
export function run(argv, opts = {}) {
  const log = opts.log ?? ((m) => process.stdout.write(`${m}\n`));
  const errlog = opts.errlog ?? ((m) => process.stderr.write(`${m}\n`));
  const args = parseArgs(argv);
  if (args.help) {
    log(USAGE);
    return EXIT_OK;
  }
  const srcRoot = args.src ? path.resolve(args.src) : (opts.srcRoot ?? DEFAULT_SRC_ROOT);

  const pairs = enumeratePairs(srcRoot);
  const violations = findViolations(pairs, ALLOWLIST);

  if (args.json) {
    log(JSON.stringify(violations.map((v) => v.id), null, 2));
  }

  if (violations.length === 0) {
    if (!args.json) log('[no-duplicate-suites] OK — no legacy __tests__ twin of any co-located subject.');
    return EXIT_OK;
  }

  errlog(
    `[no-duplicate-suites] FAIL: ${violations.length} co-located subject(s) still have a legacy __tests__ twin ` +
      `(allowlist has ${ALLOWLIST.length} entr${ALLOWLIST.length === 1 ? 'y' : 'ies'}):`,
  );
  for (const v of violations) errlog(`    ${v.id}`);
  errlog('    Each must be consolidated (merged or relocated) so its legacy twin is removed.');
  return EXIT_FINDING;
}

/** True when this module is the process entry point (not an import). */
function invokedAsCli() {
  const entry = process.argv[1];
  return entry !== undefined && path.resolve(entry) === fileURLToPath(import.meta.url);
}

if (invokedAsCli()) {
  process.exit(run(process.argv.slice(2)));
}
