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
// deadline live in `src/output-schema-vacuity-allowlist.ts`; the schedule anchor,
// its step, the runway budget and the seed digest live in
// `src/output-schema-seed-pin.ts`. This module reads them, DERIVES the per-owner
// schedule from the seed's own owners (see {@link deriveOwnerCohorts}, which is
// mechanism — the alternative is a table of dates keyed by team name, which is
// the transcribed population this program spends its time deleting), and exits
// non-zero. It chooses nothing.
//
// Implements: DR-4 (tasks 017 and 093).

import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  auditVacuityAllowlist,
  auditVacuityExpiry,
  auditVacuityRatchetAsOf,
  auditVacuitySeedIntegrity,
  censusOutputSchemas,
  formatVacuityAllowlistAudit,
  formatVacuityExpiryAudit,
  formatVacuitySeedIntegrityAudit,
  type CensusableTool,
} from '../src/architecture/output-schema-census.js';
import { daysBetween, isIsoDay, isoDayUtc } from '../src/architecture/waiver-ledger.js';
import {
  VACUITY_ALLOWLIST,
  VACUITY_ALLOWLIST_IDS,
  VACUITY_RETIRED,
  VACUITY_RETIRED_IDS,
  type VacuityRetiredEntry,
  type VacuityWaiverEntry,
} from '../src/output-schema-vacuity-allowlist.js';
import {
  VACUITY_EXPIRY_HORIZON,
  VACUITY_RUNWAY_BUDGET_DAYS,
  VACUITY_SEED_KEY_SET_DIGEST,
  VACUITY_STAGGER_STEP_DAYS,
} from '../src/output-schema-seed-pin.js';

/**
 * The live artifacts this guard governs, named once so the self-test can assert
 * that the production defaults really are these objects rather than a stub. A
 * guard proven only through its injected seams has been proven about the seams.
 */
export const LIVE_SUBJECT = Object.freeze({
  entries: VACUITY_ALLOWLIST,
  retiredEntries: VACUITY_RETIRED,
  horizon: VACUITY_EXPIRY_HORIZON,
  stepDays: VACUITY_STAGGER_STEP_DAYS,
  runwayBudgetDays: VACUITY_RUNWAY_BUDGET_DAYS,
  waived: VACUITY_ALLOWLIST_IDS,
  retired: VACUITY_RETIRED_IDS,
  pinnedDigest: VACUITY_SEED_KEY_SET_DIGEST,
});

/** Every input {@link runGuard} will accept. Absent fields resolve to the live artifact. */
export interface GuardOptions {
  /** ISO `YYYY-MM-DD`. Defaults to {@link resolveToday} — the only clock read. */
  readonly today?: string;
  readonly entries?: Readonly<Record<string, VacuityWaiverEntry>>;
  /** The graveyard, needed for its OWNERS — the schedule is derived from the whole seed. */
  readonly retiredEntries?: Readonly<Record<string, VacuityRetiredEntry>>;
  readonly horizon?: string;
  readonly stepDays?: number;
  readonly runwayBudgetDays?: number;
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

// ─────────────────────────────────────────────────────────────────────────────
// THE STAGGERED SCHEDULE (task 093)
//
// Task 017 gave every waiver one cap and the whole seed sat on it. That is a
// working mechanism with a broken incentive: nothing comes due before the
// horizon, so the modelled outcome is the entire allowlist failing on one
// morning and being cleared by one bump — the "permanent exemption wearing a
// date" the allowlist header says 017 set out to end, moved eighteen months out
// rather than removed. Pressure has to arrive in instalments to be paid in
// instalments.
//
// So each OWNER's cohort gets its own slot, one {@link VACUITY_STAGGER_STEP_DAYS}
// step ahead of the next, and an entry dated past ITS OWNER's slot fails.
//
// ── Why the schedule is derived from the SEED and not from today's allowlist ──
// The obvious derivation ranks owners by how many waivers they hold RIGHT NOW.
// It is also wrong, and expensively so: paying a cohort down would change its
// rank, move its own remaining deadline and move other teams' deadlines with it.
// A gate that reddens on a legitimate paydown is the trip-wire this program has
// already removed twice from this very mechanism's tests.
//
// The seed — `VACUITY_ALLOWLIST ∪ VACUITY_RETIRED` — is the quantity the frozen
// digest already pins, and a paydown MOVES an entry between the two maps without
// changing the union or the entry's owner. Ranking on it therefore yields a
// schedule that no legal edit can perturb: the slots are fixed for the life of
// the ratchet, and an owner whose cohort is fully paid down keeps its (now
// empty) slot rather than shuffling everyone behind it forward.
//
// Smallest cohort first, ties broken by owner name so the order is total. The
// team with the least to do comes due first, which is the only ordering under
// which the earliest deadline is also the most payable one.

/** One owner's place in the derived schedule. */
export interface OwnerCohort {
  readonly owner: string;
  /** 0 is the earliest slot. Derived from the seed, so it never moves. */
  readonly rank: number;
  /** Waivers this owner was SEEDED with — live plus retired. The ranking key. */
  readonly seeded: number;
  /** Waivers still outstanding. The number that should be falling. */
  readonly live: number;
  /** The last day any of this owner's waivers may be dated. */
  readonly horizon: string;
}

/**
 * `day` moved `days` back, as an ISO day.
 *
 * The day RULE — what counts as a calendar day, how an instant becomes one, how
 * two are subtracted — is DR-6's `waiver-ledger.ts` and is imported, not
 * restated. Only the shift lives here, because the ledger has no use for one:
 * `Date.UTC` normalises an out-of-range day component, so December's overflow
 * into November needs no arithmetic of its own.
 */
function shiftIsoDayBack(day: string, days: number): string {
  if (!isIsoDay(day) || !Number.isInteger(days)) return '';
  const parts = day.split('-');
  return isoDayUtc(
    new Date(Date.UTC(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]) - days)),
  );
}

