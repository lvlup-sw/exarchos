// FROZEN PIN: the key set of the CLI-derivation waiver seed, as of 2026-08-07.
//
// `auditCliAllowlistMembership` compares the allowlist with the live CLI parse in
// both directions. It cannot see an in-place swap: a verb paid down and a new
// hand-written verb added to the allowlist in one commit. Detection needs prior
// state. This module holds it as one digest and one date. It imports nothing, so
// it cannot observe the allowlist that it pins.
//
// The pin is not tamper-proof. A reviewer must catch an edit of this file.
// DO NOT REGENERATE A VALUE HERE TO MAKE A BUILD GREEN. No script emits them.
// If `auditCliDerivationSeedIntegrity()` fails, the key set changed, and no such
// change is legal. When the allowlist reaches zero entries, delete this file.
//
// `tools/conformance/src/output-schema-seed-pin.ts` and
// `tools/conformance/src/report-coupling-seed-pin.ts` use the same waiver-ledger idiom.

/**
 * `sha256` over the sorted names of the ten hand-written top-level CLI verbs.
 * `scanGovernedSources()` gave them on 2026-08-07: `doctor`, `emissions`,
 * `feedback`, `init`, `install-skills`, `mcp`, `onboard`, `schema`, `topology`, `version`.
 *
 * The digest covers `allowed ∪ retired` in the policy file. A paydown moves an entry
 * from `allowed` to `retired`, so the union and this digest stay the same.
 * `merge-orchestrate` is the kill fixture and is not allowlistable (`KILL_FIXTURE_COMMANDS`).
 * `cli-derivation-guard.ts` recomputes the digest on each audit.
 */
export const CLI_DERIVATION_SEED_KEY_SET_DIGEST =
  'c5d58ac501fb16ece56d26cf15a18e6857b70faf8b2f7ba47d92eef63f95bbe2';

/** The hash algorithm of the digest. A change of hash is then an explicit edit, not a new reading of the same hex string. */
export const CLI_DERIVATION_SEED_DIGEST_ALGORITHM = 'sha256';

/**
 * The one deadline for each CLI-derivation waiver, the uniform horizon of the ten
 * seed entries on 2026-08-07. It is the same date as `VACUITY_EXPIRY_HORIZON` and
 * `REPORT_COUPLING_EXPIRY_HORIZON`, so one program debt has one renewal decision.
 *
 * A waiver cannot name its own deadline. An entry whose `expires` is later than this
 * date fails with `WAIVER_BEYOND_HORIZON`, so a renewal must edit this one line.
 * Move it only to re-date the whole debt, in a commit that changes nothing else.
 * The comparison is on ISO `YYYY-MM-DD` strings, so no timezone or `Date` math applies.
 */
export const CLI_DERIVATION_EXPIRY_HORIZON = '2027-02-28';
