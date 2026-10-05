// The executable report-coupling ratchet, and the only place that reads the wall clock for it.
//
// The census library takes `today` as a required ISO-day string and reads no clock. A clock in
// the library puts the expiry inside the unit suite, where a due entry turns every `vitest run` red.
// {@link resolveToday} is the one production clock read, so the printed report reproduces the verdict.
//
// {@link runGuard} takes its clock, census, seed and pin as optional arguments for the self-test.
// It parses no argv, because an `--as-of` flag in the workflow file can neuter the gate.
//
// The seed and every deadline live in `report-coupling-seed.ts`, and the key-set digest lives in
// `report-coupling-seed-pin.ts`, both under `tools/conformance/src/`. This module reads them and
// sets the exit code. The kill fixtures in `report-coupling-census.test.ts` run in the same CI job.

import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isoDayUtc } from '../../conformance/src/event-grammar-census.js';
import {
  auditReportCouplingRatchet,
  auditReportCouplingSeed,
  auditReportCouplingSeedIntegrity,
  formatReportCouplingRatchet,
  type ReportCouplingCensusReport,
} from '../../conformance/src/report-coupling-census.js';
import { censusLiveReportCoupling } from '../../conformance/src/bindings/events.js';
import {
  REPORT_COUPLING_SEED,
  REPORT_COUPLING_SEED_IDS,
  REPORT_COUPLING_RETIRED_IDS,
  type ReportCouplingSeedEntry,
} from '../../conformance/src/report-coupling-seed.js';
import { REPORT_COUPLING_SEED_KEY_SET_DIGEST } from '../../conformance/src/report-coupling-seed-pin.js';

/**
 * The live artifacts this guard governs. The self-test asserts that the production
 * defaults are these objects and not a stub.
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
 * The current UTC calendar day. This is the only production clock read for the ratchet.
 * Everything downstream is a pure function of its result.
 */
export function resolveToday(now: Date = new Date()): string {
  return isoDayUtc(now);
}

/**
 * Runs both audits and returns a process exit code. `0`: the seed is exactly the live
 * report-coupled population, no entry has lapsed, and the key set hashes to its pin.
 * `1`: one or more findings. The report names each finding with its legal repair.
 */
export function runGuard(options: GuardOptions = {}): number {
  const out = options.stdout ?? ((chunk: string): void => void process.stdout.write(chunk));
  const err = options.stderr ?? ((chunk: string): void => void process.stderr.write(chunk));

  const today = options.today ?? resolveToday();
  const report = options.report ?? censusLiveReportCoupling();
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
        `no entry past due and every entry within the pinned horizon ${verdict.membership.horizon}.\n`,
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

/**
 * An absolute path with symlinks resolved where possible. For a path that does not exist,
 * it returns the plain resolved path, so an odd `argv[1]` reads as not the entry point.
 */
function canonicalPath(candidate: string): string {
  const absolute = resolve(candidate);
  try {
    return realpathSync(absolute);
  } catch {
    return absolute;
  }
}

/**
 * True when this module is the process entry point. It compares resolved paths, not a filename,
 * so a rename cannot turn the CI step into a silent no-op. Node reports the realpath of the main
 * module, but `argv[1]` keeps a symlink, so both sides resolve symlinks.
 *
 * The guard sets `process.exitCode` outside any function. `process.exit` can cut stdout before
 * it drains, and `hasDirectRunExit` finds a gate only through a statement outside a function.
 */
const isDirectRun =
  typeof process !== 'undefined' &&
  typeof process.argv[1] === 'string' &&
  canonicalPath(process.argv[1]) === canonicalPath(fileURLToPath(import.meta.url));

if (isDirectRun) {
  process.exitCode = runGuard();
}