/**
 * The schedule, derived from the seed's owners. The LAST slot is `anchor`; every
 * earlier one is a step ahead of the slot behind it.
 */
export function deriveOwnerCohorts(
  entries: Readonly<Record<string, VacuityWaiverEntry>>,
  retiredEntries: Readonly<Record<string, VacuityRetiredEntry>>,
  anchor: string,
  stepDays: number,
): readonly OwnerCohort[] {
  const seeded = new Map<string, number>();
  const live = new Map<string, number>();
  for (const entry of Object.values(entries)) {
    seeded.set(entry.owner, (seeded.get(entry.owner) ?? 0) + 1);
    live.set(entry.owner, (live.get(entry.owner) ?? 0) + 1);
  }
  for (const entry of Object.values(retiredEntries)) {
    seeded.set(entry.owner, (seeded.get(entry.owner) ?? 0) + 1);
  }

  // Code-unit order, not `localeCompare`: a collator is locale-dependent, and a
  // gate whose verdict shifts with the runner's locale is not a gate.
  const ordered = [...seeded.entries()].sort(
    ([leftOwner, leftCount], [rightOwner, rightCount]) =>
      leftCount - rightCount || (leftOwner < rightOwner ? -1 : leftOwner > rightOwner ? 1 : 0),
  );
  const last = ordered.length - 1;

  return Object.freeze(
    ordered.map(([owner, count], rank) =>
      Object.freeze({
        owner,
        rank,
        seeded: count,
        live: live.get(owner) ?? 0,
        horizon: shiftIsoDayBack(anchor, stepDays * (last - rank)),
      }),
    ),
  );
}

/**
 * A condition that makes the staggered schedule, or an entry's place in it,
 * invalid.
 *
 * There is deliberately no "this waiver's owner has no slot" code. The schedule
 * is derived from a SUPERSET of the live population, so every live owner has one
 * by construction — and an owner arriving from nowhere means an id arriving from
 * nowhere, which is an ADDITION and already a `SEED_KEY_SET_DRIFT`. A branch
 * nothing can reach is a branch nothing can test.
 */
export type VacuityStaggerFinding =
  | { readonly code: 'MALFORMED_SCHEDULE'; readonly message: string }
  | { readonly code: 'EMPTY_SCHEDULE'; readonly message: string }
  | { readonly code: 'RUNWAY_BEYOND_BUDGET'; readonly message: string }
  | {
      readonly code: 'WAIVER_BEYOND_OWNER_HORIZON';
      readonly id: string;
      readonly message: string;
    };

