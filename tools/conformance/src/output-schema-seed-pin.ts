// FROZEN PIN — the `outputSchema` vacuity seed's key set, as of 2026-08-07.
//
// ── The hole this closes (DR-4, task 060, hole 2) ───────────────────────────
// Task 055 built the allowlist and then reported the residual against its own
// "the list may only shrink" claim: an IN-PLACE SWAP is invisible to every
// check that compares the list against TODAY. Pay `a` down, make `c` vacuous,
// and edit `output-schema-vacuity-allowlist.ts` to drop `a` and add `c` — the
// membership audit agrees in both directions, the count never moves off 112,
// and the compile-time waiver union accepts `c` because the union IS the file
// that was just edited. Detecting "only removals happened" needs PRIOR STATE,
// and prior state cannot be derived; it has to be written down once.
//
// This module is that writing-down. It is the whole of the prior state: one
// hex digest. It imports NOTHING — deliberately, because a pin that can observe
// the thing it pins is not a pin, and because DR-30 requires the two authorities
// a test compares to be genuinely independent (this file and the seed file
// cannot reach each other in the static import graph).
//
// ── Why a digest and not a copy of the 112 ids ──────────────────────────────
// The obvious alternative is to freeze the id LIST here. That stores every id
// twice and leaves a 112-line duplicate standing forever. The `retiredAt`
// graveyard in `output-schema-vacuity-allowlist.ts` already holds each id
// exactly once for its own reasons, so pinning `digest(allowlist ∪ retired)`
// adds 64 characters instead of 112 lines.
//
// A digest is only worth having because the quantity it covers is INVARIANT
// under every legal edit. Paying an entry down MOVES it from the allowlist to
// the graveyard; the union does not change, so this constant does not change.
// That is what makes it a signal: any diff touching this line is, by
// construction, someone changing which declarations the seed covers. A digest
// that had to be regenerated on every paydown would carry no information at all,
// which is exactly the trap a naive "regenerate the baseline" pin falls into.
//
// ── Why this exists at all, given the repo's own precedent ──────────────────
// Task 055 declined a pin and said so, on the precedent of `LEGACY_SHAPE_DEBT`
// (`test/integration/suite-invariants/legacy-shape-debt.ts`): an exhaustive
// explicit list, shrink-enforced by staleness, whose GROWTH tooth is nothing
// more than "adding a line to a file headed GENERATED BASELINE is the reviewable
// act". That argument is a real one and it was recorded honestly. Task 060 owns
// the decision, and it goes the other way, for one reason that does not transfer
// between the two lists:
//
//   The COST OF THE ALTERNATIVE differs by an order of magnitude, so the
//   pressure on the list does. Escaping `LEGACY_SHAPE_DEBT` legitimately costs
//   one comment line (`@oracle-sources: a, b`), so almost nobody is tempted to
//   grow the list instead. Escaping THIS list legitimately costs designing and
//   writing a real response contract for an action. The cheap way out — add a
//   line here, and the compile-time waiver union that would have stopped you is
//   the very file you just edited — is the path of least resistance for exactly
//   the author who is least likely to be pushing back on it. A ratchet whose
//   only growth tooth is a reviewer's attention is weakest precisely where the
//   incentive to grow is strongest.
//
// Two further things this buys, both of which task 055 correctly noted were
// missing rather than present:
//   • the module headers say "the list may only shrink" in three places. Before
//     this pin, that sentence was not checked in the growth direction at all —
//     only "no parking" (staleness) was. A claim stated three times and checked
//     zero times is the exact defect DR-4 was written to remove from
//     `outputSchema` itself.
//   • the swap is now a RED BUILD with a message, not a diff someone has to
//     notice. That is the difference between detection and enforcement.
//
// ── What this does NOT claim ────────────────────────────────────────────────
// It is not tamper-proof, and no repo-local mechanism can be: an author who
// edits the allowlist can edit this line too. The floor is irreducible. What it
// buys is that the illegal edit no longer PASSES. A green build now requires a
// deliberate, isolated, semantically unambiguous change to a file whose only
// content is a frozen value and whose header says not to — instead of a `+` line
// among the `-` lines of a routine paydown in a 112-entry sorted object literal.
//
// The residual, stated plainly so the next reader does not have to rediscover
// it: a determined author who edits BOTH files in one commit still gets a green
// build, and a reviewer must catch that. What has changed is that this is now
// the ONLY way through, it is loud, and it cannot happen by accident or by an
// agent taking the shortest path to green.
//
// DO NOT REGENERATE THIS VALUE TO MAKE A BUILD GREEN. There is deliberately no
// script that emits it. If `auditVacuitySeedIntegrity()` fails, the seed key set
// changed, and the only legal reasons for that are: (a) never — additions are
// what this exists to stop; (b) the whole ratchet is being retired because the
// allowlist reached zero, in which case this file is deleted, not edited.

/**
 * `sha256(ids.sort().join('\n'))` over the 112 declaration ids seeded from
 * `censusOutputSchemas().vacuous` on 2026-08-07.
 *
 * Recomputed on every audit as
 * `vacuitySeedDigest([...VACUITY_ALLOWLIST_IDS, ...VACUITY_RETIRED_IDS])` in
 * `architecture/output-schema-census.ts`.
 */
export const VACUITY_SEED_KEY_SET_DIGEST =
  'c8f27fced9112278e2bfb62cf6df60476aad4e2635a91c761012607f3e1aab0c';

/**
 * The algorithm label the digest was taken with, so a future change of hash is
 * an explicit, readable act rather than a silent reinterpretation of the same
 * hex string.
 */
export const VACUITY_SEED_DIGEST_ALGORITHM = 'sha256';

