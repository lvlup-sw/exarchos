// FROZEN PIN: the key set of the `outputSchema` vacuity seed, as of 2026-08-07.
//
// The membership audit compares the allowlist with the current census. It cannot see an in-place
// swap that drops one id and adds another. Only prior state can show that the list only shrank,
// and this file holds that prior state as one digest. The file imports nothing, so the pin cannot
// observe the seed that it pins.
//
// The digest covers the live and the retired ids together. A paydown moves an id from one map to
// the other, so the digest stays the same. A change to the digest is a change to the seed.
//
// The pin is not tamper-proof. An author who edits both files in one commit gets a green build,
// and a reviewer must catch that.
//
// DO NOT REGENERATE THIS VALUE TO MAKE A BUILD GREEN. No script emits it. When the allowlist
// reaches zero, delete this file. Do not edit it.

/**
 * The `sha256` digest of the 112 declaration ids that `censusOutputSchemas().vacuous` returned on
 * 2026-08-07. The ids are sorted, deduplicated and joined by newlines. Each audit recomputes it
 * with `vacuitySeedDigest` over `VACUITY_ALLOWLIST_IDS` and `VACUITY_RETIRED_IDS`.
 */
export const VACUITY_SEED_KEY_SET_DIGEST =
  'c8f27fced9112278e2bfb62cf6df60476aad4e2635a91c761012607f3e1aab0c';

/**
 * The hash algorithm of the digest. A change of hash is thus an explicit edit, not a new reading
 * of the same hex string.
 */
export const VACUITY_SEED_DIGEST_ALGORITHM = 'sha256';

/**
 * The last slot of the vacuity expiry schedule. It is the deadline of the largest owner cohort
 * and the cap for every waiver. A waiver that expires later fails with `WAIVER_BEYOND_HORIZON`,
 * so no waiver can renew itself. The guard derives the earlier owner slots from the seed, one
 * {@link VACUITY_STAGGER_STEP_DAYS} step apart, so a paydown moves no deadline.
 *
 * Change this value only to re-date the whole debt, as a decision with an owner, in a commit that
 * changes nothing else. It is an ISO `YYYY-MM-DD` string, so the comparison is lexicographic.
 */
export const VACUITY_EXPIRY_HORIZON = '2027-02-28';

/**
 * Whole days between the deadlines of two adjacent owner cohorts. The seed decides which owner
 * gets which slot, so this number cannot favor one team.
 */
export const VACUITY_STAGGER_STEP_DAYS = 42;

/**
 * The maximum number of whole days from the day of the gate run to
 * {@link VACUITY_EXPIRY_HORIZON}. A horizon further out fails with `RUNWAY_BEYOND_BUDGET`.
 *
 * Without this ceiling, one edit to the horizon moves every cohort by any amount. The ceiling
 * moves with the clock and does not shrink. Raising it is thus the one edit that renews every
 * waiver, and that edit has no innocent reading.
 */
export const VACUITY_RUNWAY_BUDGET_DAYS = 270;
