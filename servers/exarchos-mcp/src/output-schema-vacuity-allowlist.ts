// GENERATED SEED — the `outputSchema` vacuity allowlist (DR-4, task 055).
//
// Every id below names an action declaration whose `outputSchema` has a
// success-branch `data` of `z.unknown()`: total over every payload shape,
// including the wrong ones. The list was SEEDED from
// `censusOutputSchemas().vacuous` — the census's sorted, deduplicated id list —
// and never transcribed by hand. `output-schema-census.test.ts` re-derives it
// from the live census on every run, so a hand-edited entry that does not
// correspond to a real vacuous declaration turns the suite red.
//
// ── Why an allowlist and not a count ────────────────────────────────────────
// A count threshold ("no more than 112 vacuous declarations") is satisfied by
// swapping one vacuous declaration for another: pay down `a`, introduce `b`,
// and the number never moves. Membership cannot be gamed that way — `b` is not
// on the list, so it fails, and `a`'s entry goes stale the moment it is fixed.
//
// ── The four teeth ──────────────────────────────────────────────────────────
//   1. COMPILE TIME. {@link VacuityWaiverId} is the literal union of the keys
//      below, and `vacuityWaiver()` (in `output-schema-declaration.ts`) accepts
//      nothing else. A NEW action cannot declare a vacuous `outputSchema` at
//      all: `EnvelopeSchema(z.unknown())` is unbranded and therefore not
//      assignable to `BuiltinToolAction.outputSchema`, the out-of-registry
//      escape now mints a DIFFERENT brand that a registry declaration cannot
//      use (task 060), and the waiver escape rejects any id that is not already
//      seeded here.
//   2. RUN TIME — MEMBERSHIP. `auditVacuityAllowlist()` in
//      `architecture/output-schema-census.ts` pins this list against the live
//      census in both directions — an unwaived vacuous declaration fails, and a
//      waiver whose declaration is no longer vacuous goes STALE and must be
//      deleted. There is no way to park a paid-down entry here.
//   3. RUN TIME — KEY-SET INTEGRITY (task 060). Teeth 1 and 2 both compare this
//      file against TODAY. Neither can see an IN-PLACE SWAP: pay `a` down, make
//      `c` vacuous, and edit this file to drop `a` and add `c` — every
//      comparison against today's registry agrees, and the count never moves.
//      Detecting "only removals happened" needs PRIOR STATE, so
//      `auditVacuitySeedIntegrity()` pins the union of {@link VACUITY_ALLOWLIST}
//      and {@link VACUITY_RETIRED} against the frozen digest in
//      `output-schema-seed-pin.ts`. A paid-down entry MOVES to `VACUITY_RETIRED`
//      instead of being deleted, so the union is invariant and the pin never
//      changes for any legal edit.
//   4. RUN TIME — EXPIRY (task 017). Teeth 1-3 govern WHICH declarations may be
//      waived. None of them governs FOR HOW LONG, and until task 017 nothing
//      did: `expires` below was written by task 055 and read by no code path, so
//      the "wave-scoped" deadline DR-4 specifies was a permanent exemption
//      wearing a date. `auditVacuityExpiry()` in
//      `architecture/output-schema-census.ts` now fails on an entry whose
//      `expires` is past, and — because a deadline its own owner may move is not
//      a deadline — ALSO fails on an entry whose `expires` is later than the
//      single pinned `VACUITY_EXPIRY_HORIZON` in `output-schema-seed-pin.ts`.
//      An entry therefore cannot renew itself at all; re-dating the debt means
//      moving one frozen constant in a file that contains nothing else, as a
//      deliberate commit. The clock is read once, at the CI guard's entrypoint
//      (`servers/exarchos-mcp/scripts/output-schema-ratchet-guard.ts`), never
//      inside the unit suite — a deadline must redden the MERGE, not a developer's
//      local `vitest run`.
//
// ── How to shrink it ────────────────────────────────────────────────────────
// Give the action a real `data` schema, declare it with `withCappedShape(...)`,
// and MOVE its line from {@link VACUITY_ALLOWLIST} to {@link VACUITY_RETIRED},
// swapping `expires` for `retiredAt: '<the date you paid it down>'`. That is the
// only supported edit. Entries are never ADDED to either map: an addition
// changes the seed key set, and the pinned digest is what makes that a red
// build rather than a line a reviewer has to notice.
//
// If an action is DELETED outright, its waiver is retired the same way — the
// debt did not get paid, but the declaration is gone, and tooth 2 would
// otherwise report the waiver stale forever.
//
// Owner is derived from the declaring composite tool; the expiry is the seed's
// uniform horizon, which task 017 pinned as `VACUITY_EXPIRY_HORIZON` and
// enforces over exactly this shape — the entry record is `{ owner, expires }`
// and must stay that way.

