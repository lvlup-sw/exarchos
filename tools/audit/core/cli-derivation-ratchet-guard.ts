// The executable ratchet for the CLI-derivation allowlist, and the one
// production clock read of this mechanism.
//
// This entrypoint is separate from `cli-derivation-guard.ts`. A
// `--ratchet-only` flag on that guard is a discoverable way to disable the
// derivation policy from the workflow file.
//
// The clock is read here and not in the library. Thus the expiry audit stays a
// pure function, and its unit tests do not fail on a calendar date. The day rule
// comes from `waiver-ledger.ts`, which reaches no `bun:sqlite`. Thus this guard
// still runs under plain node, and a conformance test asserts it.

import {
  ALLOWLIST_PATH,
  auditCliRatchetAsOf,
  formatCliExpiryAudit,
  formatCliMembershipAudit,
  formatCliSeedIntegrityAudit,
  readPolicy,
  scanGovernedSources,
  type CliDerivationPolicy,
  type DerivationScan,
} from './cli-derivation-guard.js';
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { isoDayUtc } from '../../conformance/src/waiver-ledger.js';
import {
  CLI_DERIVATION_EXPIRY_HORIZON,
  CLI_DERIVATION_SEED_KEY_SET_DIGEST,
} from './cli-derivation-seed-pin.js';

/**
 * The live artifacts this guard governs. The self-test asserts that the
 * production defaults are these values and not a stub.
 */
export const LIVE_SUBJECT = Object.freeze({
  allowlistPath: ALLOWLIST_PATH,
  horizon: CLI_DERIVATION_EXPIRY_HORIZON,
  pinnedDigest: CLI_DERIVATION_SEED_KEY_SET_DIGEST,
});

/**
 * The inputs of {@link runRatchetGuard}. An absent field resolves to the live
 * artifact. The self-test injects them, because the guard reads no argv.
 */
export interface RatchetGuardOptions {
  /** ISO `YYYY-MM-DD`. The default is {@link resolveToday}. */
  readonly today?: string;
  readonly scan?: DerivationScan;
  readonly policy?: CliDerivationPolicy;
  readonly pinnedDigest?: string;
  readonly horizon?: string;
  readonly stdout?: (chunk: string) => void;
  readonly stderr?: (chunk: string) => void;
}

/**
 * The current UTC calendar day. This is the one production clock read of the
 * ratchet. All later steps are pure functions of its result.
 */
export function resolveToday(now: Date = new Date()): string {
  return isoDayUtc(now);
}

/**
 * Runs the membership, seed-integrity and expiry audits, and returns an exit
 * code. The code is `0` when the ratchet is clean and `1` for one or more
 * findings. The report names each finding with its repair.
 *
 * The scan and the policy read throw on a moved composition root or a bad
 * policy file. This function catches nothing, so a broken gate cannot report a
 * pass.
 */
export function runRatchetGuard(options: RatchetGuardOptions = {}): number {
  const out = options.stdout ?? ((chunk: string): void => void process.stdout.write(chunk));
  const err = options.stderr ?? ((chunk: string): void => void process.stderr.write(chunk));

  const today = options.today ?? resolveToday();
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

/**
 * A canonical absolute path with symlinks resolved. For a path that does not
 * exist, it returns the plain resolution, so an odd `argv[1]` does not throw.
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
 * True when this file is the process entrypoint. It compares file identity, not
 * the file name, because a name check stays green under any other name.
 */
const isDirectRun =
  typeof process !== 'undefined' &&
  typeof process.argv[1] === 'string' &&
  canonicalPath(process.argv[1]) === canonicalPath(fileURLToPath(import.meta.url));

if (isDirectRun) {
  process.exit(runRatchetGuard());
}
