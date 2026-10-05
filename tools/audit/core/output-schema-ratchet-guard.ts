// The executable `outputSchema` vacuity ratchet, and the only place that reads the wall clock for it.
//
// The census library takes `today` as an argument and reads no clock. A clock in the library puts
// the expiry inside the unit suite, where a due waiver turns every `vitest run` red.
// {@link resolveToday} is the one production clock read, so the printed report reproduces the verdict.
//
// {@link runGuard} takes its clock, entries, horizon and registry as optional arguments for the
// self-test. It parses no argv, because an `--as-of` flag in the workflow file can neuter the gate.
//
// The waivers and their deadlines live in `src/output-schema-vacuity-allowlist.ts`. The schedule
// anchor, step, runway budget and seed digest live in `tools/conformance/src/output-schema-seed-pin.ts`.
// This module derives the per-owner schedule from them and sets the exit code.

import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  auditVacuityAllowlist,
  auditVacuityExpiry,
  auditVacuityRatchetAsOf,
  auditVacuitySeedIntegrity,
  formatVacuityAllowlistAudit,
  formatVacuityExpiryAudit,
  formatVacuitySeedIntegrityAudit,
  type CensusableTool,
} from '../../conformance/src/output-schema-census.js';
import { censusLiveOutputSchemas } from '../../conformance/src/bindings/output-schema.js';
import { daysBetween, isIsoDay, isoDayUtc } from '../../conformance/src/waiver-ledger.js';
import {
  VACUITY_ALLOWLIST,
  VACUITY_ALLOWLIST_IDS,
  VACUITY_RETIRED,
  VACUITY_RETIRED_IDS,
  type VacuityRetiredEntry,
  type VacuityWaiverEntry,
} from '../../../src/output-schema-vacuity-allowlist.js';
import {
  VACUITY_EXPIRY_HORIZON,
  VACUITY_RUNWAY_BUDGET_DAYS,
  VACUITY_SEED_DIGEST_ALGORITHM,
  VACUITY_SEED_KEY_SET_DIGEST,
  VACUITY_STAGGER_STEP_DAYS,
} from '../../conformance/src/output-schema-seed-pin.js';

/**
 * The live artifacts that the guard governs. The self-test checks that the production
 * defaults are these objects and not a stub.
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
  /** ISO `YYYY-MM-DD`. Defaults to {@link resolveToday}, the only clock read. */
  readonly today?: string;
  readonly entries?: Readonly<Record<string, VacuityWaiverEntry>>;
  /** The retired entries. The schedule uses their owners, because it derives from the whole seed. */
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
 * The current UTC calendar day. It is the one production clock read, and each audit is a
 * pure function of it.
 */
export function resolveToday(now: Date = new Date()): string {
  return isoDayUtc(now);
}

/** The place of one owner in the derived schedule. */
export interface OwnerCohort {
  readonly owner: string;
  /** 0 is the earliest slot. Derived from the seed, so it never moves. */
  readonly rank: number;
  /** Seeded waivers of this owner, live plus retired. The rank uses this count. */
  readonly seeded: number;
  /** Waivers still outstanding. */
  readonly live: number;
  /** The last day that a waiver of this owner can carry. */
  readonly horizon: string;
}

/**
 * Returns `day` moved `days` back as an ISO day, or `''` for a malformed input. The day
 * rule comes from `waiver-ledger.ts`. `Date.UTC` normalizes an out-of-range day, so a
 * shift across a month boundary needs no extra arithmetic.
 */
function shiftIsoDayBack(day: string, days: number): string {
  if (!isIsoDay(day) || !Number.isInteger(days)) return '';
  const parts = day.split('-');
  return isoDayUtc(
    new Date(Date.UTC(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]) - days)),
  );
}

/**
 * Derives the schedule from the owners of the seed. The last slot is `anchor`, and each
 * earlier slot is one step before the next. The smallest cohort comes due first, and the
 * owner name in code-unit order breaks ties, so the runner locale cannot change the order.
 *
 * The rank uses the seed (live plus retired entries), not the live allowlist. A paydown
 * moves an entry between the two maps, so it changes no rank and moves no deadline.
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
 * A condition that makes the schedule, or the place of an entry in it, invalid. There is
 * no code for an owner without a slot. The schedule derives from a superset of the live
 * owners. A new owner means a new id, which is already a `SEED_KEY_SET_DRIFT`.
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
  /** The last slot, {@link VACUITY_EXPIRY_HORIZON} in production. */
  readonly anchor: string;
  readonly stepDays: number;
  readonly runwayBudgetDays: number;
  /** Whole days from `today` to `anchor`, measured against the budget. */
  readonly runwayDays: number;
  readonly cohorts: readonly OwnerCohort[];
  readonly findings: readonly VacuityStaggerFinding[];
}

/**
 * Audits the schedule and the place of each live waiver in it, as of `today`. An entry
 * dated past the slot of its owner fails. The runway from `today` to `anchor` must stay
 * within the budget, so the anchor cannot move out by years. The runway is the only part
 * of the verdict that depends on the date and not only on the seed.
 *
 * Malformed and past-due entries are not checked here, because `auditVacuityExpiry`
 * reports them for the same entries.
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
    const cohort = slots.get(entry.owner);
    if (cohort === undefined) continue;
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
 * Renders the per-owner waiver counts on each run, green or red. `live of seeded` beside
 * each slot date shows the paydown in the log of the PR that did it.
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

/** Renders the stagger audit for a human or an agent. */
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
 * Runs the four audits and returns the process exit code. `0` means a clean ratchet.
 * Each vacuous declaration is waived, each waiver matches live vacuity, and the seed key
 * set matches its pin. No waiver is malformed, self-renewed, past due, or past its owner
 * slot. `1` means at least one finding, and the report names the legal repair for each.
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
    options.tools === undefined
      ? censusLiveOutputSchemas()
      : censusLiveOutputSchemas(options.tools);

  const verdict = auditVacuityRatchetAsOf(
    today,
    auditVacuityAllowlist(report, waived),
    auditVacuitySeedIntegrity(waived, retired, pinnedDigest, VACUITY_SEED_DIGEST_ALGORITHM),
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
