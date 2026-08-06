/**
 * P06-01 Legacy Guard Classification Corpus (DR-1)
 *
 * Machine-readable classification of every legacy guard predicate in the
 * Exarchos workflow engine. Each entry maps a stable guard ID to exactly one
 * of the six DR-1 categories:
 *
 *   route-condition      — pure declarative selector that picks one of multiple
 *                          outbound edges at a branch point; no enforcement
 *                          severity, remediation, or I/O.
 *   admission-requirement — certifies a precondition, artifact, or event-
 *                          sourced fact before a phase may advance.
 *   bounded-loop-rule    — enforces a numeric cycle/iteration cap to terminate
 *                          a revision or retry loop.
 *   approval             — requires an explicit approval signal from a human
 *                          operator or an authorized process.
 *   waiver               — an exceptional scoped bypass allowance. None exist
 *                          in the legacy engine; the legacy bypass mechanism is
 *                          direct state mutation, not a typed waiver event.
 *   obsolete-predicate   — always passes (no-op) OR is defined but not
 *                          referenced in any currently active HSM transition.
 *
 * This corpus is migration input for the evidence-backed admission engine
 * (P06-02+). It characterizes CURRENT behavior — including permissive no-op
 * guards — rather than defining target policy.
 *
 * Sources:
 *   - servers/exarchos-mcp/src/workflow/guards.ts  (37 guards)
 *   - servers/exarchos-mcp/src/workflow/hsm-definitions.ts  (2 composite guards)
 */

// ─── Types ───────────────────────────────────────────────────────────────────

/**
 * The six DR-1 guard categories. Every legacy guard must map to exactly one.
 */
export type GuardCategory =
  | 'route-condition'
  | 'admission-requirement'
  | 'bounded-loop-rule'
  | 'approval'
  | 'waiver'
  | 'obsolete-predicate';

export const GUARD_CATEGORIES: readonly GuardCategory[] = Object.freeze([
  'route-condition',
  'admission-requirement',
  'bounded-loop-rule',
  'approval',
  'waiver',
  'obsolete-predicate',
]);

export interface GuardClassificationEntry {
  /** Stable guard ID (guard.id property, not the guards-object key). */
  readonly id: string;
  readonly category: GuardCategory;
  /**
   * Short rationale used by later packages to understand the classification
   * decision and any notable legacy behavior.
   */
  readonly rationale: string;
  /**
   * When true, this guard's behavior is a known defect or permissive anomaly
   * that should be addressed in a later remediation package. Captured here so
   * the characterization corpus acts as a living defect inventory, not just a
   * snapshot.
   */
  readonly flaggedForRemediation?: true;
  /**
   * Human-readable description of the defect/anomaly, required when
   * flaggedForRemediation is true.
   */
  readonly defectNote?: string;
}

// ─── Classification Record ───────────────────────────────────────────────────

/**
 * Classification of every legacy guard, keyed by stable guard ID.
 * The record is the authoritative machine-readable source: later packages may
 * consume it to generate admission IR, migration reports, and validation gates.
 *
 * Constraints enforced by guard-classification.test.ts:
 *   - Total coverage: every guard in guards.ts + composite guards in
 *     hsm-definitions.ts has exactly one entry.
 *   - No duplicates: each guard ID appears exactly once.
 *   - Valid categories: every category value is a member of GUARD_CATEGORIES.
 */