// ─── The frozen expiry schedule (DR-4, tasks 017 and 093) ───────────────────
//
// DR-4 says the allowlist entries carry an owner and an ISO expiry, and that
// "expiry is enforced, not advisory". Task 055 wrote the `expires` field into
// every entry and NOTHING READ IT — the field was pure documentation, which is
// the presence-not-substance defect DR-4 itself exists to remove, reproduced one
// layer up inside DR-4's own mechanism. Task 017 makes the field load-bearing:
// `auditVacuityExpiry()` in `architecture/output-schema-census.ts` fails on an
// entry whose `expires` is in the past.
//
// ── Why the horizon is a SEPARATE, FROZEN constant ──────────────────────────
// A deadline that the deadline's owner may move is not a deadline. If `expires`
// were enforced against nothing else, the cheapest green on the day it bites is
// a sed over `output-schema-vacuity-allowlist.ts` adding a year to every date —
// an edit that looks exactly like the routine paydown diffs the file already
// receives, buried in a sorted object literal of a hundred-odd lines.
//
// So a waiver may not name ITS OWN deadline. Every entry's `expires` is capped,
// and an entry past its cap fails with `WAIVER_BEYOND_HORIZON` before its own
// expiry is even consulted. Per-entry renewal is therefore impossible.
//
// ── Why the cap is a SCHEDULE and not one date (task 093) ───────────────────
// Task 017 shipped one cap for every entry, and the whole seed sat on it. The
// mechanism was sound and the incentive was not: nothing applied any pressure
// before the horizon, so the modelled outcome was every waiver failing on the
// same morning and being cleared by a single bump of this constant — the
// "permanent exemption wearing a date" the allowlist header says task 017 set
// out to end, deferred eighteen months rather than removed.
//
// The cap is now per OWNER. Each owner's cohort comes due one
// {@link VACUITY_STAGGER_STEP_DAYS} step ahead of the next, so the debt arrives
// in instalments a team can actually absorb instead of one cliff nobody can.
// The schedule is DERIVED, never written down: `deriveOwnerCohorts()` in
// `scripts/output-schema-ratchet-guard.ts` reads the owners off the frozen SEED
// (allowlist ∪ retired), orders them by seeded cohort size, and hands the
// smallest the earliest slot. Deriving it from the seed rather than from
// today's allowlist is what keeps it still: the seed key set is the quantity
// this file's digest already pins, so no paydown can shuffle a rank and no
// team's deadline can move because another team did some work.
//
// This constant is the LAST slot — the largest cohort's date, and the absolute
// cap no entry of any owner may exceed.
//
// ── What stops the bump ─────────────────────────────────────────────────────
// A staggered schedule anchored on one constant is still one constant, so on
// its own it converts "one bump renews everything at once" into "one bump
// renews everything, staggered". {@link VACUITY_RUNWAY_BUDGET_DAYS} is the
// tooth that makes the difference real: the anchor is measured against the WALL
// CLOCK at the gate, and debt dated further out than the budget fails. The
// eighteen-month deferral that motivated this task is now a red build.
//
// ── What this does NOT claim ───────────────────────────────────────────────
// It is not tamper-proof, for exactly the reason the digest above is not: an
// author who can edit the allowlist can edit these lines too, and a reviewer
// must catch that. The residual is identical in shape and is recorded here
// rather than papered over — and it is now TWO constants with contradictory
// headers, because renewing beyond the budget means raising the budget, an edit
// with no innocent reading.
//
// ── Moving them legally ────────────────────────────────────────────────────
// There is one legal reason to change these values: the program deliberately
// re-dating the whole outstanding debt, as an explicit decision with an owner.
// That is a commit that touches these lines and nothing else. Anything that
// bundles it with a paydown, a registry change, or a "make CI green" fix is the
// failure mode they exist to make visible.

/**
 * The LAST slot of the vacuity expiry schedule: the largest owner cohort's
 * deadline, and the absolute cap no waiver of any owner may exceed.
 *
 * An entry may expire EARLIER than this (paying a subset down sooner is always
 * legal); it may never expire later, and every entry is additionally capped by
 * its own owner's slot, which is at or before this date. Compared as an ISO
 * `YYYY-MM-DD` string, so ordering is lexicographic and no timezone, DST or
 * `Date` arithmetic enters the comparison.
 */
export const VACUITY_EXPIRY_HORIZON = '2027-02-28';

/**
 * Whole days between one owner cohort's deadline and the next.
 *
 * Six weeks: long enough that a cohort's deadline is a quarter's planning input
 * rather than an interrupt, short enough that the whole schedule stays inside
 * {@link VACUITY_RUNWAY_BUDGET_DAYS}. Only the STEP is policy — which owner sits
 * in which slot is derived from the seed, so this number cannot be tuned to
 * favour a particular team.
 */
export const VACUITY_STAGGER_STEP_DAYS = 42;

/**
 * The furthest out the outstanding debt may be dated, in whole days from the
 * day the gate runs.
 *
 * This is the anti-renewal tooth, and it is the only part of DR-4's expiry
 * mechanism whose verdict depends on the wall clock rather than on the seed.
 * Without it, one edit to {@link VACUITY_EXPIRY_HORIZON} moves every cohort by
 * however long the editor likes; with it, a bump can only ever buy the slack
 * between today's runway and this ceiling, and the multi-year deferral that
 * motivated task 093 is a red build rather than a one-line diff.
 *
 * Nine months — DR-4 calls these waivers wave-scoped, and no wave in this
 * program has run longer. Stated honestly: this is a ROLLING ceiling, not a
 * decaying one. It bounds how deep the debt may be at any moment; it does not
 * shrink on its own, and raising it is the one edit that renews everything.
 */
export const VACUITY_RUNWAY_BUDGET_DAYS = 270;
