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

// ─── The frozen expiry horizon (DR-4, task 017) ─────────────────────────────
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
// a sed over `output-schema-vacuity-allowlist.ts` bumping all 112 dates by a
// year — an edit that looks exactly like the routine paydown diffs the file
// already receives, buried in a 112-line sorted object literal.
//
// So a waiver may not name ITS OWN deadline. Every entry's `expires` must be at
// or before this ONE pinned date; an entry past it fails with
// `WAIVER_BEYOND_HORIZON` before its own expiry is even consulted. Per-entry
// renewal is therefore impossible, and blanket renewal collapses to editing this
// single line — in a file that imports nothing, contains only frozen values, and
// is headed with the instruction not to edit it to go green. That is the whole
// of what this buys: it converts "112 invisible bumps" into "one conspicuous
// one".
//
// ── What this does NOT claim ───────────────────────────────────────────────
// It is not tamper-proof, for exactly the reason the digest above is not: an
// author who can edit the allowlist can edit this line too, and a reviewer must
// catch that. The residual is identical in shape and is recorded here rather
// than papered over. What changed is that the illegal act is now a single,
// isolated, semantically unambiguous line in a file whose only content is
// frozen values — instead of no act at all, which is what "advisory" meant.
//
// ── Moving it legally ──────────────────────────────────────────────────────
// There is one legal reason to change this value: the program deliberately
// re-dating the whole outstanding debt, as an explicit decision with an owner.
// That is a commit that touches this line and nothing else. Anything that
// bundles it with a paydown, a registry change, or a "make CI green" fix is the
// failure mode this constant exists to make visible.

/**
 * The single deadline every `outputSchema` vacuity waiver is measured against —
 * the uniform horizon the 112 seed entries were written with on 2026-08-07.
 *
 * An entry may expire EARLIER than this (paying a subset down sooner is always
 * legal); it may never expire later. Compared as an ISO `YYYY-MM-DD` string, so
 * ordering is lexicographic and no timezone, DST or `Date` arithmetic enters the
 * comparison.
 */
export const VACUITY_EXPIRY_HORIZON = '2027-02-28';
