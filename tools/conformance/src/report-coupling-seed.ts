// RESERVED(issue: #1473, owner: exarchos, expires: 2027-02-28) — G3's policy data. Its production
// importer is `architecture/report-coupling-census.ts`, which is itself gate machinery rather than
// shipped behaviour, so nothing on the server's runtime path reaches this module. It is deleted
// when the seed reaches its DR-20 floor (see below), not before.
//
// GENERATED SEED — the DR-2 / G3 report-coupled ratchet (task 013).
//
// Every key below names a registered event type whose DR-2 coupling derives `'model'`: a dedicated
// `exarchos_event.append` the MODEL must remember to make, which is therefore the first thing
// dropped under context pressure. That is the class DR-2 exists to shrink.
//
// ── How this list was produced ──────────────────────────────────────────────
// SEEDED from `censusReportCoupling().reportCoupled` — the census's own sorted id list — on
// 2026-08-07, at the `feat/internal-mechanics-overhaul` tip. It was never transcribed by hand and
// no cardinality is written down anywhere in this module: `report-coupling-census.test.ts`
// re-derives the whole population from the live registry on every run, so a hand-edited key that
// does not correspond to a real report-coupled registration turns the suite red.
//
// The measurement re-derived at introduction was **25 of 170** registered types, splitting
// 7 `judgment` / 18 `workflow-local`. It reproduced the figure the spec's G3 table asserts and the
// figure task 010 derived, from a third direction: the derived population and the population
// `EVENT_EMISSION_REGISTRY` declares (`source: 'model'`) are the SAME 25 ids, not merely the same
// count.
//
// `owner` is DERIVED from each registration's own weld, not assigned by hand — `judgment` entries
// carry `gate:<gateClass>`, `workflow-local` entries carry `workflow:<workflowId>`. So the
// accountable party is a consequence of the coupling claim rather than a second, independently
// drifting authority.
//
// ── Why a membership list and not a count of 25 ─────────────────────────────
// "No more than 25 report-coupled types" is satisfied by SWAPPING: pay one down, introduce another,
// and the number never moves. Membership cannot be gamed that way — the newcomer is not in this
// list, so it fails, and the paid-down entry goes stale the moment its coupling changes. The subset
// rule also implies the count ceiling, so the ratchet the spec asks for ("permits only decrease")
// is the weaker half of what is enforced here.
//
// ── The teeth ───────────────────────────────────────────────────────────────
//   1. MEMBERSHIP. `auditReportCouplingSeed()` pins this list against the live census in BOTH
//      directions: a report-coupled type with no seed entry fails (`UNSEEDED_REPORT_COUPLING` —
//      the growth tooth), and a seed entry whose type is no longer report-coupled goes stale and
//      must be MOVED to {@link REPORT_COUPLING_RETIRED}. There is no way to park a paid-down entry.
//   2. EXPIRY. Every entry carries an ISO date, and `auditReportCouplingSeed()` FAILS on a lapsed
//      one. The spec rejects "wave-scoped" labels precisely because they are not mechanically
//      evaluable; a date is.
//   3. KEY-SET INTEGRITY. Teeth 1 and 2 both compare this file against TODAY, so neither can see an
//      IN-PLACE SWAP performed in the same edit. `auditReportCouplingSeedIntegrity()` pins
//      `keys(SEED) ∪ keys(RETIRED)` against the frozen digest in `report-coupling-seed-pin.ts`.
//      A paydown MOVES an entry between the two maps, so the union — and therefore the pin — is
//      invariant under every legal edit.
//
// ── How to shrink it ────────────────────────────────────────────────────────
// Re-couple the event so the model no longer has to remember it: give it a handler-owned append
// and re-annotate its tier in `events/event-annotations.ts`. Then MOVE its line from
// {@link REPORT_COUPLING_SEED} to {@link REPORT_COUPLING_RETIRED}, swapping `expires` for
// `retiredAt: '<the date it stopped being report-coupled>'`. That is the only supported edit.
// Entries are never ADDED to either map — an addition changes the seed key set, and the pinned
// digest is what makes that a red build rather than a line a reviewer has to notice.
//
// DR-20 records the Wave-5 exit condition — a floor of 2, `team.spawned` and `team.disbanded`,
// which cannot be re-coupled until #1473 lands. That floor is an EXIT CONDITION, not this guard's
// seed; the two were conflated in an earlier revision of the spec. The two entries carry
// `blockedBy: '#1473'` so the exemption is recorded where it is enforced and cannot widen to a
// third type unnoticed.

