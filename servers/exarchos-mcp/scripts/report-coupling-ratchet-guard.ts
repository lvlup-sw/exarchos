// servers/exarchos-mcp/scripts/report-coupling-ratchet-guard.ts
//
// DR-2 / G3 — the executable report-coupling ratchet, and the ONE place the wall
// clock is read for it.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY THE CLOCK IS READ HERE AND NOWHERE ELSE
//
// G3's expiry tooth used to read `new Date()` inside
// `architecture/report-coupling-census.ts`, against the discipline its two
// sibling ratchets already follow. That module's guard IS its co-located vitest,
// so the wall clock sat inside the unit suite: on the day a seed entry came due,
// `vitest run` went red on every developer's machine for a reason unrelated to
// their change, and the cheapest green would have been to fix the CLOCK — freeze
// it, stub it, widen the assertion — rather than the debt. A deadline that
// teaches that lesson is worse than no deadline.
//
// So the library takes `today` as a required ISO-day string and reads no clock at
// all, and {@link resolveToday} below is the single production clock read in G3's
// mechanism. Everything downstream is a pure function of its result, which also
// means the verdict is reproducible from the report this guard prints.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY THE SEAMS ARE PARAMETERS AND NOT CLI FLAGS
//
// {@link runGuard} takes its clock, its census, its seed and its pin as optional
// arguments so the co-located self-test can pose a lapsed expiry and an emptied
// denominator without touching the live seed. It parses NO argv: an `--as-of`
// flag would be a documented, discoverable way to neuter the gate from the
// workflow file that invokes it — the same shape as the `|| true` trap
// `check-enforcer-wiring.mjs` exists to catch. The seam is reachable from a test
// import and from nothing else.
//
// POLICY IS DATA, NOT PROSE IN A TEST BODY: the seeded population and every
// deadline live in `src/architecture/report-coupling-seed.ts`; the key-set digest
// lives in `src/architecture/report-coupling-seed-pin.ts`. This module reads them
// and exits non-zero. It decides nothing.
//
// The KILL FIXTURES stay in `src/architecture/report-coupling-census.test.ts`,
// which `ci.yml` runs in the same unfiltered step — DR-24's "each guard's
// self-test runs in the same CI job as the guard".
//
// Implements: DR-7 (task 085), over DR-2's task 013 mechanism.

import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isoDayUtc } from '../src/architecture/event-grammar-census.js';
import {
  auditReportCouplingRatchet,
  auditReportCouplingSeed,
  auditReportCouplingSeedIntegrity,
  censusReportCoupling,
  formatReportCouplingRatchet,
  type ReportCouplingCensusReport,
} from '../src/architecture/report-coupling-census.js';
import {
  REPORT_COUPLING_SEED,
  REPORT_COUPLING_SEED_IDS,
  REPORT_COUPLING_RETIRED_IDS,
  type ReportCouplingSeedEntry,
} from '../src/architecture/report-coupling-seed.js';
import { REPORT_COUPLING_SEED_KEY_SET_DIGEST } from '../src/architecture/report-coupling-seed-pin.js';

/**
 * The live artifacts this guard governs, named once so the self-test can assert
 * that the production defaults really are these objects rather than a stub. A
 * guard proven only through its injected seams has been proven about the seams.
 */
export const LIVE_SUBJECT = Object.freeze({
  seed: REPORT_COUPLING_SEED,
  seeded: REPORT_COUPLING_SEED_IDS,
  retired: REPORT_COUPLING_RETIRED_IDS,
  pinnedDigest: REPORT_COUPLING_SEED_KEY_SET_DIGEST,
});

/** Every input {@link runGuard} will accept. Absent fields resolve to the live artifact. */
export interface GuardOptions {
  /** ISO `YYYY-MM-DD`. Defaults to {@link resolveToday} — the only clock read. */
  readonly today?: string;
  readonly report?: ReportCouplingCensusReport;
  readonly seed?: Readonly<Record<string, ReportCouplingSeedEntry>>;
  readonly seeded?: readonly string[];
  readonly retired?: readonly string[];
  readonly pinnedDigest?: string;
  readonly stdout?: (chunk: string) => void;
  readonly stderr?: (chunk: string) => void;
}

