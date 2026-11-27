// RESERVED(issue: #1473, owner: exarchos, expires: 2027-02-28)
// Frozen pin for the report-coupling seed ratchet. The census, its test and the ratchet guard import
// it. Delete it with `report-coupling-seed.ts` when #1473 lands and the seed reaches its floor.
//
// `auditReportCouplingSeed()` compares the seed with the tree today, in both directions. That check
// cannot see an in-place swap: one commit removes a paid-down id and adds a new report-coupled id.
// To see the swap, the audit needs prior state. This file stores it as one digest over the union of
// the seed and its graveyard of retired ids. A paydown moves an id into the graveyard, so a legal
// edit does not change the union. This file imports nothing, so it cannot observe the seed it pins.
//
// DO NOT REGENERATE THIS VALUE TO MAKE A BUILD GREEN. No script emits it. If
// `auditReportCouplingSeedIntegrity()` fails, the seed key set changed. The pin exists to stop an
// addition, and the retirement of the ratchet deletes this file. Thus no edit of the digest is legal.

/**
 * The sha256 key-set digest of 26 event types. 25 came from `censusReportCoupling().reportCoupled` on 2026-08-07.
 * The owner pre-approved one addition on 2026-11-25: `merge.executed`, the row that records a blocker landed by a squash or a rebase.
 * `reportCouplingSeedDigest` in `report-coupling-census.ts` computes it from the seed ids and the retired ids.
 * Each audit recomputes it the same way.
 */
export const REPORT_COUPLING_SEED_KEY_SET_DIGEST =
  '8f37b7d86dee84b968de76e3248cf6e07a16b49e7427b11ccb6671a14f708154';

/** The hash algorithm of the digest, so a change of hash is an explicit edit to this line. */
export const REPORT_COUPLING_SEED_DIGEST_ALGORITHM = 'sha256';

/**
 * The deadline for every report-coupling seed entry. All 25 entries had this date on 2026-08-07.
 * The digest stops the seed from growing, and this horizon stops it from aging.
 * An entry can expire earlier than this date, but never later. The audit compares ISO `YYYY-MM-DD` strings.
 * The one legal change is a re-date of the whole outstanding debt, in a commit that changes only this line.
 */
export const REPORT_COUPLING_EXPIRY_HORIZON = '2027-02-28';