/** One seeded report-coupled registration: who owns re-coupling it, and by when. */
export interface ReportCouplingSeedEntry {
  /**
   * Party accountable for moving the event off the model-remembered append path. Derived from the
   * registration's own weld: `gate:<gateClass>` for `judgment`, `workflow:<workflowId>` for
   * `workflow-local`.
   */
  readonly owner: string;
  /** ISO date (YYYY-MM-DD) after which the entry is expired and the audit FAILS. */
  readonly expires: string;
  /**
   * The issue blocking this entry's paydown, when one exists.
   *
   * Present on exactly the two types DR-20 records as the Wave-5 floor. R-8 pins that exemption at
   * two so it cannot widen: a third `blockedBy` entry is a visible, reviewable act rather than a
   * silent broadening of the escape hatch.
   */
  readonly blockedBy?: string;
}

/** One entry that has LEFT {@link REPORT_COUPLING_SEED} — re-coupled, or removed with its event. */
export interface ReportCouplingRetiredEntry {
  /** Party that owned the paydown. Carried over from the seed entry. */
  readonly owner: string;
  /** ISO date (YYYY-MM-DD) on which the entry left {@link REPORT_COUPLING_SEED}. */
  readonly retiredAt: string;
}

/**
 * The report-coupled population as measured at guard introduction.
 *
 * Annotated `Readonly<Record<string, ReportCouplingSeedEntry>>` rather than `as const`: the
 * annotation gives every value its contextual type, and this module spends nothing from the repo's
 * type-assertion budget.
 */
export const REPORT_COUPLING_SEED: Readonly<Record<string, ReportCouplingSeedEntry>> = Object.freeze(
  {
    'comment.posted': { owner: 'workflow:feature', expires: '2027-02-28' },
    'comment.resolved': { owner: 'workflow:feature', expires: '2027-02-28' },
    'merge.requested': { owner: 'workflow:feature', expires: '2027-02-28' },
    'remediation.attempted': { owner: 'gate:review-verdict', expires: '2027-02-28' },
    'remediation.succeeded': { owner: 'gate:review-verdict', expires: '2027-02-28' },
    'review.completed': { owner: 'gate:review-verdict', expires: '2027-02-28' },
    'review.escalated': { owner: 'gate:review-verdict', expires: '2027-02-28' },
    'review.finding': { owner: 'gate:review-verdict', expires: '2027-02-28' },
    'session.tagged': { owner: 'workflow:feature', expires: '2027-02-28' },
    'shepherd.iteration': { owner: 'workflow:feature', expires: '2027-02-28' },
    'stack.submitted': { owner: 'workflow:feature', expires: '2027-02-28' },
    'task.assigned': { owner: 'workflow:feature', expires: '2027-02-28' },
    'task.progressed': { owner: 'workflow:feature', expires: '2027-02-28' },
    'team.disbanded': { owner: 'workflow:feature', expires: '2027-02-28', blockedBy: '#1473' },
    'team.spawned': { owner: 'workflow:feature', expires: '2027-02-28', blockedBy: '#1473' },
    'team.task.assigned': { owner: 'workflow:feature', expires: '2027-02-28' },
    'team.task.completed': { owner: 'workflow:feature', expires: '2027-02-28' },
    'team.task.failed': { owner: 'workflow:feature', expires: '2027-02-28' },
    'team.task.planned': { owner: 'workflow:feature', expires: '2027-02-28' },
    'team.teammate.dispatched': { owner: 'workflow:feature', expires: '2027-02-28' },
    'test.result': { owner: 'gate:test-adequacy', expires: '2027-02-28' },
    'typecheck.result': { owner: 'gate:static-analysis', expires: '2027-02-28' },
    'workflow.handoff_summarized': { owner: 'workflow:feature', expires: '2027-02-28' },
    'worktree.baseline': { owner: 'workflow:feature', expires: '2027-02-28' },
    'worktree.created': { owner: 'workflow:feature', expires: '2027-02-28' },
  },
);

/**
 * Seed entries that have been paid down (the event is no longer report-coupled) or removed with
 * their event type.
 *
 * Empty at seeding time. It grows by exactly one entry for every entry the seed loses, which is
 * what keeps `keys(SEED) ∪ keys(RETIRED)` invariant and therefore makes the frozen digest in
 * `report-coupling-seed-pin.ts` a signal rather than a value someone regenerates. Deleting from
 * HERE is as illegal as adding: both change the union.
 */
export const REPORT_COUPLING_RETIRED: Readonly<Record<string, ReportCouplingRetiredEntry>> =
  Object.freeze({
    // (none yet — nothing has been re-coupled since the 2026-08-07 seeding)
  });

/** Every seeded event type, sorted — the ratchet's population. */
export const REPORT_COUPLING_SEED_IDS: readonly string[] = Object.freeze(
  Object.keys(REPORT_COUPLING_SEED).sort(),
);

/** Every retired event type, sorted — the other half of the frozen seed key set. */
export const REPORT_COUPLING_RETIRED_IDS: readonly string[] = Object.freeze(
  Object.keys(REPORT_COUPLING_RETIRED).sort(),
);