/** One waiver: who owns paying it down, and by when. */
export interface VacuityWaiverEntry {
  /** Team accountable for replacing the vacuous schema with a real one. */
  readonly owner: string;
  /**
   * ISO date (YYYY-MM-DD) after which the waiver is expired — the waiver is live
   * THROUGH this day and dead the next. ENFORCED by `auditVacuityExpiry()`, and
   * capped by `VACUITY_EXPIRY_HORIZON`: a date later than the horizon fails, so
   * an entry cannot buy itself more time. Bringing a date FORWARD is always
   * legal (it only shortens the debt's life).
   */
  readonly expires: string;
}

/**
 * One PAID-DOWN (or deleted) seed entry.
 *
 * The graveyard exists for one reason: it keeps the SEED KEY SET invariant. The
 * pinned digest in `output-schema-seed-pin.ts` is taken over
 * `keys(VACUITY_ALLOWLIST) ∪ keys(VACUITY_RETIRED)`, so a legal paydown is a
 * MOVE (digest unchanged) and an illegal addition is a GROWTH (digest changed).
 * That is the whole difference between "the list shrank" and "the list was
 * swapped", and it is not derivable from today's registry alone.
 *
 * It is not a suppression list. A retired id that is STILL vacuous is not
 * waived, so `auditVacuityAllowlist` reports it as `UNWAIVED_VACUITY` — moving
 * an entry here without doing the work fails louder than leaving it alone.
 */
export interface VacuityRetiredEntry {
  /** Team that owned the paydown. Carried over from the waiver. */
  readonly owner: string;
  /** ISO date (YYYY-MM-DD) on which the entry left {@link VACUITY_ALLOWLIST}. */
  readonly retiredAt: string;
}

