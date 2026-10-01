/**
 * Generated seed: the `outputSchema` vacuity allowlist. Each id names an action whose success `data` schema is `z.unknown()`.
 * The list came from `censusOutputSchemas().vacuous`, and the census tests derive it again on each run.
 * It is a membership list, not a count. A count does not change when one vacuous action replaces another.
 *
 * {@link VacuityWaiverId} is the union of the keys, and `vacuityWaiver()` accepts no other id. Thus a new action cannot declare a vacuous schema.
 *
 * `auditVacuityAllowlist()` fails on an unwaived vacuous action, and on a waiver whose action is no longer vacuous.
 * `auditVacuitySeedIntegrity()` pins the key union of the two maps to a frozen digest, so a swap of one key for another fails.
 * `auditVacuityExpiry()` fails on a past `expires` date, or on a date later than the cap of the owner.
 * `deriveOwnerCohorts()` derives the cap of each owner from the seed, so the dates differ by owner. Only the CI guard reads the clock.
 *
 * To shrink the list, give the action a real `data` schema with `withCappedShape(...)`. Then move its line to {@link VACUITY_RETIRED}, with `retiredAt` in place of `expires`.
 * A deleted action retires its waiver the same way. Never add an entry to either map.
 */

/** One waiver: who owns paying it down, and by when. */
export interface VacuityWaiverEntry {
  /** Team accountable for replacing the vacuous schema with a real one. */
  readonly owner: string;
  /**
   * The last day (YYYY-MM-DD) on which the waiver is live. `auditVacuityExpiry()` fails when this day is past.
   * It also fails on a date later than the owner cohort slot or `VACUITY_EXPIRY_HORIZON`, so an entry cannot get more time. An earlier date is always legal.
   */
  readonly expires: string;
}

/**
 * One paid-down or deleted seed entry. The retired map keeps the seed key set constant, so a legal paydown does not change the pinned digest.
 * It is not a suppression list. `auditVacuityAllowlist` reports a retired id that is still vacuous as `UNWAIVED_VACUITY`.
 */
export interface VacuityRetiredEntry {
  /** Team that owned the paydown. Carried over from the waiver. */
  readonly owner: string;
  /** ISO date (YYYY-MM-DD) on which the entry left {@link VACUITY_ALLOWLIST}. */
  readonly retiredAt: string;
}

export const VACUITY_ALLOWLIST = Object.freeze({
  'exarchos_event.append': { owner: 'event-store', expires: '2026-10-25' },
  'exarchos_event.batch_append': { owner: 'event-store', expires: '2026-10-25' },
  'exarchos_event.describe': { owner: 'event-store', expires: '2026-10-25' },
  'exarchos_event.query': { owner: 'event-store', expires: '2026-10-25' },
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
  'exarchos_sync.now': { owner: 'workflow-platform', expires: '2026-12-06' },
  'exarchos_view.code_quality': { owner: 'views', expires: '2027-01-17' },
  'exarchos_view.convergence': { owner: 'views', expires: '2027-01-17' },
  'exarchos_view.delegation_readiness': { owner: 'views', expires: '2027-01-17' },
  'exarchos_view.delegation_timeline': { owner: 'views', expires: '2027-01-17' },
  'exarchos_view.describe': { owner: 'views', expires: '2027-01-17' },
  'exarchos_view.eval_results': { owner: 'views', expires: '2027-01-17' },
  'exarchos_view.gate_reliability': { owner: 'views', expires: '2027-01-17' },
  'exarchos_view.invariants_effective': { owner: 'views', expires: '2027-01-17' },
  'exarchos_view.pipeline': { owner: 'views', expires: '2027-01-17' },
  'exarchos_view.provenance': { owner: 'views', expires: '2027-01-17' },
  'exarchos_view.quality_attribution': { owner: 'views', expires: '2027-01-17' },
  'exarchos_view.quality_correlation': { owner: 'views', expires: '2027-01-17' },
  'exarchos_view.quality_hints': { owner: 'views', expires: '2027-01-17' },
  'exarchos_view.session_provenance': { owner: 'views', expires: '2027-01-17' },
  'exarchos_view.shepherd_status': { owner: 'views', expires: '2027-01-17' },
  'exarchos_view.stack_status': { owner: 'views', expires: '2027-01-17' },
  'exarchos_view.synthesis_readiness': { owner: 'views', expires: '2027-01-17' },
  'exarchos_view.tasks': { owner: 'views', expires: '2027-01-17' },
  'exarchos_view.team_performance': { owner: 'views', expires: '2027-01-17' },
  'exarchos_view.workflow_status': { owner: 'views', expires: '2027-01-17' },
  'exarchos_workflow.cancel': { owner: 'workflow-platform', expires: '2026-12-06' },
  'exarchos_workflow.checkpoint': { owner: 'workflow-platform', expires: '2026-12-06' },
  'exarchos_workflow.cleanup': { owner: 'workflow-platform', expires: '2026-12-06' },
  'exarchos_workflow.describe': { owner: 'workflow-platform', expires: '2026-12-06' },
  'exarchos_workflow.feedback': { owner: 'workflow-platform', expires: '2026-12-06' },
  'exarchos_workflow.get': { owner: 'workflow-platform', expires: '2026-12-06' },
  'exarchos_workflow.init': { owner: 'workflow-platform', expires: '2026-12-06' },
  'exarchos_workflow.reconcile': { owner: 'workflow-platform', expires: '2026-12-06' },
  'exarchos_workflow.rehydrate': { owner: 'workflow-platform', expires: '2026-12-06' },
  'exarchos_workflow.transition': { owner: 'workflow-platform', expires: '2026-12-06' },
  'exarchos_workflow.update': { owner: 'workflow-platform', expires: '2026-12-06' },
}) satisfies Readonly<Record<string, VacuityWaiverEntry>>;

/**
 * Seed entries that left {@link VACUITY_ALLOWLIST}, because the action got a real schema or the action is gone.
 * It grows by one entry for each entry that the allowlist loses. A deletion here is as illegal as an addition, because both change the key union.
 */
export const VACUITY_RETIRED: Readonly<Record<string, VacuityRetiredEntry>> = Object.freeze({
  /** The action now declares `withCappedShape(CheckInvariantConformanceOutputSchema)`. */
  'exarchos_orchestrate.check_invariant_conformance': {
    owner: 'orchestration',
    retiredAt: '2026-08-07',
  },
  /**
   * `cutover_decide` and `cutover_readiness` were new actions with a waiver, which the allowlist forbids. It records only inherited debt.
   * Both now declare `withCappedShape(...)` over the contracts in `verbs/gates/cutover-readiness-schema.ts`.
   */
  'exarchos_orchestrate.cutover_decide': {
    owner: 'orchestration',
    retiredAt: '2026-08-10',
  },
  'exarchos_orchestrate.cutover_readiness': {
    owner: 'orchestration',
    retiredAt: '2026-08-10',
  },
  /**
   * The action is now `exarchos_orchestrate.stack_place`, and it declares `withCappedShape(StackPlaceOutputSchema)`.
   * A waiver under the new key is a key swap, which the digest rejects. The row keeps the `views` owner, because the debt was theirs.
   */
  'exarchos_view.stack_place': {
    owner: 'views',
    retiredAt: '2026-08-17',
  },
});

/**
 * The union of the allowlisted ids. {@link vacuityWaiver} takes this union, so the allowlist can only shrink at compile time.
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
