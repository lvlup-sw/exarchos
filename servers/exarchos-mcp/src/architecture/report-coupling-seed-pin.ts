// RESERVED(issue: #1473, owner: exarchos, expires: 2027-02-28) — the frozen half of G3's ratchet.
// Imported only by `architecture/report-coupling-census.ts`, which is gate machinery; it is deleted
// together with `report-coupling-seed.ts` when the seed reaches its DR-20 floor.
//
// FROZEN PIN — the DR-2 / G3 report-coupled seed's key set, as of 2026-08-07.
//
// ── The hole this closes ────────────────────────────────────────────────────
// `auditReportCouplingSeed()` compares the seed against TODAY, in both directions. What no
// comparison against today can see is an IN-PLACE SWAP: re-couple `a` (genuinely paid down), let
// `c` become report-coupled, and edit `report-coupling-seed.ts` to drop `a` and add `c` in the same
// commit. Membership agrees in both directions. The count never moves off its seeded value, so the
// counting ratchet the spec asks for cannot see it either. Detecting "only removals happened"
// requires PRIOR STATE, and prior state is not derivable — it has to be written down once.
//
// This module is that writing-down, and it is the whole of the prior state: one hex digest. It
// imports NOTHING, deliberately. A pin that can observe the thing it pins is not a pin, and the two
// authorities a test compares have to be genuinely independent — this file and the seed file cannot
// reach each other in the static import graph.
//
// ── Why a digest and not a copy of the 25 ids ───────────────────────────────
// Freezing the id LIST here would store every id twice and leave a duplicate standing forever. The
// `retiredAt` graveyard in `report-coupling-seed.ts` already holds each id exactly once for its own
// reasons, so pinning `digest(seed ∪ retired)` adds 64 characters instead of 25 lines.
//
// The digest is only worth having because the quantity it covers is INVARIANT under every legal
// edit. Paying an entry down MOVES it from the seed to the graveyard; the union does not change, so
// this constant does not change. That is what makes any diff touching this line, by construction,
// someone changing which registrations the seed covers.
//
// ── What this does NOT claim ────────────────────────────────────────────────
// It is not tamper-proof, and no repo-local mechanism can be: an author who edits the seed can edit
// this line too. What it buys is that the illegal edit no longer PASSES — a green build requires a
// deliberate, isolated, semantically unambiguous change to a file whose only content is a frozen
// value and whose header says not to, instead of a `+` line among the `-` lines of a routine
// paydown in a 25-entry sorted object literal.
//
// DO NOT REGENERATE THIS VALUE TO MAKE A BUILD GREEN. There is deliberately no script that emits
// it. If `auditReportCouplingSeedIntegrity()` fails, the seed key set changed, and the only legal
// reasons for that are: (a) never — additions are what this exists to stop; (b) the ratchet is
// being retired because the seed reached its DR-20 floor and #1473 landed, in which case this file
// is deleted, not edited.

/**
 * `sha256(ids.sort().join('\n'))` over the 25 event types seeded from
 * `censusReportCoupling().reportCoupled` on 2026-08-07.
 *
 * Recomputed on every audit as
 * `reportCouplingSeedDigest([...REPORT_COUPLING_SEED_IDS, ...REPORT_COUPLING_RETIRED_IDS])` in
 * `architecture/report-coupling-census.ts`.
 */
export const REPORT_COUPLING_SEED_KEY_SET_DIGEST =
  '079ab2f02b6344b352b6fbc3af8807322f139627e01597e8ff1637c6382a101d';

/**
 * The algorithm label the digest was taken with, so a future change of hash is an explicit,
 * readable act rather than a silent reinterpretation of the same hex string.
 */
export const REPORT_COUPLING_SEED_DIGEST_ALGORITHM = 'sha256';

// ── The horizon (DR-6) ─────────────────────────────────────────────────────
//
// The digest above stops the seed GROWING. Until DR-6 this ratchet had nothing
// stopping it AGEING: entries carried an `expires` the audit enforced, and
// nothing capped what an entry could name. On the day the debt came due the
// cheapest green was a sed over the 25-line literal adding a year to every date
// — a diff indistinguishable from the paydown diffs that file already receives.
// Its two sibling ledgers were built with this tooth from the start; the DR-6
// extraction is where this one gets it rather than carrying the gap forward.
//
// The one legal reason to change the value below is the programme deliberately
// re-dating the WHOLE outstanding debt, as a commit that touches this line and
// nothing else.

/**
 * The single deadline every report-coupling seed entry is measured against — the uniform horizon
 * all 25 entries were written with on 2026-08-07.
 *
 * An entry may expire EARLIER than this (paying a subset down sooner is always legal); it may never
 * expire later. Compared as an ISO `YYYY-MM-DD` string, so ordering is lexicographic and no
 * timezone, DST or `Date` arithmetic enters the comparison.
 */
export const REPORT_COUPLING_EXPIRY_HORIZON = '2027-02-28';