export interface VacuityStaggerAudit {
  readonly ok: boolean;
  readonly today: string;
  /** The last slot — {@link VACUITY_EXPIRY_HORIZON} in production. */
  readonly anchor: string;
  readonly stepDays: number;
  readonly runwayBudgetDays: number;
  /** Whole days from `today` to `anchor`. What the budget is measured against. */
  readonly runwayDays: number;
  readonly cohorts: readonly OwnerCohort[];
  readonly findings: readonly VacuityStaggerFinding[];
}

/**
 * Audit the schedule and every live waiver's place in it, as of a NAMED day.
 *
 * Three teeth the single horizon did not have:
 *   1. PER-OWNER CAP. An entry dated past its own cohort's slot fails, whether
 *      or not it is inside the anchor. This is what makes the stagger real
 *      rather than decorative — the anchor alone would still accept every entry
 *      at the last slot.
 *   2. NO UNSCHEDULED OWNER. A live waiver whose owner has no slot has no
 *      deadline, so it fails closed rather than passing for want of a comparison.
 *   3. RUNWAY BUDGET. The anchor itself is measured against the clock. A
 *      staggered schedule hanging off one constant is still one constant; this
 *      is the tooth that stops that constant being moved by years. It is
 *      deliberately the only part of the verdict that is not a pure function of
 *      the seed.
 *
 * Deliberately NOT re-checked here: malformed entries and past-due entries, both
 * of which `auditVacuityExpiry` already reports over the same population. A
 * second opinion on the same defect is noise in a report whose job is to name
 * the repair.
 */
export function auditVacuityStagger(
  today: string,
  entries: Readonly<Record<string, VacuityWaiverEntry>>,
  retiredEntries: Readonly<Record<string, VacuityRetiredEntry>>,
  anchor: string,
  stepDays: number,
  runwayBudgetDays: number,
): VacuityStaggerAudit {
  const findings: VacuityStaggerFinding[] = [];
  const cohorts = deriveOwnerCohorts(entries, retiredEntries, anchor, stepDays);
  const scheduleReadable =
    isIsoDay(anchor) &&
    Number.isInteger(stepDays) &&
    stepDays > 0 &&
    cohorts.every((cohort) => isIsoDay(cohort.horizon));

  if (!scheduleReadable) {
    findings.push({
      code: 'MALFORMED_SCHEDULE',
      message:
        `The expiry schedule could not be derived: anchor '${anchor}', step ${stepDays} day(s). ` +
        'VACUITY_EXPIRY_HORIZON must be a real calendar day in YYYY-MM-DD form and ' +
        'VACUITY_STAGGER_STEP_DAYS a positive whole number of days, or every per-owner ' +
        'deadline below is meaningless. It fails closed rather than waiving the tooth.',
    });
  }
  if (cohorts.length === 0) {
    findings.push({
      code: 'EMPTY_SCHEDULE',
      message:
        'The seed (VACUITY_ALLOWLIST plus VACUITY_RETIRED) named ZERO owners, so the schedule ' +
        'has no slots and every per-owner deadline check below is trivially satisfied. That is ' +
        'what a moved module or a renamed field looks like, so it fails rather than reporting ' +
        'clean. The legitimate zero state deletes the allowlist module, its pin and this guard ' +
        'in one commit.',
    });
  }

  if (!Number.isInteger(runwayBudgetDays) || runwayBudgetDays < 0) {
    findings.push({
      code: 'MALFORMED_SCHEDULE',
      message:
        `VACUITY_RUNWAY_BUDGET_DAYS is ${runwayBudgetDays}, which is not a whole number of ` +
        'days. The tooth that bounds how far out the debt may be dated cannot be evaluated, ' +
        'so it fails closed.',
    });
  }

  const runwayDays = daysBetween(today, anchor);
  if (
    isIsoDay(today) &&
    isIsoDay(anchor) &&
    Number.isInteger(runwayBudgetDays) &&
    runwayBudgetDays >= 0 &&
    runwayDays > runwayBudgetDays
  ) {
    findings.push({
      code: 'RUNWAY_BEYOND_BUDGET',
      message:
        `The outstanding debt is dated ${runwayDays} day(s) out (anchor ${anchor}, today ` +
        `${today}), past the ${runwayBudgetDays}-day budget in output-schema-seed-pin.ts. DR-4 ` +
        'calls these waivers wave-scoped: the schedule may be re-dated as a deliberate ' +
        'decision, but not by years. Pay a cohort down instead — and if the budget itself is ' +
        'what is wrong, that is a policy change with an owner, not a step on the way to green.',
    });
  }

  const slots = new Map(cohorts.map((cohort) => [cohort.owner, cohort]));
  for (const id of Object.keys(entries).sort()) {
    const entry = entries[id];
    if (entry === undefined) continue;
    // Every live owner has a slot: `deriveOwnerCohorts` ranks over these very
    // entries plus the graveyard, so the schedule cannot omit one.
    const cohort = slots.get(entry.owner);
    if (cohort === undefined) continue;
    // A date that is not a day at all is `auditVacuityExpiry`'s MALFORMED_WAIVER,
    // reported there with the repair. Comparing it here would say the same thing
    // twice in different words.
    if (!isIsoDay(entry.expires) || !isIsoDay(cohort.horizon)) continue;
    if (entry.expires > cohort.horizon) {
      findings.push({
        code: 'WAIVER_BEYOND_OWNER_HORIZON',
        id,
        message:
          `'${id}' expires ${entry.expires}, later than the ${cohort.owner} cohort's slot ` +
          `${cohort.horizon} (slot ${cohort.rank + 1} of ${cohorts.length}). A waiver may not ` +
          'name its own deadline, and it may not borrow a later cohort\'s either — the ' +
          'staggered schedule is what makes the debt arrive in instalments. Give the ' +
          'declaration a real data schema, declare it with withCappedShape(...), and MOVE its ' +
          'entry to VACUITY_RETIRED.',
      });
    }
  }

  return Object.freeze({
    ok: findings.length === 0,
    today,
    anchor,
    stepDays,
    runwayBudgetDays,
    runwayDays,
    cohorts,
    findings: Object.freeze(findings),
  });
}