export const VACUITY_ALLOWLIST = Object.freeze({
  'exarchos_event.append': { owner: 'event-store', expires: '2027-02-28' },
  'exarchos_event.batch_append': { owner: 'event-store', expires: '2027-02-28' },
  'exarchos_event.describe': { owner: 'event-store', expires: '2027-02-28' },
  'exarchos_event.query': { owner: 'event-store', expires: '2027-02-28' },
  'exarchos_orchestrate.add_pr_comment': { owner: 'orchestration', expires: '2027-02-28' },
  'exarchos_orchestrate.agent_spec': { owner: 'orchestration', expires: '2027-02-28' },
  'exarchos_orchestrate.assess_refactor_scope': { owner: 'orchestration', expires: '2027-02-28' },
  'exarchos_orchestrate.assess_stack': { owner: 'orchestration', expires: '2027-02-28' },
  'exarchos_orchestrate.check_ci': { owner: 'orchestration', expires: '2027-02-28' },
  'exarchos_orchestrate.check_coderabbit': { owner: 'orchestration', expires: '2027-02-28' },
  'exarchos_orchestrate.check_context_economy': { owner: 'orchestration', expires: '2027-02-28' },
  'exarchos_orchestrate.check_contract_drift': { owner: 'orchestration', expires: '2027-02-28' },
  'exarchos_orchestrate.check_convergence': { owner: 'orchestration', expires: '2027-02-28' },
  'exarchos_orchestrate.check_coverage_thresholds': { owner: 'orchestration', expires: '2027-02-28' },
  'exarchos_orchestrate.check_design_completeness': { owner: 'orchestration', expires: '2027-02-28' },
  'exarchos_orchestrate.check_event_emissions': { owner: 'orchestration', expires: '2027-02-28' },
  'exarchos_orchestrate.check_exploration_depth': { owner: 'orchestration', expires: '2027-02-28' },
  'exarchos_orchestrate.check_integration_suite': { owner: 'orchestration', expires: '2027-02-28' },
  'exarchos_orchestrate.check_mock_boundary': { owner: 'orchestration', expires: '2027-02-28' },
  'exarchos_orchestrate.check_operational_resilience': { owner: 'orchestration', expires: '2027-02-28' },
  'exarchos_orchestrate.check_plan_coverage': { owner: 'orchestration', expires: '2027-02-28' },
  'exarchos_orchestrate.check_polish_scope': { owner: 'orchestration', expires: '2027-02-28' },
  'exarchos_orchestrate.check_post_merge': { owner: 'orchestration', expires: '2027-02-28' },
  'exarchos_orchestrate.check_pr_comments': { owner: 'orchestration', expires: '2027-02-28' },
  'exarchos_orchestrate.check_provenance_chain': { owner: 'orchestration', expires: '2027-02-28' },
  'exarchos_orchestrate.check_review_verdict': { owner: 'orchestration', expires: '2027-02-28' },
  'exarchos_orchestrate.check_security_scan': { owner: 'orchestration', expires: '2027-02-28' },
  'exarchos_orchestrate.check_static_analysis': { owner: 'orchestration', expires: '2027-02-28' },
  'exarchos_orchestrate.check_task_decomposition': { owner: 'orchestration', expires: '2027-02-28' },
  'exarchos_orchestrate.check_test_adequacy': { owner: 'orchestration', expires: '2027-02-28' },
  'exarchos_orchestrate.check_workflow_determinism': { owner: 'orchestration', expires: '2027-02-28' },
  'exarchos_orchestrate.classify_review_items': { owner: 'orchestration', expires: '2027-02-28' },
  'exarchos_orchestrate.create_issue': { owner: 'orchestration', expires: '2027-02-28' },
  'exarchos_orchestrate.create_pr': { owner: 'orchestration', expires: '2027-02-28' },
  'exarchos_orchestrate.cutover_decide': { owner: 'orchestration', expires: '2027-02-28' },
  'exarchos_orchestrate.cutover_readiness': { owner: 'orchestration', expires: '2027-02-28' },
  'exarchos_orchestrate.debug_review_gate': { owner: 'orchestration', expires: '2027-02-28' },
  'exarchos_orchestrate.describe': { owner: 'orchestration', expires: '2027-02-28' },
  'exarchos_orchestrate.discover_bridge': { owner: 'orchestration', expires: '2027-02-28' },
  'exarchos_orchestrate.doctor': { owner: 'orchestration', expires: '2027-02-28' },
  'exarchos_orchestrate.extract_fix_tasks': { owner: 'orchestration', expires: '2027-02-28' },
  'exarchos_orchestrate.extract_task': { owner: 'orchestration', expires: '2027-02-28' },
  'exarchos_orchestrate.finalize_oneshot': { owner: 'orchestration', expires: '2027-02-28' },
  'exarchos_orchestrate.generate_traceability': { owner: 'orchestration', expires: '2027-02-28' },
  'exarchos_orchestrate.get_pr_comments': { owner: 'orchestration', expires: '2027-02-28' },
  'exarchos_orchestrate.invariants_add': { owner: 'orchestration', expires: '2027-02-28' },
  'exarchos_orchestrate.invariants_scaffold': { owner: 'orchestration', expires: '2027-02-28' },
  'exarchos_orchestrate.investigation_timer': { owner: 'orchestration', expires: '2027-02-28' },
  'exarchos_orchestrate.list_prs': { owner: 'orchestration', expires: '2027-02-28' },
  'exarchos_orchestrate.merge_orchestrate': { owner: 'orchestration', expires: '2027-02-28' },
  'exarchos_orchestrate.merge_pr': { owner: 'orchestration', expires: '2027-02-28' },
  'exarchos_orchestrate.mutation-adequacy': { owner: 'orchestration', expires: '2027-02-28' },
  'exarchos_orchestrate.needs_schema_sync': { owner: 'orchestration', expires: '2027-02-28' },
  'exarchos_orchestrate.onboard': { owner: 'orchestration', expires: '2027-02-28' },
  'exarchos_orchestrate.post_delegation_check': { owner: 'orchestration', expires: '2027-02-28' },
  'exarchos_orchestrate.pre_synthesis_check': { owner: 'orchestration', expires: '2027-02-28' },
  'exarchos_orchestrate.prepare_delegation': { owner: 'orchestration', expires: '2027-02-28' },
  'exarchos_orchestrate.prepare_review': { owner: 'orchestration', expires: '2027-02-28' },
  'exarchos_orchestrate.prepare_synthesis': { owner: 'orchestration', expires: '2027-02-28' },
  'exarchos_orchestrate.prune_stale_workflows': { owner: 'orchestration', expires: '2027-02-28' },
  'exarchos_orchestrate.reconcile_state': { owner: 'orchestration', expires: '2027-02-28' },
  'exarchos_orchestrate.request_synthesize': { owner: 'orchestration', expires: '2027-02-28' },
  'exarchos_orchestrate.review_diff': { owner: 'orchestration', expires: '2027-02-28' },
  'exarchos_orchestrate.review_triage': { owner: 'orchestration', expires: '2027-02-28' },
  'exarchos_orchestrate.runbook': { owner: 'orchestration', expires: '2027-02-28' },
  'exarchos_orchestrate.select_debug_track': { owner: 'orchestration', expires: '2027-02-28' },
  'exarchos_orchestrate.setup_worktree': { owner: 'orchestration', expires: '2027-02-28' },
  'exarchos_orchestrate.spec_coverage_check': { owner: 'orchestration', expires: '2027-02-28' },
  'exarchos_orchestrate.task_claim': { owner: 'orchestration', expires: '2027-02-28' },
  'exarchos_orchestrate.task_complete': { owner: 'orchestration', expires: '2027-02-28' },
  'exarchos_orchestrate.task_fail': { owner: 'orchestration', expires: '2027-02-28' },
  'exarchos_orchestrate.validate_pr_body': { owner: 'orchestration', expires: '2027-02-28' },
  'exarchos_orchestrate.validate_pr_stack': { owner: 'orchestration', expires: '2027-02-28' },
  'exarchos_orchestrate.verify_delegation_saga': { owner: 'orchestration', expires: '2027-02-28' },
  'exarchos_orchestrate.verify_doc_links': { owner: 'orchestration', expires: '2027-02-28' },
  'exarchos_orchestrate.verify_review_triage': { owner: 'orchestration', expires: '2027-02-28' },
  'exarchos_orchestrate.verify_worktree': { owner: 'orchestration', expires: '2027-02-28' },
  'exarchos_orchestrate.verify_worktree_baseline': { owner: 'orchestration', expires: '2027-02-28' },
  'exarchos_sync.now': { owner: 'workflow-platform', expires: '2027-02-28' },
  'exarchos_view.code_quality': { owner: 'views', expires: '2027-02-28' },
  'exarchos_view.convergence': { owner: 'views', expires: '2027-02-28' },
  'exarchos_view.delegation_readiness': { owner: 'views', expires: '2027-02-28' },
  'exarchos_view.delegation_timeline': { owner: 'views', expires: '2027-02-28' },
  'exarchos_view.describe': { owner: 'views', expires: '2027-02-28' },
  'exarchos_view.eval_results': { owner: 'views', expires: '2027-02-28' },
  'exarchos_view.gate_reliability': { owner: 'views', expires: '2027-02-28' },
  'exarchos_view.invariants_effective': { owner: 'views', expires: '2027-02-28' },
  'exarchos_view.pipeline': { owner: 'views', expires: '2027-02-28' },
  'exarchos_view.provenance': { owner: 'views', expires: '2027-02-28' },
  'exarchos_view.quality_attribution': { owner: 'views', expires: '2027-02-28' },
  'exarchos_view.quality_correlation': { owner: 'views', expires: '2027-02-28' },
  'exarchos_view.quality_hints': { owner: 'views', expires: '2027-02-28' },
  'exarchos_view.session_provenance': { owner: 'views', expires: '2027-02-28' },
  'exarchos_view.shepherd_status': { owner: 'views', expires: '2027-02-28' },
  'exarchos_view.stack_place': { owner: 'views', expires: '2027-02-28' },
  'exarchos_view.stack_status': { owner: 'views', expires: '2027-02-28' },
  'exarchos_view.synthesis_readiness': { owner: 'views', expires: '2027-02-28' },
  'exarchos_view.tasks': { owner: 'views', expires: '2027-02-28' },
  'exarchos_view.team_performance': { owner: 'views', expires: '2027-02-28' },
  'exarchos_view.workflow_status': { owner: 'views', expires: '2027-02-28' },
  'exarchos_workflow.cancel': { owner: 'workflow-platform', expires: '2027-02-28' },
  'exarchos_workflow.checkpoint': { owner: 'workflow-platform', expires: '2027-02-28' },
  'exarchos_workflow.cleanup': { owner: 'workflow-platform', expires: '2027-02-28' },
  'exarchos_workflow.describe': { owner: 'workflow-platform', expires: '2027-02-28' },
  'exarchos_workflow.feedback': { owner: 'workflow-platform', expires: '2027-02-28' },
  'exarchos_workflow.get': { owner: 'workflow-platform', expires: '2027-02-28' },
  'exarchos_workflow.init': { owner: 'workflow-platform', expires: '2027-02-28' },
  'exarchos_workflow.reconcile': { owner: 'workflow-platform', expires: '2027-02-28' },
  'exarchos_workflow.rehydrate': { owner: 'workflow-platform', expires: '2027-02-28' },
  'exarchos_workflow.transition': { owner: 'workflow-platform', expires: '2027-02-28' },
  'exarchos_workflow.update': { owner: 'workflow-platform', expires: '2027-02-28' },
}) satisfies Readonly<Record<string, VacuityWaiverEntry>>;

