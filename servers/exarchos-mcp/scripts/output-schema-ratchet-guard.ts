// servers/exarchos-mcp/scripts/output-schema-ratchet-guard.ts
//
// DR-4 / G2 — the executable `outputSchema` vacuity ratchet, and the ONE place
// the wall clock is read.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY THIS FILE EXISTS AT ALL
//
// Before task 017 the whole `auditVacuity*` family was driven by NOTHING except
// its own co-located vitest, hosted in the `mcp`-path-filtered `test-mcp` job.
// `scripts/guard-inventory.ts` names that state in its own header as an instance
// of R-11 ("the mechanism ships and nothing calls it"), and #1711 names the
// sharper half: a path-filtered gate is SKIPPED-AS-PASSED on exactly the PRs a
// filter does not arm. This module is the executable gate, hosted on the
// UNFILTERED `grep-gates` deps tail (see `docs/guides/ci-gate-hosting.md` — it
// needs `tsx`/`typescript` resolvable, so it cannot ride the zero-dep prefix).
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY THE CLOCK IS READ HERE AND NOWHERE ELSE
//
// DR-4's exceptions row says the expiry is "enforced, not advisory", and an
// enforced deadline is by definition a verdict that changes with the date. That
// makes WHERE the clock is read a design decision, not an implementation detail:
//
//   • Inside the library → every audit becomes time-dependent and its unit tests
//     become date bombs. On the day the debt comes due the suite stops working,
//     and the cheapest green is to fix the CLOCK (freeze it, stub it, widen the
//     assertion) rather than the debt. The deadline would have taught the
//     opposite lesson from the one it exists to teach.
//   • Inside the unit suite → same failure, plus a developer who cannot run
//     `vitest` locally for a reason that has nothing to do with their change.
//   • HERE, at the gate that blocks the merge → the deadline reddens the thing a
//     deadline should redden. `auditVacuityExpiry` stays a pure function of
//     (today, entries, horizon), so the verdict is reproducible from the report
//     this guard prints, and every assertion about it is deterministic.
//
// So `architecture/output-schema-census.ts` contains no `new Date()` at all, and
// {@link resolveToday} below is the single production clock read in DR-4's
// mechanism.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY THE SEAMS ARE PARAMETERS AND NOT CLI FLAGS
//
// {@link runGuard} takes its clock, its entries, its horizon and its registry as
// optional arguments so the co-located self-test can pose an expired waiver, a
// self-renewed one and an emptied allowlist without touching the live seed. It
// deliberately parses NO argv: an `--as-of` flag would be a documented,
// discoverable way to neuter the gate from the workflow file that invokes it,
// which is the same shape as the `|| true` trap `check-enforcer-wiring.mjs`
// exists to catch. The seam is reachable from a test import and from nothing
// else.
//
// POLICY IS DATA, NOT PROSE IN A TEST BODY: the waived population and every
// deadline live in `src/output-schema-vacuity-allowlist.ts`; the horizon and the
// seed digest live in `src/output-schema-seed-pin.ts`. This module reads them
// and exits non-zero. It decides nothing.
//
// Implements: DR-4 (task 017).

import {
  auditVacuityAllowlist,
  auditVacuityExpiry,
  auditVacuityRatchetAsOf,
  auditVacuitySeedIntegrity,
  censusOutputSchemas,
  formatVacuityAllowlistAudit,
  formatVacuityExpiryAudit,
  formatVacuitySeedIntegrityAudit,
  isoDayUtc,
  type CensusableTool,
} from '../src/architecture/output-schema-census.js';
import {
  VACUITY_ALLOWLIST,
  VACUITY_ALLOWLIST_IDS,
  VACUITY_RETIRED_IDS,
  type VacuityWaiverEntry,
} from '../src/output-schema-vacuity-allowlist.js';
import {
  VACUITY_EXPIRY_HORIZON,
  VACUITY_SEED_KEY_SET_DIGEST,
} from '../src/output-schema-seed-pin.js';

/**
 * The live artifacts this guard governs, named once so the self-test can assert
 * that the production defaults really are these objects rather than a stub. A
 * guard proven only through its injected seams has been proven about the seams.
 */
export const LIVE_SUBJECT = Object.freeze({
  entries: VACUITY_ALLOWLIST,
  horizon: VACUITY_EXPIRY_HORIZON,
  waived: VACUITY_ALLOWLIST_IDS,
  retired: VACUITY_RETIRED_IDS,
  pinnedDigest: VACUITY_SEED_KEY_SET_DIGEST,
});