/**
 * The per-owner waiver counts, rendered for every run — green or red.
 *
 * The point of printing it on the HAPPY path is the trend. A ratchet that only
 * speaks at the cliff tells a reviewer nothing about whether the debt is moving;
 * `live of seeded` beside each cohort's date makes the paydown visible in the
 * log of the PR that did it.
 */
export function formatOwnerCohorts(audit: VacuityStaggerAudit): string {
  const width = Math.max(0, ...audit.cohorts.map((cohort) => cohort.owner.length));
  const lines = [
    `  by owner — live waiver(s) of seeded, and the cohort's slot in the ` +
      `${audit.stepDays}-day staggered schedule:`,
  ];
  for (const cohort of audit.cohorts) {
    lines.push(
      `    ${cohort.owner.padEnd(width)}  ${String(cohort.live).padStart(3)} of ` +
        `${String(cohort.seeded).padStart(3)}  due ${cohort.horizon}` +
        (isIsoDay(cohort.horizon) && isIsoDay(audit.today)
          ? ` (${daysBetween(audit.today, cohort.horizon)} day(s))`
          : ''),
    );
  }
  return lines.join('\n');
}

/** Render the stagger findings for a human or an agent. */
export function formatVacuityStaggerAudit(audit: VacuityStaggerAudit): string {
  const lines = [
    `outputSchema vacuity schedule: ${audit.cohorts.length} owner cohort(s) as of ` +
      `${audit.today}, anchored ${audit.anchor} (${audit.runwayDays} day(s) of ` +
      `${audit.runwayBudgetDays} budgeted) — ${audit.ok ? 'OK' : 'FAILED'}.`,
    formatOwnerCohorts(audit),
  ];
  if (audit.findings.length > 0) {
    lines.push(`  ${audit.findings.length} finding(s):`);
    for (const finding of audit.findings) {
      const subject = 'id' in finding ? ` ${finding.id}:` : '';
      lines.push(`    [${finding.code}]${subject} ${finding.message}`);
    }
  }
  return lines.join('\n');
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
  const retiredEntries = options.retiredEntries ?? LIVE_SUBJECT.retiredEntries;
  const horizon = options.horizon ?? LIVE_SUBJECT.horizon;
  const stepDays = options.stepDays ?? LIVE_SUBJECT.stepDays;
  const runwayBudgetDays = options.runwayBudgetDays ?? LIVE_SUBJECT.runwayBudgetDays;
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
  const stagger = auditVacuityStagger(
    today,
    entries,
    retiredEntries,
    horizon,
    stepDays,
    runwayBudgetDays,
  );

  const expiry = verdict.expiry;
  if (verdict.ok && stagger.ok) {
    out(
      `outputSchema:ratchet — OK as of ${today}. ` +
        `${verdict.membership.waived.length} waived of ${verdict.membership.total} ` +
        `declaration(s); seed key set ${verdict.seed.keySetSize} id(s) matches its pin; ` +
        `${expiry === undefined ? 0 : expiry.entryCount} waiver(s) within the pinned ` +
        `horizon ${horizon}` +
        (expiry === undefined ? '' : ` (${expiry.daysToHorizon} day(s) remaining)`) +
        `, staggered across ${stagger.cohorts.length} owner cohort(s).\n`,
    );
    out(`${formatOwnerCohorts(stagger)}\n`);
    return 0;
  }

  const findingCount = verdict.findings.length + stagger.findings.length;
  err(`outputSchema:ratchet — ${findingCount} finding(s) as of ${today}:\n\n`);
  err(`${formatVacuityAllowlistAudit(verdict.membership)}\n\n`);
  err(`${formatVacuitySeedIntegrityAudit(verdict.seed)}\n\n`);
  if (expiry !== undefined) err(`${formatVacuityExpiryAudit(expiry)}\n\n`);
  err(`${formatVacuityStaggerAudit(stagger)}\n\n`);
  err(
    'DR-4: `outputSchema` vacuity is unconstructible, the allowlist may only SHRINK, and the\n' +
      'expiry is ENFORCED rather than advisory — per OWNER, on a staggered schedule, so the\n' +
      'debt comes due in instalments. Adding an entry, re-dating one past its cohort slot or\n' +
      'past VACUITY_EXPIRY_HORIZON, widening VACUITY_RUNWAY_BUDGET_DAYS, or regenerating the\n' +
      'seed pin are all the wrong repair — give the declaration a real data schema, declare it\n' +
      'with withCappedShape(...), and MOVE its entry from VACUITY_ALLOWLIST to VACUITY_RETIRED.\n',
  );
  return 1;
}

