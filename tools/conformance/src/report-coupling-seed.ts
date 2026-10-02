// RESERVED(issue: #1473, owner: exarchos, expires: 2027-02-28) — the G3 policy data. Its
// production importer is `report-coupling-census.ts`, which is gate machinery, so no runtime path
// reaches this module.
//
// Generated seed for the G3 report-coupled ratchet. Each key names a registered event type whose
// coupling derives `'model'`: the model must remember a dedicated `exarchos_event.append`, so
// context pressure drops it first. The seed came from `censusReportCoupling().reportCoupled`.
// `report-coupling-census.test.ts` re-derives the population on each run, so a key with no real
// report-coupled registration fails. `owner` derives from the weld of each registration.
//
// This is a membership list, not a count, so a swap of one type for another fails. The audit
// fails on an unseeded report-coupled type, a stale entry, a lapsed `expires`, and a change to the
// key set that `report-coupling-seed-pin.ts` pins. To shrink the seed, re-couple the event. Then
// move its line to {@link REPORT_COUPLING_RETIRED}, with `retiredAt` in place of `expires`.

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
   * The issue that blocks the paydown of this entry, when one exists. Only `team.spawned` and
   * `team.disbanded` carry it, because they cannot be re-coupled until #1473 lands. A test pins
   * this exemption at the two team types, so a third `blockedBy` entry is a visible change.
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
 * The report-coupled population as measured at guard introduction. The explicit type gives each
 * value its contextual type with no `as const`, so it costs nothing from the type-assertion budget.
 * A type that the event-authority charter flipped to telemetry must not move to an `auto` tier.
 * The partition then files it as governance again with no witness. The flip is its paydown.
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
 * Seed entries that left the seed: re-coupled, or removed with their event type. It gains one entry
 * for each entry that the seed loses. So `keys(SEED) ∪ keys(RETIRED)` stays the same, and the
 * frozen digest in `report-coupling-seed-pin.ts` is a signal. A deletion from this map is as
 * illegal as an addition, because both change the union.
 */
export const REPORT_COUPLING_RETIRED: Readonly<Record<string, ReportCouplingRetiredEntry>> =
  Object.freeze({
    /**
     * Re-coupled: `prepare` appends it in the same commit as the prepared record, and
     * `prepare_delegation` appends it before the readiness fold. Its tier is `capability`.
     */
    'task.assigned': { owner: 'workflow:feature', retiredAt: '2026-09-14' },
  });

/** Every seeded event type, sorted — the ratchet's population. */
export const REPORT_COUPLING_SEED_IDS: readonly string[] = Object.freeze(
  Object.keys(REPORT_COUPLING_SEED).sort(),
);

/** Every retired event type, sorted — the other half of the frozen seed key set. */
export const REPORT_COUPLING_RETIRED_IDS: readonly string[] = Object.freeze(
  Object.keys(REPORT_COUPLING_RETIRED).sort(),
);
