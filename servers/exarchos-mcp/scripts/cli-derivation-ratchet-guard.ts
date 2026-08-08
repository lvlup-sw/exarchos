// servers/exarchos-mcp/scripts/cli-derivation-ratchet-guard.ts
//
// DR-5 / G1 — the executable CLI-derivation ALLOWLIST ratchet, and the ONE
// place this mechanism reads the wall clock.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY THIS IS A SECOND ENTRYPOINT AND NOT A FLAG ON THE FIRST
//
// `cli-derivation-guard.ts` states two different verdicts about the CLI
// composition root, and exactly one of them can be green today:
//
//   • THE DERIVATION POLICY — "the composition root contains no literal
//     `.command('<name>')` call". Its live failing subject is
//     `merge-orchestrate`, which is declared BOTH as a registry action (carrying
//     `posture: 'shared-mutating'`) and by hand. That name is not allowlistable
//     — `readPolicy` refuses a policy file that names it — because an earlier
//     revision exempted it and thereby neutralized the rejection DR-5 requires.
//     DR-5's remediation is to DELETE the hand-written call. Until that lands,
//     `runGuard()` correctly exits 1, so it cannot be a blocking CI step.
//
//   • THE RATCHET — "the tolerated set may only SHRINK, every entry has an owner
//     and an ENFORCED deadline, and nothing may be swapped in place". This is
//     green on the landing branch, and it is what this file executes.
//
// Two verdicts, two exit codes, two artifacts. Folding them into one entrypoint
// with a `--ratchet-only` flag would put a documented, discoverable way to
// neuter the derivation policy into the workflow file — the same shape as the
// `|| true` trap `scripts/check-enforcer-wiring.mjs` exists to catch. Splitting
// them also mirrors DR-4 exactly, where the census library
// (`../src/architecture/output-schema-census.ts`) is separate from the runnable
// gate (`./output-schema-ratchet-guard.ts`).
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY THE CLOCK IS READ HERE AND NOWHERE ELSE
//
// DR-5 requires a per-entry expiry, and an ENFORCED deadline is by definition a
// verdict that changes with the date. That makes WHERE the clock is read a
// design decision, not an implementation detail:
//
//   • Inside the library → every audit becomes time-dependent and its unit tests
//     become date bombs. On the day the debt comes due the suite stops working,
//     and the cheapest green is to fix the CLOCK (freeze it, stub it, widen the
//     assertion) rather than the debt. The deadline would have taught the
//     opposite lesson from the one it exists to teach.
//   • Inside the unit suite → same failure, plus a developer who cannot run
//     `vitest` locally for a reason that has nothing to do with their change.
//   • HERE, at the gate that blocks the merge → the deadline reddens the thing a
//     deadline should redden. `auditCliDerivationExpiry` stays a pure function
//     of (today, entries, horizon), so the verdict is reproducible from the
//     report this guard prints, and every assertion about it is deterministic.
//
// So `cli-derivation-guard.ts` contains no `new Date()` at all, and
// {@link resolveToday} below is the single production clock read in DR-5's
// mechanism.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY THE SEAMS ARE PARAMETERS AND NOT CLI FLAGS
//
// {@link runRatchetGuard} takes its clock, its scan, its policy, its pin and its
// horizon as optional arguments so the co-located self-test can pose an expired
// waiver, a self-renewed one, a seeded eleventh entry and an in-place swap
// without touching the live seed. It deliberately parses NO argv, for the reason
// above.
//
// POLICY IS DATA, NOT PROSE IN A TEST BODY: the waived population and every
// deadline live in `./cli-derivation-allowlist.json`; the horizon and the seed
// digest live in `./cli-derivation-seed-pin.ts`. This module reads them and
// exits non-zero. It decides nothing.
//
// Implements: DR-5 (task 023).

import {
  ALLOWLIST_PATH,
  auditCliRatchetAsOf,
  formatCliExpiryAudit,
  formatCliMembershipAudit,
  formatCliSeedIntegrityAudit,
  isoDayUtc,
  readPolicy,
  scanGovernedSources,
  type CliDerivationPolicy,
  type DerivationScan,
} from './cli-derivation-guard.js';
import {
  CLI_DERIVATION_EXPIRY_HORIZON,
  CLI_DERIVATION_SEED_KEY_SET_DIGEST,
} from './cli-derivation-seed-pin.js';

/**
 * The live artifacts this guard governs, named once so the self-test can assert
 * that the production defaults really are these values rather than a stub. A
 * guard proven only through its injected seams has been proven about the seams.
 */