// ─────────────────────────────────────────────────────────────────────────────
// THE ENTRYPOINT TAIL — and why it is not a filename comparison (task 018)
//
// These are the two lines that turn a verdict into a merge block, and until task
// 018 they were the only lines in DR-4's mechanism that nothing executed: every
// assertion task 017 shipped calls `runGuard()` DIRECTLY and reads its RETURN
// VALUE, so the `isDirectRun` predicate and the `process.exit` that consumes it
// were never run by any test.
//
// They were also wrong. The predicate used to be
// `process.argv[1].endsWith('output-schema-ratchet-guard.ts')`, which couples
// self-execution to the FILE'S NAME. Renaming the file — and updating the
// `run:` step in ci.yml to match, which is what a rename means — leaves a CI
// step that still exists, still runs, still resolves, prints NOTHING and exits
// 0. Measured on the landing branch: a byte-identical copy under any other name
// produced 0 bytes on stdout, 0 bytes on stderr, exit 0. That is precisely
// "guard-execution failure passes as success", in the guard whose own self-test
// exists to make that impossible.
//
// The repo already had the correct idiom in two places (`scripts/
// validate-plugin.mjs`, `scripts/run-validate.mjs`): compare the RESOLVED PATH
// of the process entrypoint against this module's own URL. That is rename-proof
// by construction, because both sides move together. {@link canonicalPath}
// additionally resolves symlinks, because Node reports the main module's
// realpath while `argv[1]` keeps the link — comparing the two unresolved would
// trade a filename-shaped silent no-op for a symlink-shaped one.
//
// NOTE FOR ANYONE EDITING BELOW: `process.exit` must stay a TOP-LEVEL call.
// `scripts/guard-inventory.ts` classifies a module as a runnable gate by finding
// exactly that (`hasDirectRunExit`, an AST walk that rejects a `process.exit`
// nested inside a function), and a gate it cannot see drops out of DR-24's
// CI-reachability proof.

/**
 * A canonical absolute path for comparison: symlinks resolved where possible,
 * falling back to plain resolution for a path that does not exist on disk (so
 * an exotic `argv[1]` degrades to "not the entrypoint" rather than throwing).
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
  // `exitCode`, never `exit(…)` — see report-coupling-ratchet-guard.ts: exiting
  // can sever stdout before the diagnostics drain.
  process.exitCode = runGuard();
}