export const GUARD_CLASSIFICATIONS: Readonly<Record<string, GuardClassificationEntry>> =
  Object.freeze({

    // ── Route Conditions ─────────────────────────────────────────────────────
    // These guards select one outbound edge at a branch point. They carry no
    // enforcement severity, evidence requirements, or remediation hints.

    'hotfix-track-selected': {
      id: 'hotfix-track-selected',
      category: 'route-condition',
      rationale:
        'Selects the hotfix track at the investigate→hotfix-implement fork. ' +
        'Mutually exclusive with thorough-track-selected at the same source phase.',
    },

    'thorough-track-selected': {
      id: 'thorough-track-selected',
      category: 'route-condition',
      rationale:
        'Selects the thorough (RCA) track at the investigate→rca fork. ' +
        'Mutually exclusive with hotfix-track-selected at the same source phase.',
    },

    'polish-track-selected': {
      id: 'polish-track-selected',
      category: 'route-condition',
      rationale:
        'Selects the polish track at the brief→polish-implement fork. ' +
        'Mutually exclusive with overhaul-track-selected at the same source phase.',
    },

    'overhaul-track-selected': {
      id: 'overhaul-track-selected',
      category: 'route-condition',
      rationale:
        'Selects the overhaul track at the brief→overhaul-plan fork. ' +
        'Mutually exclusive with polish-track-selected at the same source phase.',
    },

    'synthesis-opted-in': {
      id: 'synthesis-opted-in',
      category: 'route-condition',
      rationale:
        'Selects the synthesize path at the implementing→synthesize fork in the oneshot ' +
        'workflow. Reads synthesisPolicy and the synthesize.requested event. Mutually ' +
        'exclusive with synthesis-opted-out by construction (inlined inverses, not composed).',
    },

    'synthesis-opted-out': {
      id: 'synthesis-opted-out',
      category: 'route-condition',
      rationale:
        'Selects the direct-commit path at the implementing→completed fork in the oneshot ' +
        'workflow. Inlined inverse of synthesis-opted-in; the two guards are never composed ' +
        'from each other to prevent the missing-inverse anti-pattern.',
    },

    'any-review-failed': {
      id: 'any-review-failed',
      category: 'route-condition',
      rationale:
        'Routes the review→delegate fix-cycle when at least one review entry has a failed ' +
        'status. Acts as the failing branch at a review fork; paired with all-reviews-passed ' +
        'on the passing branch.',
    },

    'plan-review-gaps-found': {
      id: 'plan-review-gaps-found',
      category: 'route-condition',
      rationale:
        'Routes plan-review→plan (revision edge) when planReview.gapsFound is true. ' +
        'DR-1: the revise edge is ordered AFTER the revisionsExhausted guard so the cap ' +
        'fires before another revision is permitted.',
    },

    'escalation-required': {
      id: 'escalation-required',
      category: 'route-condition',
      rationale:
        'Routes investigate→cancelled when the investigation determines an architectural ' +
        'redesign is required. Selects the cancellation/escalation path at a three-way ' +
        'investigate fork (thorough / hotfix / escalate).',
      flaggedForRemediation: true,
      defectNote:
        'In the legacy HSM, executeTransition treats "cancelled" as a universal ' +
        'final-state edge that bypasses guard evaluation. The corpus records this as a ' +
        'bypass: investigate→cancelled ALLOWS even when escalation-required FAILS. ' +
        'The guard is therefore advisory rather than enforcing for this transition.',
    },

    // ── Admission Requirements ───────────────────────────────────────────────
    // These guards certify that a precondition, artifact, or event-sourced fact
    // is present before a phase may advance. Each maps to a typed evidence
    // requirement in the new admission engine.

    'plan-artifact-exists': {
      id: 'plan-artifact-exists',
      category: 'admission-requirement',
      rationale:
        'Certifies that a plan artifact is present (artifacts.plan or fallback state.plan) ' +
        'before advancing from plan→plan-review (feature/refactor overhaul track).',
    },

    'oneshot-plan-set': {
      id: 'oneshot-plan-set',
      category: 'admission-requirement',
      rationale:
        'Certifies that artifacts.plan is a non-empty string before advancing oneshot ' +
        'plan→implementing. Tightened in F23 (#1213) to reject non-string values; ' +
        'oneshot.planSummary alone is insufficient.',
    },

    'rca-document-complete': {
      id: 'rca-document-complete',
      category: 'admission-requirement',
      rationale:
        'Certifies that an RCA document artifact is present (artifacts.rca) before the ' +
        'debug thorough track advances rca→design.',
    },

    'fix-design-complete': {
      id: 'fix-design-complete',
      category: 'admission-requirement',
      rationale:
        'Certifies that a fix design artifact is present (artifacts.fixDesign) before ' +
        'the debug thorough track advances design→debug-implement.',
    },

    'sources-collected': {
      id: 'sources-collected',
      category: 'admission-requirement',
      rationale:
        'Certifies that at least one source artifact is present (artifacts.sources as a ' +
        'non-empty array) before the discovery workflow advances gathering→synthesizing.',
    },

    'report-artifact-exists': {
      id: 'report-artifact-exists',
      category: 'admission-requirement',
      rationale:
        'Certifies that a report artifact is present (artifacts.report) before the ' +
        'discovery workflow advances synthesizing→completed.',
    },

    'triage-complete': {
      id: 'triage-complete',
      category: 'admission-requirement',
      rationale:
        'Certifies that triage data (triage.symptom) has been captured before the debug ' +
        'workflow advances triage→investigate.',
    },

    'scope-assessment-complete': {
      id: 'scope-assessment-complete',
      category: 'admission-requirement',
      rationale:
        'Certifies that a scope assessment is present (explore.scopeAssessment or legacy ' +
        'root-level scopeAssessment) before the refactor workflow advances explore→brief.',
    },

    'validation-passed': {
      id: 'validation-passed',
      category: 'admission-requirement',
      rationale:
        'Certifies that tests pass (validation.testsPass === true) before advancing through ' +
        'debug-validate→debug-review, hotfix-validate→synthesize, or hotfix-validate→completed. ' +
        'Also used as the first part of the validation+pr-requested composite guard.',
    },

    'review-passed': {
      id: 'review-passed',
      category: 'admission-requirement',
      rationale:
        'Certifies that all review entries have passed statuses before the debug thorough ' +
        'track advances debug-review→synthesize. Equivalent to all-reviews-passed in ' +
        'behavior (only flat/nested status inspection, no required-dimension enforcement ' +
        'in the legacy guard).',
    },

    'all-tasks-complete': {
      id: 'all-tasks-complete',
      category: 'admission-requirement',
      rationale:
        'Certifies that every task in state.tasks has status "complete" before advancing ' +
        'from delegate→review. Vacuously passes on empty task arrays — a known permissive ' +
        'behavior captured in bypass-empty-task-collection-is-complete.',
      flaggedForRemediation: true,
      defectNote:
        'An empty tasks array satisfies this guard (vacuous pass). An orchestrator that ' +
        'never populates tasks can advance delegate→review without any work being done. ' +
        'The evidence-backed system must require at least one completed task or explicit ' +
        'delegation evidence.',
    },

    'team-disbanded-emitted': {
      id: 'team-disbanded-emitted',
      category: 'admission-requirement',
      rationale:
        'Certifies that a team.disbanded event is present in _events when a team was ' +
        'spawned (team.spawned present). Passes vacuously when no team was spawned ' +
        '(subagent-only mode).',
    },

    'pr-url-exists': {
      id: 'pr-url-exists',
      category: 'admission-requirement',
      rationale:
        'Certifies that synthesis.prUrl or artifacts.pr is set before advancing ' +
        'synthesize→completed across feature, debug, and refactor workflows.',
    },

    'fix-verified-directly': {
      id: 'fix-verified-directly',
      category: 'admission-requirement',
      rationale:
        'Certifies that a direct-push fix has been committed (resolution.directPush=true ' +
        'and resolution.commitSha present) before investigate→completed on the debug ' +
        'hotfix track (no-PR path).',
    },

    'merge-verified': {
      id: 'merge-verified',
      category: 'admission-requirement',
      rationale:
        'Certifies that the orchestrator has verified merges are complete (_cleanup.mergeVerified) ' +
        'before oneshot synthesize→completed. Prevents cleanup from running before merge evidence.',
    },

    'docs-updated': {
      id: 'docs-updated',
      category: 'admission-requirement',
      rationale:
        'Certifies that documentation has been updated (validation.docsUpdated=true) before ' +
        'advancing polish-update-docs→completed and overhaul-update-docs→synthesize in the ' +
        'refactor workflow.',
    },

    'goals-verified': {
      id: 'goals-verified',
      category: 'admission-requirement',
      rationale:
        'Certifies that refactor goals are verified (validation.testsPass=true) before the ' +
        'refactor polish track advances polish-validate→polish-update-docs. Structurally ' +
        'equivalent to validation-passed in implementation.',
    },

    'merge-pending-entry': {
      id: 'merge-pending-entry',
      category: 'admission-requirement',
      rationale:
        'Composite guard (hsm-definitions.ts): certifies that the most recent task.completed ' +
        'event carries a worktree association (data.worktree or data.worktreePath) AND the ' +
        'mergeOrchestrator has not already terminated (not in EXCLUDED_MERGE_PHASES). ' +
        'Guards delegate→merge-pending auto-trigger.',
    },

    'merge-pending-exit': {
      id: 'merge-pending-exit',
      category: 'admission-requirement',
      rationale:
        'Composite guard (hsm-definitions.ts): certifies that a terminal merge event ' +
        '(merge.executed, merge.rollback, merge.recovered, or merge.aborted) follows the ' +
        'latest task.completed in the event stream, OR that mergeOrchestrator.phase is ' +
        'terminal. Guards merge-pending→delegate. Cycle-scoped to prevent stale prior-cycle ' +
        'events from prematurely exiting merge-pending.',
    },

    // ── Bounded-Loop Rules ───────────────────────────────────────────────────
    // These guards terminate a revision or retry loop when a numeric counter
    // reaches a configurable cap.

    'revisions-exhausted': {
      id: 'revisions-exhausted',
      category: 'bounded-loop-rule',
      rationale:
        'Terminates the plan-review → plan revision loop when planReview.revisionCount ' +
        'reaches the cap (state._maxPlanRevisions, default DEFAULT_MAX_PLAN_REVISIONS=1). ' +
        'DR-1: ordered BEFORE the plan-review-gaps-found revise edge so the cap fires first.',
    },

    'synthesize-retryable': {
      id: 'synthesize-retryable',
      category: 'bounded-loop-rule',
      rationale:
        'Allows synthesize→delegate/debug-implement/hotfix-implement retries when ' +
        'synthesis.lastError is set AND synthesis.retryCount < MAX_SYNTHESIZE_RETRIES (3). ' +
        'Combines error presence (admission) with retry cap (loop rule).',
    },

    // ── Approvals ────────────────────────────────────────────────────────────
    // These guards require an explicit approval signal from a human operator or
    // an authorized process. In the legacy system these are patched booleans;
    // the new system requires typed waiver/approval evidence.

    'plan-review-complete': {
      id: 'plan-review-complete',
      category: 'approval',
      rationale:
        'Requires planReview.approved=true before plan-review→delegate. This is a human ' +
        'approval that a plan is ready for delegation. In the legacy system it is a patched ' +
        'boolean — no attribution, expiry, or scope.',
      flaggedForRemediation: true,
      defectNote:
        'planReview.approved is a plain mutable boolean. Any caller can patch it directly ' +
        'without identity, scope, or expiry. The evidence-backed system must require a ' +
        'typed approval event or waiver.',
    },

    'all-reviews-passed': {
      id: 'all-reviews-passed',
      category: 'approval',
      rationale:
        'Requires that all review entries (flat, nested, or legacy passed:boolean) have ' +
        'passed statuses before review→synthesize (feature/refactor overhaul). Enforces ' +
        'required review dimensions (state._requiredReviews) since #1076. Checks mutation ' +
        'score and NoCoverage under block mode (DR-3/DR-6).',
    },

    'human-unblocked': {
      id: 'human-unblocked',
      category: 'approval',
      rationale:
        'Requires state.unblocked=true before blocked→delegate (feature) or ' +
        'blocked→overhaul-delegate (refactor). Represents a human decision to unblock the ' +
        'workflow. In the legacy system it is a patched boolean with no attribution.',
      flaggedForRemediation: true,
      defectNote:
        'state.unblocked is a plain mutable boolean. The evidence-backed system must require ' +
        'a typed unblock-approval event with identity and optional scope.',
    },

    'pr-requested': {
      id: 'pr-requested',
      category: 'approval',
      rationale:
        'Requires synthesis.requested=true as part of the validation+pr-requested composite ' +
        'guard for hotfix-validate→synthesize. Represents an explicit intent to create a PR ' +
        'rather than pushing directly. Effectively an opt-in approval for the PR path.',
    },

    // ── Obsolete Predicates ──────────────────────────────────────────────────
    // These guards are either always-passing no-ops or are not referenced in
    // any currently active HSM transition. They are retained in guards.ts for
    // backward compatibility but carry no enforcement weight.

    'design-artifact-exists': {
      id: 'design-artifact-exists',
      category: 'obsolete-predicate',
      rationale:
        'Was the guard for the ideate→plan transition in the old feature workflow. ' +
        'That transition was retired in DR-4 (#1581) when the `ideate` (GATHER) state was ' +
        'collapsed into `plan`. The guard definition remains in guards.ts but is not ' +
        'referenced in any active HSM transition.',
      flaggedForRemediation: true,
      defectNote:
        'Dead code. Should be removed when the legacy guard registry is retired (Program-07).',
    },

    'root-cause-found': {
      id: 'root-cause-found',
      category: 'obsolete-predicate',
      rationale:
        'Defined in guards.ts (investigation.rootCause check) but not referenced in any ' +
        'active HSM transition. The debug workflow uses triage-complete and track-selection ' +
        'guards instead of an explicit root-cause gate.',
      flaggedForRemediation: true,
      defectNote:
        'Dead code. The absence of a root-cause gate on the investigate→rca transition means ' +
        'the thorough track can advance without recording a root cause. ' +
        'Should be either wired into the thorough track or removed.',
    },

    'brief-complete': {
      id: 'brief-complete',
      category: 'obsolete-predicate',
      rationale:
        'Defined in guards.ts (brief.goals check) but not referenced in any active HSM ' +
        'transition. The refactor workflow uses scope-assessment-complete and track-selection ' +
        'guards instead of an explicit brief-complete gate.',
      flaggedForRemediation: true,
      defectNote:
        'Dead code. Without a brief-complete gate, the refactor workflow can advance from ' +
        'brief without goals being set. Should be either wired into the brief phase or removed.',
    },

    'implementation-complete': {
      id: 'implementation-complete',
      category: 'obsolete-predicate',
      rationale:
        'evaluate() unconditionally returns true. It was likely intended as a placeholder ' +
        'for real implementation verification that was never added. Used on ' +
        'debug-implement→debug-validate, hotfix-implement→hotfix-validate, and ' +
        'polish-implement→polish-validate transitions.',
      flaggedForRemediation: true,
      defectNote:
        'Always-pass no-op. Any state advances through these transitions without any ' +
        'implementation evidence. The bypass corpus records this explicitly. The new system ' +
        'must require typed implementation evidence (e.g., task-completed events with code ' +
        'changes) rather than an unconditional pass.',
    },

    'always': {
      id: 'always',
      category: 'obsolete-predicate',
      rationale:
        'Explicit always-pass guard (evaluate: () => true). Not referenced in any active ' +
        'HSM transition. Exists as a utility but serves no enforcement purpose.',
      flaggedForRemediation: true,
      defectNote:
        'Dead code. Should be removed when the legacy guard registry is retired (Program-07).',
    },

    // ── Composite Guards (hsm-definitions.ts) ────────────────────────────────
    // These compound guards are created via composeGuards() and are only defined
    // inside hsm-definitions.ts. They are not exported from guards.ts.

    'all-tasks-complete+team-disbanded': {
      id: 'all-tasks-complete+team-disbanded',
      category: 'admission-requirement',
      rationale:
        'Composite of all-tasks-complete and team-disbanded-emitted. Guards ' +
        'delegate→review in the feature workflow. Both components certify event-sourced ' +
        'preconditions: all implementation tasks finished AND the team was disbanded.',
    },

    'validation+pr-requested': {
      id: 'validation+pr-requested',
      category: 'admission-requirement',
      rationale:
        'Composite of validation-passed and pr-requested. Guards hotfix-validate→synthesize ' +
        'in the debug workflow. Requires tests to pass (evidence) AND a PR to be explicitly ' +
        'requested (intent signal) before entering synthesis.',
    },

    'synthesize-retryable+thorough-track': {
      id: 'synthesize-retryable+thorough-track',
      category: 'bounded-loop-rule',
      rationale:
        'Composite of synthesize-retryable and thorough-track-selected. Guards ' +
        'synthesize→debug-implement in the debug workflow. The primary constraint is the ' +
        'synthesize-retryable loop cap; thorough-track-selected disambiguates from the ' +
        'hotfix-track variant on the same source phase.',
    },

    'synthesize-retryable+hotfix-track': {
      id: 'synthesize-retryable+hotfix-track',
      category: 'bounded-loop-rule',
      rationale:
        'Composite of synthesize-retryable and hotfix-track-selected. Guards ' +
        'synthesize→hotfix-implement in the debug workflow. The primary constraint is the ' +
        'synthesize-retryable loop cap; hotfix-track-selected disambiguates from the ' +
        'thorough-track variant on the same source phase.',
    },
  });

// ─── Convenience Accessors ───────────────────────────────────────────────────

/** All guard IDs that are classified as obsolete predicates. */
export const OBSOLETE_GUARD_IDS: ReadonlySet<string> = new Set(
  Object.values(GUARD_CLASSIFICATIONS)
    .filter((e) => e.category === 'obsolete-predicate')
    .map((e) => e.id),
);

/** All guard IDs that are classified as bounded-loop rules. */
export const BOUNDED_LOOP_GUARD_IDS: ReadonlySet<string> = new Set(
  Object.values(GUARD_CLASSIFICATIONS)
    .filter((e) => e.category === 'bounded-loop-rule')
    .map((e) => e.id),
);

/** Guard IDs flagged for remediation with their defect notes. */
export const GUARDS_FLAGGED_FOR_REMEDIATION: ReadonlyArray<GuardClassificationEntry> =
  Object.freeze(
    Object.values(GUARD_CLASSIFICATIONS).filter((e) => e.flaggedForRemediation === true),
  );

/** Total number of classified guards. */
export const CLASSIFIED_GUARD_COUNT = Object.keys(GUARD_CLASSIFICATIONS).length;