export const LIVE_SUBJECT = Object.freeze({
  allowlistPath: ALLOWLIST_PATH,
  horizon: CLI_DERIVATION_EXPIRY_HORIZON,
  pinnedDigest: CLI_DERIVATION_SEED_KEY_SET_DIGEST,
});

/** Every input {@link runRatchetGuard} will accept. Absent fields resolve to the live artifact. */
export interface RatchetGuardOptions {
  /** ISO `YYYY-MM-DD`. Defaults to {@link resolveToday} — the only clock read. */
  readonly today?: string;
  readonly scan?: DerivationScan;
  readonly policy?: CliDerivationPolicy;
  readonly pinnedDigest?: string;
  readonly horizon?: string;
  readonly stdout?: (chunk: string) => void;
  readonly stderr?: (chunk: string) => void;
}

/**
 * The current UTC calendar day. The single production clock read in DR-5's
 * mechanism; everything downstream is a pure function of its result.
 */
export function resolveToday(now: Date = new Date()): string {
  return isoDayUtc(now);
}

/**
 * Run all three teeth and return a process exit code.
 *
 * `0` — the ratchet is clean: every hand-written literal except the kill fixture
 * is tracked, every tracked name is still a live literal, the seed key set
 * hashes to its pin, and no waiver is malformed, self-renewed or past due.
 *
 * `1` — at least one finding. The report names every one, with the legal repair
 * for each, because "the gate is red" without the repair is how a ratchet turns
 * into a thing people delete.
 */
export function runRatchetGuard(options: RatchetGuardOptions = {}): number {
  const out = options.stdout ?? ((chunk: string): void => void process.stdout.write(chunk));
  const err = options.stderr ?? ((chunk: string): void => void process.stderr.write(chunk));

  const today = options.today ?? resolveToday();
  // `scanGovernedSources` and `readPolicy` both fail CLOSED — a moved
  // composition root, a zero-site parse, a missing or mis-shaped policy file and
  // a policy file naming the kill fixture all THROW rather than resolving to an
  // empty result. Nothing is caught here: a broken gate must not be reported as
  // a passing one, and a thrown error is a non-zero exit with a message.
  const scan = options.scan ?? scanGovernedSources();
  const policy = options.policy ?? readPolicy();
  const pinnedDigest = options.pinnedDigest ?? LIVE_SUBJECT.pinnedDigest;
  const horizon = options.horizon ?? LIVE_SUBJECT.horizon;

  const verdict = auditCliRatchetAsOf(today, scan, policy, pinnedDigest, horizon);

  if (verdict.ok) {
    out(
      `cli:derivation-ratchet — OK as of ${today}. ` +
        `${verdict.membership.tracked.length} tracked waiver(s) covering ` +
        `${verdict.membership.literals.length} hand-written literal(s) of ` +
        `${scan.sites.length} \`.command(\` site(s); seed key set ` +
        `${verdict.seed.keySetSize} name(s) matches its pin; every waiver within the pinned ` +
        `horizon ${horizon} (${verdict.expiry.daysToHorizon} day(s) remaining).\n`,
    );
    return 0;
  }

  err(`cli:derivation-ratchet — ${verdict.findings.length} finding(s) as of ${today}:\n\n`);
  err(`${formatCliMembershipAudit(verdict.membership)}\n\n`);
  err(`${formatCliSeedIntegrityAudit(verdict.seed)}\n\n`);
  err(`${formatCliExpiryAudit(verdict.expiry)}\n\n`);
  err(
    'DR-5: the hand-written CLI verb allowlist may only SHRINK, and its expiry is ENFORCED\n' +
      'rather than advisory. Adding an entry, re-dating one past CLI_DERIVATION_EXPIRY_HORIZON,\n' +
      'or regenerating the seed pin are all the wrong repair — register the verb through a\n' +
      'derivation helper so its name comes from a registry declaration, and MOVE its entry from\n' +
      `"allowed" to "retired" in ${ALLOWLIST_PATH}.\n`,
  );
  return 1;
}

const isDirectRun =
  typeof process !== 'undefined' &&
  typeof process.argv[1] === 'string' &&
  (process.argv[1].endsWith('cli-derivation-ratchet-guard.ts') ||
    process.argv[1].endsWith('cli-derivation-ratchet-guard.js'));

if (isDirectRun) {
  process.exit(runRatchetGuard());
}