/**
 * Seed entries that have LEFT {@link VACUITY_ALLOWLIST} — paid down (the schema
 * is substantive now) or removed with their action.
 *
 * Empty at seeding time, and it grows by exactly one entry for every entry the
 * allowlist loses. `keys(VACUITY_ALLOWLIST) ∪ keys(VACUITY_RETIRED)` is the
 * frozen seed key set that `output-schema-seed-pin.ts` pins, which is what makes
 * an in-place swap a red build instead of a diff a reviewer must catch.
 *
 * Deleting from HERE is as illegal as adding: both change the union. When the
 * allowlist reaches zero, `VacuityWaiverId` becomes `never`, `vacuityWaiver()`
 * is uncallable, and this whole module — graveyard, pin and all — is deleted in
 * one commit.
 */
export const VACUITY_RETIRED: Readonly<Record<string, VacuityRetiredEntry>> = Object.freeze({
  // TASK 069 — the first paydown. The gate that evaluates conformance to the
  // catalog CONTAINING the anti-vacuity invariant was itself on this allowlist,
  // so the audit-mode prompt it exists to deliver crossed the tool boundary
  // through a schema constraining nothing. It now declares
  // `withCappedShape(CheckInvariantConformanceOutputSchema)` — see
  // `orchestrate/check-invariant-conformance-schema.ts`. The id MOVED here
  // rather than being deleted, so `keys(VACUITY_ALLOWLIST) ∪ keys(VACUITY_RETIRED)`
  // is unchanged and `VACUITY_SEED_KEY_SET_DIGEST` did NOT have to be touched —
  // which is the whole point of the graveyard.
  'exarchos_orchestrate.check_invariant_conformance': {
    owner: 'orchestration',
    retiredAt: '2026-08-07',
  },
});

/**
 * The literal union of every allowlisted declaration id. This is the type that
 * makes the allowlist SHRINK-ONLY at compile time: {@link vacuityWaiver} takes
 * this union, so an action id that is not already seeded here cannot be waived
 * without editing this generated file.
 */
export type VacuityWaiverId = keyof typeof VACUITY_ALLOWLIST;

/** Every seeded id, sorted — the ratchet's population. */
export const VACUITY_ALLOWLIST_IDS: readonly string[] = Object.freeze(
  Object.keys(VACUITY_ALLOWLIST).sort(),
);

/** Every retired id, sorted — the other half of the frozen seed key set. */
export const VACUITY_RETIRED_IDS: readonly string[] = Object.freeze(
  Object.keys(VACUITY_RETIRED).sort(),
);
