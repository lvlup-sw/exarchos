// FROZEN PIN — the DR-5 / G1 CLI-derivation waiver seed's key set, as of 2026-08-07.
//
// ── The hole this closes (DR-5, task 023) ───────────────────────────────────
// `auditCliAllowlistMembership` compares the allowlist against TODAY, in both
// directions: a hand-written literal that is not tracked fails, and a tracked
// entry that names no live literal goes stale and must be deleted. What no
// comparison against today can see is an IN-PLACE SWAP — register `doctor`
// through a derivation helper (a genuine paydown), hand-write a NEW top-level
// verb, and edit the policy file to drop one and add the other in the same
// commit. Membership agrees in both directions. The cardinality never moves off
// ten, so a counting ratchet cannot see it either. Detecting "only removals
// happened" needs PRIOR STATE, and prior state is not derivable — it has to be
// written down once.
//
// This module is that writing-down, and it is the whole of the prior state: one
// hex digest and one date. It imports NOTHING, deliberately. A pin that can
// observe the thing it pins is not a pin, and the two authorities a guard
// compares have to be genuinely independent — this file and
// `cli-derivation-allowlist.json` cannot reach each other at all (one is code
// that imports nothing, the other is inert data).
//
// ── Why a digest and not a copy of the ten names ────────────────────────────
// Freezing the name LIST here would store every name twice and leave a
// duplicate standing until DR-19. The `retiredAt` graveyard in the policy file
// already holds each name exactly once for its own reasons, so pinning
// `digest(allowed ∪ retired)` adds 64 characters instead of ten lines.
//
// The digest is only worth having because the quantity it covers is INVARIANT
// under every legal edit. Paying a verb down MOVES its entry from `allowed` to
// `retired`; the union does not change, so this constant does not change. That
// is what makes any diff touching this line, by construction, someone changing
// which verbs the seed covers.
//
// ── What this does NOT claim ────────────────────────────────────────────────
// It is not tamper-proof, and no repo-local mechanism can be: an author who
// edits the policy file can edit this line too, and a reviewer must catch that.
// The residual is stated plainly rather than papered over. What it buys is that
// the illegal edit no longer PASSES — a green build now requires a deliberate,
// isolated, semantically unambiguous change to a file whose only content is
// frozen values and whose header says not to, instead of a `+` line among the
// `-` lines of a routine paydown.
//
// DO NOT REGENERATE THIS VALUE TO MAKE A BUILD GREEN. There is deliberately no
// script that emits it. If `auditCliDerivationSeedIntegrity()` fails, the seed
// key set changed, and the only legal reasons for that are: (a) never —
// additions are what this exists to stop; (b) the ratchet is being retired
// because the allowlist reached its DR-19 floor of zero, in which case this
// file is DELETED, not edited.
//
// This is the third instance of the waiver-ledger idiom in this repository
// (`src/output-schema-seed-pin.ts` for DR-4, `src/architecture/
// report-coupling-seed-pin.ts` for DR-2). The vocabulary is deliberately
// identical — same `{ owner, expires }` entry shape, same `retiredAt`
// graveyard, same `allowlist ∪ retired` digest, same pinned horizon, same
// finding codes — so there is ONE rule with three subjects rather than three
// rules. The primitives are still copied rather than shared; see the task-023
// report for the extraction that would collapse them.

/**
 * `sha256(names.sort().join('\n'))` over the ten hand-written top-level CLI
 * verbs seeded from the live `scanGovernedSources()` parse on 2026-08-07:
 * `doctor`, `emissions`, `feedback`, `init`, `install-skills`, `mcp`,
 * `onboard`, `schema`, `topology`, `version`.
 *
 * That is every literal `.command('<name>')` site in the composition root
 * EXCEPT `merge-orchestrate`, which is the kill fixture and is not
 * allowlistable — see `KILL_FIXTURE_COMMANDS` in
 * `scripts/core/cli-derivation-guard.ts`.
 *
 * Recomputed on every audit as
 * `cliDerivationSeedDigest([...allowedNames, ...retiredNames])` in
 * `scripts/core/cli-derivation-guard.ts`.
 */
export const CLI_DERIVATION_SEED_KEY_SET_DIGEST =
  'c5d58ac501fb16ece56d26cf15a18e6857b70faf8b2f7ba47d92eef63f95bbe2';

/**
 * The algorithm label the digest was taken with, so a future change of hash is
 * an explicit, readable act rather than a silent reinterpretation of the same
 * hex string.
 */
export const CLI_DERIVATION_SEED_DIGEST_ALGORITHM = 'sha256';

// ─── The frozen expiry horizon ──────────────────────────────────────────────
//
// DR-5 says the allowlist entries carry an owner and a wave-scoped expiry, and
// DR-4 already recorded why a "wave-scoped" LABEL is the wrong representation:
// it is not mechanically evaluable. The mechanically evaluable form is an ISO
// calendar date, and the wave's scope is expressed by pinning every entry to
// ONE of them.
//
// ── Why the horizon is a SEPARATE, FROZEN constant ─────────────────────────
// A deadline that the deadline's owner may move is not a deadline. If `expires`
// were enforced against nothing else, the cheapest green on the day it bites is
// a sed over the policy file bumping all ten dates by a year — an edit that
// looks exactly like the routine paydown diffs that file already receives.
//
// So a waiver may not name ITS OWN deadline. Every entry's `expires` must be at
// or before this ONE pinned date; an entry past it fails with
// `WAIVER_BEYOND_HORIZON` before its own expiry is even consulted. Per-entry
// renewal is therefore impossible, and blanket renewal collapses to editing
// this single line — in a file that imports nothing, contains only frozen
// values, and is headed with the instruction not to edit it to go green. That
// is the whole of what this buys: it converts "ten invisible bumps" into "one
// conspicuous one".
//
// ── Moving it legally ──────────────────────────────────────────────────────
// There is one legal reason to change this value: the program deliberately
// re-dating the whole outstanding debt, as an explicit decision with an owner.
// That is a commit that touches this line and nothing else. Anything that
// bundles it with a paydown, a CLI change, or a "make CI green" fix is the
// failure mode this constant exists to make visible.

/**
 * The single deadline every CLI-derivation waiver is measured against — the
 * uniform horizon the ten seed entries were written with on 2026-08-07.
 *
 * Deliberately the SAME date as DR-4's `VACUITY_EXPIRY_HORIZON` and DR-2's
 * report-coupled seed: these are all Wave-1 debts of one program, and three
 * horizons would mean three separate renewal decisions for one deadline.
 *
 * An entry may expire EARLIER than this (paying a subset down sooner is always
 * legal); it may never expire later. Compared as an ISO `YYYY-MM-DD` string, so
 * ordering is lexicographic and no timezone, DST or `Date` arithmetic enters
 * the comparison.
 */
export const CLI_DERIVATION_EXPIRY_HORIZON = '2027-02-28';
