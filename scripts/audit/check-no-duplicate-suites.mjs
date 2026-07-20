#!/usr/bin/env node
/**
 * check-no-duplicate-suites.mjs — duplicate-location ratchet (DR-1, Task 022).
 *
 * An (area, basename)-qualified intersection guard: it FAILS on any legacy
 * `src/__tests__/<area>/<base>.test.ts` twin of a co-located `src/<area>/
 * <base>.test.ts` subject that is not in the allowlist. Enumeration reuses
 * Task 001's `enumeratePairs` (`consolidate-suite.mjs`) so the ratchet and the
 * tool share ONE (area, basename) directory-intersection definition — never a
 * divergent copy and never a brace-glob (`git ls-files '{a,b}'` never expands
 * the braces → vacuously green).
 *
 * The pair identity key is strictly `(area, basename)`, so `workflow/schemas`
 * and `event-store/schemas` are DISTINCT subjects (likewise `workflow/tools`
 * vs `event-store/tools`). An allowlist keyed on basename alone would conflate
 * them — the allowlist is keyed on the full `<area>/<basename>` pair id.
 *
 * THE ALLOWLIST IS EMPTY. All 17 pairs relocate in the de-divergence campaign;
 * the consolidated end-state has ZERO twins. The allowlist is intentionally
 * NOT seeded with the current 17 — seeding it would ratchet in the very defect
 * this campaign removes. It exists only as the shrink-to-zero seam the design
 * describes (DR-1): a temporary future twin could be parked here with a reason,
 * but the steady state is `[]`.
 *
 * The pure `findViolations` core is exported so the ratchet is unit-testable
 * against a synthetic tree without spawning a subprocess.
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
 * The shrink-to-zero allowlist of `<area>/<basename>` pair ids permitted to
 * still have a legacy `__tests__` twin. EMPTY by design — the consolidated
 * end-state has no twins. Frozen so no import can mutate it.
 * @type {readonly string[]}
 */
export const ALLOWLIST = Object.freeze([]);

/**
 * Every enumerated (area, basename) twin whose pair id is not in `allowlist`.
 * A pure set-difference over the tool's enumeration — the ratchet's whole
 * decision. Keyed on the full `<area>/<basename>` id so a same-basename pair in
 * a different area is never accidentally waived.
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
 * In-process CLI body. Returns an exit code; never calls `process.exit` so it
 * is unit-testable. All I/O goes through the injected `log`/`errlog`.
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