/**
 * The current UTC calendar day. The single production clock read in G3's
 * mechanism; everything downstream is a pure function of its result.
 */
export function resolveToday(now: Date = new Date()): string {
  return isoDayUtc(now);
}

/**
 * Run both halves and return a process exit code.
 *
 * `0` — the ratchet is clean: the seed is exactly the live report-coupled
 * population, no entry has lapsed, and the key set hashes to its pin.
 *
 * `1` — at least one finding. The report names every one, with the legal repair,
 * because "the gate is red" without the repair is how a ratchet turns into a
 * thing people delete.
 */
export function runGuard(options: GuardOptions = {}): number {
  const out = options.stdout ?? ((chunk: string): void => void process.stdout.write(chunk));
  const err = options.stderr ?? ((chunk: string): void => void process.stderr.write(chunk));

  const today = options.today ?? resolveToday();
  const report = options.report ?? censusReportCoupling();
  const seed = options.seed ?? LIVE_SUBJECT.seed;
  const seeded = options.seeded ?? LIVE_SUBJECT.seeded;
  const retired = options.retired ?? LIVE_SUBJECT.retired;
  const pinnedDigest = options.pinnedDigest ?? LIVE_SUBJECT.pinnedDigest;

  const verdict = auditReportCouplingRatchet(
    today,
    auditReportCouplingSeed(today, report, seed),
    auditReportCouplingSeedIntegrity(seeded, retired, pinnedDigest),
  );

  if (verdict.ok) {
    out(
      `reportCoupling:ratchet — OK as of ${today}. ` +
        `${verdict.membership.seeded.length} seeded of ${verdict.membership.total} ` +
        `registration(s); seed key set ${verdict.pin.keySetSize} id(s) matches its pin; ` +
        'no entry past due.\n',
    );
    return 0;
  }

  err(`reportCoupling:ratchet — ${verdict.findings.length} finding(s) as of ${today}:\n\n`);
  err(`${formatReportCouplingRatchet(verdict, report)}\n\n`);
  err(
    'DR-2: the report-coupled population may only SHRINK, and the expiry is ENFORCED rather\n' +
      'than advisory. Adding an entry to REPORT_COUPLING_SEED or regenerating the key-set pin\n' +
      'are both the wrong repair — give the event a handler-owned append, annotate the tier\n' +
      'that follows, and MOVE its entry to REPORT_COUPLING_RETIRED with a retiredAt date.\n',
  );
  return 1;
}

// ─────────────────────────────────────────────────────────────────────────────
// THE ENTRYPOINT TAIL
//
// The predicate compares the RESOLVED PATH of the process entrypoint against this
// module's own URL rather than testing `argv[1]` against a filename: a filename
// comparison couples self-execution to the file's NAME, so a rename leaves a CI
// step that still runs, prints nothing and exits 0. Symlinks are resolved on both
// sides because Node reports the main module's realpath while `argv[1]` keeps the
// link.
//
// NOTE FOR ANYONE EDITING BELOW: `process.exit` must stay a TOP-LEVEL call.
// `scripts/guard-inventory.ts` classifies a module as a runnable gate by finding
// exactly that (an AST walk that rejects a `process.exit` nested inside a
// function), and a gate it cannot see drops out of DR-24's CI-reachability proof.

/**
 * A canonical absolute path for comparison: symlinks resolved where possible,
 * falling back to plain resolution for a path that does not exist on disk (so an
 * exotic `argv[1]` degrades to "not the entrypoint" rather than throwing).
 */
function canonicalPath(candidate: string): string {
  const absolute = resolve(candidate);
  try {
    return realpathSync(absolute);
  } catch {
    return absolute;
  }
}

const isDirectRun =
  typeof process !== 'undefined' &&
  typeof process.argv[1] === 'string' &&
  canonicalPath(process.argv[1]) === canonicalPath(fileURLToPath(import.meta.url));

if (isDirectRun) {
  // `exitCode`, never `exit(…)`: the guard's diagnostics go to stdout, and
  // `process.exit` can sever the pipe before it drains — a red gate with its
  // reason truncated away. Statement-level either way, so `hasDirectRunExit`
  // still classifies this module as a runnable gate.
  process.exitCode = runGuard();
}