/** Every input {@link runGuard} will accept. Absent fields resolve to the live artifact. */
export interface GuardOptions {
  /** ISO `YYYY-MM-DD`. Defaults to {@link resolveToday} — the only clock read. */
  readonly today?: string;
  readonly entries?: Readonly<Record<string, VacuityWaiverEntry>>;
  readonly horizon?: string;
  readonly tools?: readonly CensusableTool[];
  readonly waived?: readonly string[];
  readonly retired?: readonly string[];
  readonly pinnedDigest?: string;
  readonly stdout?: (chunk: string) => void;
  readonly stderr?: (chunk: string) => void;
}

/**
 * The current UTC calendar day. The single production clock read in DR-4's
 * mechanism; everything downstream is a pure function of its result.
 */
export function resolveToday(now: Date = new Date()): string {
  return isoDayUtc(now);
}

/**
 * Run all four teeth and return a process exit code.
 *
 * `0` — the ratchet is clean: every vacuous declaration is waived, every waiver
 * still corresponds to live vacuity, the seed key set hashes to its pin, and no
 * waiver is malformed, self-renewed or past due.
 *
 * `1` — at least one finding. The report names every one, with the legal repair
 * for each, because "the gate is red" without the repair is how a ratchet turns
 * into a thing people delete.
 */
export function runGuard(options: GuardOptions = {}): number {
  const out = options.stdout ?? ((chunk: string): void => void process.stdout.write(chunk));
  const err = options.stderr ?? ((chunk: string): void => void process.stderr.write(chunk));

  const today = options.today ?? resolveToday();
  const entries = options.entries ?? LIVE_SUBJECT.entries;
  const horizon = options.horizon ?? LIVE_SUBJECT.horizon;
  const waived = options.waived ?? LIVE_SUBJECT.waived;
  const retired = options.retired ?? LIVE_SUBJECT.retired;
  const pinnedDigest = options.pinnedDigest ?? LIVE_SUBJECT.pinnedDigest;

  const report =
    options.tools === undefined ? censusOutputSchemas() : censusOutputSchemas(options.tools);

  const verdict = auditVacuityRatchetAsOf(
    today,
    auditVacuityAllowlist(report, waived),
    auditVacuitySeedIntegrity(waived, retired, pinnedDigest),
    auditVacuityExpiry(today, entries, horizon),
  );

  const expiry = verdict.expiry;
  if (verdict.ok) {
    out(
      `outputSchema:ratchet — OK as of ${today}. ` +
        `${verdict.membership.waived.length} waived of ${verdict.membership.total} ` +
        `declaration(s); seed key set ${verdict.seed.keySetSize} id(s) matches its pin; ` +
        `${expiry === undefined ? 0 : expiry.entryCount} waiver(s) within the pinned ` +
        `horizon ${horizon}` +
        (expiry === undefined ? '' : ` (${expiry.daysToHorizon} day(s) remaining)`) +
        '.\n',
    );
    return 0;
  }

  err(`outputSchema:ratchet — ${verdict.findings.length} finding(s) as of ${today}:\n\n`);
  err(`${formatVacuityAllowlistAudit(verdict.membership)}\n\n`);
  err(`${formatVacuitySeedIntegrityAudit(verdict.seed)}\n\n`);
  if (expiry !== undefined) err(`${formatVacuityExpiryAudit(expiry)}\n\n`);
  err(
    'DR-4: `outputSchema` vacuity is unconstructible, the allowlist may only SHRINK, and the\n' +
      'expiry is ENFORCED rather than advisory. Adding an entry, re-dating one past\n' +
      'VACUITY_EXPIRY_HORIZON, or regenerating the seed pin are all the wrong repair — give\n' +
      'the declaration a real data schema, declare it with withCappedShape(...), and MOVE its\n' +
      'entry from VACUITY_ALLOWLIST to VACUITY_RETIRED.\n',
  );
  return 1;
}

const isDirectRun =
  typeof process !== 'undefined' &&
  typeof process.argv[1] === 'string' &&
  (process.argv[1].endsWith('output-schema-ratchet-guard.ts') ||
    process.argv[1].endsWith('output-schema-ratchet-guard.js'));

if (isDirectRun) {
  process.exit(runGuard());
}
