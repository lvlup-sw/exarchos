import { describe, it, expect } from 'vitest';
import {
  computeNextActionEnvelopes,
  computeNextActions,
  computeRegistryAdvertisements,
} from '../../src/next-actions-computer.js';
import {
  isControlOwnedVerb,
  isRegistryAdvertisement,
  NextAction,
} from '../../src/next-action.js';
import { getHSMDefinition, executeTransition, getInitialPhase } from '../../src/workflow/state-machine.js';
import { findActionInRegistry } from '../../src/registry.js';
import { getEdgeIR } from '../../src/workflow/admission/built-in-workflow-ir.js';
import {
  adjudicateEdge,
  defaultTranslationContext,
  edgeDependsOnEventLog,
} from '../../src/workflow/admission/legacy-state-translation.js';

describe('computeNextActions (T040, DR-8)', () => {
  it('NextActions_Given_PlanPhase_Then_IncludesDelegateTransition', () => {
    // The feature HSM goes plan-review → delegate, which is the canonical
    // "plan → delegate" transition in the feature workflow topology.
    const hsm = getHSMDefinition('feature');
    const state = { phase: 'plan-review', workflowType: 'feature' };

    const actions = computeNextActions(state, hsm);

    expect(actions.length).toBeGreaterThan(0);

    // Every element validates against the NextAction Zod schema.
    for (const a of actions) {
      expect(NextAction.safeParse(a).success).toBe(true);
    }

    // At least one action corresponds to the plan-review → delegate transition.
    const hasDelegate = actions.some(
      (a) =>
        a.verb === 'delegate' ||
        a.validTargets?.includes('delegate') === true,
    );
    expect(hasDelegate).toBe(true);
  });

  it('NextActions_UnknownPhase_ReturnsEmpty', () => {
    const hsm = getHSMDefinition('feature');
    const state = { phase: 'not-a-real-phase', workflowType: 'feature' };

    const actions = computeNextActions(state, hsm);

    expect(actions).toEqual([]);
  });

  it('NextActions_MissingPhase_ReturnsEmpty', () => {
    const hsm = getHSMDefinition('feature');
    const state = { workflowType: 'feature' };

    const actions = computeNextActions(state, hsm);

    expect(actions).toEqual([]);
  });

  // T18 (DR-MO-1): when the workflow is parked in `merge-pending` and the
  // merge orchestrator hasn't already terminated, surface a `merge_orchestrate`
  // action verb so callers can auto-trigger the subagent worktree merge.
  it('computeNextActions_MergePendingPhase_ReturnsMergeOrchestrate', () => {
    const hsm = getHSMDefinition('feature');
    const state = {
      phase: 'merge-pending',
      workflowType: 'feature',
      mergeOrchestrator: { phase: 'pending', taskId: 'T11' },
      featureId: 'feat-x',
    };

    const actions = computeNextActions(state, hsm);

    const merge = actions.find((a) => a.verb === 'merge_orchestrate');
    expect(merge).toBeDefined();
    expect(merge?.validTargets).toEqual(['merge_orchestrate']);
    expect(merge?.reason).toBe('Pending subagent worktree merge');
  });

  it('computeNextActions_MergeOrchestratorPending_IncludesIdempotencyKey', () => {
    const hsm = getHSMDefinition('feature');
    const state = {
      phase: 'merge-pending',
      workflowType: 'feature',
      mergeOrchestrator: { phase: 'pending', taskId: 'T11' },
      featureId: 'feat-x',
    };

    const actions = computeNextActions(state, hsm);

    const merge = actions.find((a) => a.verb === 'merge_orchestrate');
    expect(merge?.idempotencyKey).toBe('feat-x:merge_orchestrate:T11');
  });

  // T19 (DR-MO-1): when the merge orchestrator has already terminated
  // (phase ∈ EXCLUDED_MERGE_PHASES = { 'completed', 'rolled-back', 'aborted' }),
  // the `merge_orchestrate` next-action MUST be omitted so callers cannot
  // re-trigger a merge that has already resolved. The omission filter shares
  // the EXCLUDED_MERGE_PHASES constant with the HSM `merge-pending` entry
  // predicate (T17) — they MUST stay in lockstep.
  it('computeNextActions_MergeOrchestratorCompleted_OmitsMergeOrchestrate', () => {
    const hsm = getHSMDefinition('feature');
    const state = {
      phase: 'merge-pending',
      workflowType: 'feature',
      mergeOrchestrator: { phase: 'completed', taskId: 'T11' },
      featureId: 'feat-x',
    };

    const actions = computeNextActions(state, hsm);

    const merge = actions.find((a) => a.verb === 'merge_orchestrate');
    expect(merge).toBeUndefined();
  });

  it('computeNextActions_MergeOrchestratorRolledBack_OmitsMergeOrchestrate', () => {
    const hsm = getHSMDefinition('feature');
    const state = {
      phase: 'merge-pending',
      workflowType: 'feature',
      mergeOrchestrator: { phase: 'rolled-back', taskId: 'T11' },
      featureId: 'feat-x',
    };

    const actions = computeNextActions(state, hsm);

    const merge = actions.find((a) => a.verb === 'merge_orchestrate');
    expect(merge).toBeUndefined();
  });

  it('computeNextActions_MergeOrchestratorAborted_OmitsMergeOrchestrate', () => {
    const hsm = getHSMDefinition('feature');
    const state = {
      phase: 'merge-pending',
      workflowType: 'feature',
      mergeOrchestrator: { phase: 'aborted', taskId: 'T11' },
      featureId: 'feat-x',
    };

    const actions = computeNextActions(state, hsm);

    const merge = actions.find((a) => a.verb === 'merge_orchestrate');
    expect(merge).toBeUndefined();
  });

  // fix-001 (review #1213, T-01): verifies #1208's fix at HEAD.
  //
  // Scenario from the dogfood report: a workflow parked in `delegate` emits
  // `task.completed` with `data.worktreePath`. PR #1193 wired the
  // `delegate → merge-pending` transition (guarded by the
  // `merge-pending-entry` predicate that inspects the latest task.completed
  // for a worktree association) and the `merge_orchestrate` next-action
  // verb. This test stitches both ends together: starting from the
  // `delegate` phase, the HSM transition succeeds and `computeNextActions`
  // surfaces the `merge_orchestrate` verb. If either end regresses (the
  // guard stops recognizing `worktreePath`, or the next-action computer
  // stops surfacing `merge_orchestrate` in `merge-pending`), this test
  // fails — closing the original #1208 reproduction.
  it('mergePendingDetour_TaskCompletedWithWorktreePath_SurfacesMergeOrchestrateVerb', () => {
    const hsm = getHSMDefinition('feature');

    // Workflow parked in `delegate` with a recently-completed task that
    // carries a worktree path. Mirror the event-store stub used elsewhere
    // in this suite (`state._events` is the canonical shape for HSM guards).
    const initial = {
      phase: 'delegate',
      workflowType: 'feature',
      featureId: 'feat-x',
      _events: [
        {
          type: 'task.completed',
          data: { taskId: 'T11', worktreePath: '/tmp/.worktrees/feat-x-T11' },
        },
      ],
    };

    // Drive the HSM transition the same way prepare_synthesis / merge
    // orchestration would: this is the "detour" that #1208 originally
    // reported as missing. Should succeed at HEAD.
    const transition = executeTransition(hsm, initial, 'merge-pending');
    expect(transition.success).toBe(true);
    expect(transition.newPhase).toBe('merge-pending');

    // CodeRabbit #16 (#1213): drive computeNextActions with the phase the
    // HSM actually emitted instead of a manually-rebuilt literal. If
    // executeTransition is ever modified to land on a different phase,
    // this test will fail loudly instead of silently passing on a
    // hardcoded 'merge-pending'.
    const transitioned = {
      ...initial,
      phase: transition.newPhase!,
      // mergeOrchestrator is set by handleMergeOrchestrate; absent at this
      // step, which the surfacing filter treats as "not yet terminated".
    };

    const actions = computeNextActions(transitioned, hsm);
    const merge = actions.find((a) => a.verb === 'merge_orchestrate');

    // PASS = #1208 fixed-in-#1193 confirmed at HEAD. FAIL would surface a
    // residual regression in either the HSM detour or the next-action
    // surfacing.
    expect(merge).toBeDefined();
    expect(merge?.validTargets).toEqual(['merge_orchestrate']);
    expect(merge?.reason).toBe('Pending subagent worktree merge');
  });
});

// ─── Task 008 (#1581 DR-4): post-collapse affordance integrity (INV-12) ──────
//
// DR-4 (commit 3ff69818) removed the `ideate` (GATHER) state and made `plan`
// the feature workflow's INITIAL phase. `computeNextActions` is purely
// HSM-topology driven, so no surgery was needed in the computer itself — but
// that is exactly why a regression here would be silent. These tests PIN the
// post-collapse affordance contract end-to-end:
//   1. post-init the workflow sits in `plan` (not the removed `ideate`),
//   2. the surfaced affordance advances the plan flow to `plan-review`,
//   3. NO affordance verb/target is `ideate`, and
//   4. the feature HSM carries no dangling `ideate` state or `ideate→plan`
//      edge (the transition that referenced the now-retired
//      `designArtifactExists` guard).
// Together these close INV-12 (affordance integrity): a caller can never be
// handed a next-action pointing at a phase that no longer exists.
describe('NextActions post-collapse affordance integrity (Task 008, #1581 DR-4, INV-12)', () => {
  it('NextActions_PostInit_AdvertisesPlanNotIdeate', () => {
    const hsm = getHSMDefinition('feature');

    // Post-init phase is the feature workflow's initial state: `plan`, not the
    // removed `ideate`/GATHER state.
    const postInitPhase = getInitialPhase('feature');
    expect(postInitPhase).toBe('plan');

    const actions = computeNextActions(
      { phase: postInitPhase, workflowType: 'feature' },
      hsm,
    );

    // Every affordance validates against the schema and the forward step is
    // surfaced: PLAN advances to the single approval point, `plan-review`.
    expect(actions.length).toBeGreaterThan(0);
    for (const a of actions) {
      expect(NextAction.safeParse(a).success).toBe(true);
    }
    const advancesToPlanReview = actions.some(
      (a) => a.verb === 'plan-review' || a.validTargets?.includes('plan-review') === true,
    );
    expect(advancesToPlanReview).toBe(true);

    // No dangling `ideate` affordance — neither as a verb nor a valid target.
    for (const a of actions) {
      expect(a.verb).not.toBe('ideate');
      expect(a.validTargets ?? []).not.toContain('ideate');
    }
  });

  it('FeatureHSM_NoDanglingIdeateTopology_PostCollapse', () => {
    const hsm = getHSMDefinition('feature');
    // The removed GATHER state is gone…
    expect(hsm.states['ideate']).toBeUndefined();
    // …and no transition still references it (the `ideate→plan` edge that
    // carried the retired `designArtifactExists` guard).
    for (const t of hsm.transitions) {
      expect(t.from).not.toBe('ideate');
      expect(t.to).not.toBe('ideate');
    }
  });
});

// ─── Wave 0 / Task D.8 — safety-semantics consumer contract ──────────────
//
// Design §2.4 commits that `annotations.safety` "is consumed by HSM guards
// and by `computeNextActions` — refactored from in-handler prose to a
// single read from this metadata table." Without a consumer, the field
// is declared but unread (DIM-5 hygiene gap).
//
// FINDING (B) at D.8 implementation time: an inspection of
// `next-actions-computer.ts` and `workflow/hsm-transition-guard.ts`
// surfaced no in-handler prose that infers action-safety semantics:
//   - `computeNextActions` is purely HSM-topology driven (reads
//     `hsm.transitions` and `state.phase`); it does not branch on
//     safety semantics. The lone non-topology surfacing
//     (`merge_orchestrate` for `merge-pending`) keys off the phase
//     name and the `mergeOrchestrator` substate, NOT off a safety
//     classification.
//   - `hsm-transition-guard.ts` consults the per-transition `guard`
//     attached to the HSM edge (composite / registered / custom
//     guard), NOT action.annotations.safety. The two are different
//     abstractions: transition guards gate phase-edges; action
//     safety classifies the per-action side-effect profile.
//
// Grep for the safety enum strings across the handler tree confirmed
// no other consumer: every hit outside `registry.ts` lives in the
// `agents/` posture layer (`'read-only' | 'task-isolated' |
// 'shared-mutating'` — agent sandbox modes, a different enum).
//
// Per the D.8 task spec's "If neither consumer actually has
// safety-inferring prose" branch: the closure of §2.4 becomes a
// forward-looking smoke test that locks in the registry-as-SoT
// contract for future consumers. Any future code path that needs
// to branch on action safety semantics MUST import
// `findActionInRegistry` from `./registry.js` and read
// `action.annotations.safety` — not hand-code the enum or duplicate
// the table.
//
// The tests below assert representative actions across the
// designed safety enum (read-only / local-mutation / compensable /
// remote-mutation) resolve through the registry lookup, so a
// future regression that drops the field or flips a value will
// surface here.
describe('D.8 — annotations.safety is queryable from registry (DIM-1 SoT)', () => {
  it('SafetyConsumerContract_ReadOnlyGet_ResolvesToReadOnly', () => {
    // `exarchos_workflow.get` is the canonical read-only getter.
    const action = findActionInRegistry('exarchos_workflow', 'get');
    expect(action).toBeDefined();
    expect(action?.annotations.safety).toBe('read-only');
  });

  it('SafetyConsumerContract_TransitionAction_ResolvesToLocalMutation', () => {
    // `exarchos_workflow.transition` is the canonical phase-mutation
    // surface. Per design §2.4 / milestone-16 §4.2 it is local-mutation
    // (mutates local event store, not a remote system).
    const action = findActionInRegistry('exarchos_workflow', 'transition');
    expect(action).toBeDefined();
    expect(action?.annotations.safety).toBe('local-mutation');
  });

  it('SafetyConsumerContract_CancelAction_ResolvesToCompensable', () => {
    // `exarchos_workflow.cancel` is the canonical compensable action
    // (emits saga compensation events). A future `computeNextActions`
    // refactor that surfaces a `cancel`/`rollback` verb for
    // compensable transitions would key off this exact lookup.
    const action = findActionInRegistry('exarchos_workflow', 'cancel');
    expect(action).toBeDefined();
    expect(action?.annotations.safety).toBe('compensable');
  });

  it('SafetyConsumerContract_UnknownToolOrAction_ReturnsUndefined', () => {
    // A consumer reading safety MUST handle the undefined case
    // (action not in registry). This pins the contract so consumers
    // can write `findActionInRegistry(...)?.annotations.safety ===
    // 'compensable'` without surprise.
    expect(findActionInRegistry('exarchos_workflow', 'not-a-real-action')).toBeUndefined();
    expect(findActionInRegistry('not_a_real_tool', 'get')).toBeUndefined();
  });

  it('SafetyConsumerContract_CurrentlyClassifiedSafetyValues_AllResolveThroughLookup', () => {
    // Three safety classes from design §2.4 currently have representatives
    // in the registered actions: read-only, local-mutation, compensable.
    // (`remote-mutation` is declared in the type union and has a preset
    // defined in registry.ts but no action uses it yet — that's a Phase E
    // classification follow-up, not a D.8 concern. When/if an action
    // adopts it, callers will discover it through this same lookup.)
    //
    // The goal of this test is to lock in the round-trip: for every
    // currently-classified safety value, at least one canonical action
    // resolves through `findActionInRegistry` and exposes it. A regression
    // that dropped `annotations` from a tool's actions OR flipped a value
    // away from these three classes would surface here.
    const expectedCoverage: ReadonlyArray<'read-only' | 'local-mutation' | 'compensable'> = [
      'read-only',
      'local-mutation',
      'compensable',
    ];

    // We don't import getFullRegistry here — findActionInRegistry is
    // the public lookup surface this contract anchors on. Walk the
    // canonical four visible composite tools and sample a representative
    // set of action names per tool. The sample is intentionally broad so
    // future actions named the same way auto-participate.
    const toolNames = ['exarchos_workflow', 'exarchos_event', 'exarchos_orchestrate', 'exarchos_view'] as const;
    const sampleActions = [
      'get', 'init', 'set', 'update', 'transition', 'cancel', 'cleanup',
      'reconcile', 'rehydrate', 'checkpoint', 'describe',
      'append', 'query',
      'delegate', 'verify-merge', 'rollback', 'cancel-tasks', 'merge-task',
    ] as const;

    const observed = new Set<string>();
    for (const toolName of toolNames) {
      for (const actionName of sampleActions) {
        const action = findActionInRegistry(toolName, actionName);
        if (action) {
          observed.add(action.annotations.safety);
        }
      }
    }

    for (const safety of expectedCoverage) {
      expect(
        observed.has(safety),
        `safety='${safety}' has no representative action reachable through findActionInRegistry — registry-as-SoT contract broken`,
      ).toBe(true);
    }
  });
});

// ─── DR-7 (#1581 task 018): deep-rung discover-bridge affordances ────────────
describe('computeNextActions — deep-rung affordances (DR-7, task 018)', () => {
  it('NextActions_DeepDepth_PublishesDiscoverBridge', () => {
    // At the `deep` planning rung, PLAN authoring surfaces the opt-in
    // divergent-loop + discover-bridge affordances on next_actions (INV-12).
    const hsm = getHSMDefinition('feature');
    const actions = computeNextActions(
      { phase: 'plan', workflowType: 'feature', designDepth: 'deep' },
      hsm,
    );
    const verbs = actions.map((a) => a.verb);
    expect(verbs).toContain('discover_bridge');
    expect(verbs).toContain('divergent_loop');
    for (const a of actions) {
      expect(NextAction.safeParse(a).success).toBe(true);
    }
  });

  it('NextActions_StandardDepth_NoDiscoverBridge', () => {
    // standard/thin/absent depth must NOT surface the deep-rung escalation —
    // cost stays risk-proportional.
    const hsm = getHSMDefinition('feature');
    for (const designDepth of ['standard', 'thin', undefined]) {
      const verbs = computeNextActions(
        { phase: 'plan', workflowType: 'feature', designDepth },
        hsm,
      ).map((a) => a.verb);
      expect(verbs).not.toContain('discover_bridge');
      expect(verbs).not.toContain('divergent_loop');
    }
  });

  it('NextActions_DeepDepth_ReviewPhase_NoDiscoverBridge', () => {
    // plan-review is a PLAN-kind gate, not an authoring phase — the bridge is an
    // authoring escalation, so it is NOT surfaced there even at deep depth.
    const hsm = getHSMDefinition('feature');
    const verbs = computeNextActions(
      { phase: 'plan-review', workflowType: 'feature', designDepth: 'deep' },
      hsm,
    ).map((a) => a.verb);
    expect(verbs).not.toContain('discover_bridge');
    expect(verbs).not.toContain('divergent_loop');
  });
});

// ─── DR-2 (WLM slice 3, task 008): post-synthesize prune-cadence affordance ───
//
// After a workflow reaches the SYNTHESIZE phase, governed worktrees accumulate
// with no GC cadence surfaced anywhere. `computeNextActions` publishes an
// INV-12 prune-cadence hint suggesting a `prune_worktrees` dry-run — gated on
// the phase's KIND (SYNTHESIZE, INV-6), so it fires for every workflow type's
// synthesis leg and NEVER on the mid-implementation MERGE substate or any
// earlier phase.
describe('computeNextActions — post-synthesize prune cadence (DR-2, task 008, INV-12)', () => {
  it('NextActions_PostSynthesize_SuggestsPruneWorktreesDryRun', () => {
    const hsm = getHSMDefinition('feature');
    const actions = computeNextActions(
      { phase: 'synthesize', workflowType: 'feature' },
      hsm,
    );

    const prune = actions.find((a) => a.verb === 'prune_worktrees');
    expect(prune).toBeDefined();
    expect(prune?.validTargets).toEqual(['prune_worktrees']);
    // The cadence hint MUST steer the caller to a dry-run first (INV-5c).
    expect(prune?.reason.toLowerCase()).toContain('dry-run');
    expect(prune?.hint?.toLowerCase()).toContain('dry-run');

    // Every affordance validates against the NextAction schema (shape drift
    // fails loud rather than shipping a malformed envelope).
    for (const a of actions) {
      expect(NextAction.safeParse(a).success).toBe(true);
    }
  });

  it('NextActions_PostSynthesize_AllWorkflowTypes_SuggestPrune', () => {
    // The affordance is KIND-gated (SYNTHESIZE), so every workflow type whose
    // synthesis leg reuses that kind surfaces it — proving the gate is on kind,
    // not the feature-specific phase name (INV-6).
    for (const workflowType of ['feature', 'debug', 'oneshot', 'refactor']) {
      const hsm = getHSMDefinition(workflowType);
      const verbs = computeNextActions(
        { phase: 'synthesize', workflowType },
        hsm,
      ).map((a) => a.verb);
      expect(verbs).toContain('prune_worktrees');
    }
  });

  it('NextActions_OtherPhases_NoPruneSuggestion', () => {
    const hsm = getHSMDefinition('feature');
    // Non-synthesize phases — including the mid-implementation MERGE substate
    // (`merge-pending`, kind MERGE) — must NOT surface the prune cadence hint.
    const otherPhases = ['plan', 'plan-review', 'delegate', 'review', 'merge-pending'];
    for (const phase of otherPhases) {
      const verbs = computeNextActions({ phase, workflowType: 'feature' }, hsm).map(
        (a) => a.verb,
      );
      expect(verbs).not.toContain('prune_worktrees');
    }
  });
});

// ─── DR-9 (T-13): affordances derive from the ADMISSION verdict (INV-12) ─────
//
// Pre-fix, `computeNextActions` enumerated `hsm.transitions.filter(t => t.from
// === phase)` and emitted one verb per outbound edge using
// `t.guard.description` — it never evaluated a guard nor consulted admission,
// so the runtime advertised moves admission would deny. These tests pin both
// halves of the fix: the denied verb is omitted, and the published set is
// cross-checked against the admission verdict computed INDEPENDENTLY here.
//
// The consistency check compares two genuinely distinct authorities — the
// published affordance list (`computeNextActions`, which walks the HSM
// topology) against the admission verdict (`adjudicateEdge` over the shared
// IR). It is deliberately NOT admission-vs-admission (the Class B shape DR-30
// forbids): if the fix were reverted, the topology would keep publishing verbs
// admission denies and the check would fail.

describe('computeNextActions — admission-derived affordances (DR-9, T-13)', () => {
  const EVALUATED_AT = '2026-01-01T00:00:00.000Z';

  /**
   * A full feature workflow state parked in `plan-review`. The three outbound
   * shared-IR edges from that phase exercise all three obligation shapes:
   *   - `plan-review → delegate` — an APPROVAL obligation on
   *     `planReview.approved`;
   *   - `plan-review → plan`     — a ROUTE condition on `planReview.gapsFound`;
   *   - `plan-review → blocked`  — a bounded-loop ROUTE condition on
   *     `planReview.revisionsExhausted`.
   */
  const planReviewState = (
    over: Record<string, unknown> = {},
  ): Record<string, unknown> => ({
    featureId: 'feat-dr9',
    phase: 'plan-review',
    workflowType: 'feature',
    updatedAt: EVALUATED_AT,
    artifacts: { plan: 'docs/specs/dr9.md' },
    tasks: [],
    reviews: {},
    planReview: { approved: false, gapsFound: false, revisionCount: 0 },
    ...over,
  });

  const admissionFor = (state: Record<string, unknown>) => ({
    state,
    evaluatedAt: EVALUATED_AT,
    eventLogAvailable: false,
  });

  it('NextActions_AdmissionWouldDeny_OmitsTheVerb', () => {
    const hsm = getHSMDefinition('feature');

    // The plan review has NOT been approved, so the approval obligation on
    // `plan-review → delegate` is unsatisfied and admission denies the edge.
    const unapproved = planReviewState();
    expect(
      adjudicateEdge(
        getEdgeIR('feature', 'plan-review', 'delegate')!,
        unapproved,
        defaultTranslationContext(EVALUATED_AT),
      ),
    ).toBe('deny');

    const denied = computeNextActions(
      {
        phase: 'plan-review',
        workflowType: 'feature',
        admission: admissionFor(unapproved),
      },
      hsm,
    ).map((a) => a.verb);
    expect(denied).not.toContain('delegate');

    // The omission is caused by the VERDICT, not by the edge being absent from
    // the topology: the identical call without admission facts still publishes
    // it (that is precisely the pre-DR-9 over-advertisement).
    expect(
      computeNextActions(
        { phase: 'plan-review', workflowType: 'feature' },
        hsm,
      ).map((a) => a.verb),
    ).toContain('delegate');

    // Non-vacuity: the SAME call publishes `delegate` once the approval exists,
    // so the omission is driven by the verdict and not by the verb being
    // unreachable or the affordance list being empty.
    const approved = planReviewState({
      planReview: { approved: true, gapsFound: false, revisionCount: 0 },
    });
    const allowed = computeNextActions(
      {
        phase: 'plan-review',
        workflowType: 'feature',
        admission: admissionFor(approved),
      },
      hsm,
    ).map((a) => a.verb);
    expect(allowed).toContain('delegate');
  });

  it('NextActions_TopologyDisagreesWithAdmission_FailsConsistencyCheck', () => {
    const hsm = getHSMDefinition('feature');

    /**
     * The consistency check: every PUBLISHED verb that names a shared-IR edge
     * must not be one admission denies. Returns the disagreeing verbs.
     */
    const disagreements = (
      published: readonly string[],
      from: string,
      state: Record<string, unknown>,
    ): string[] =>
      published.filter((verb) => {
        const edge = getEdgeIR('feature', from, verb);
        if (edge === undefined) return false; // no admission opinion
        if (edgeDependsOnEventLog(edge)) return false; // facts not supplied
        return (
          adjudicateEdge(edge, state, defaultTranslationContext(EVALUATED_AT)) ===
          'deny'
        );
      });

    // Across every plan-review fact combination the two authorities agree.
    for (const planReview of [
      { approved: false, gapsFound: false, revisionCount: 0 },
      { approved: true, gapsFound: false, revisionCount: 0 },
      { approved: false, gapsFound: true, revisionCount: 0 },
      { approved: false, gapsFound: false, revisionCount: 99 },
    ]) {
      const state = planReviewState({ planReview });
      const published = computeNextActions(
        {
          phase: 'plan-review',
          workflowType: 'feature',
          admission: admissionFor(state),
        },
        hsm,
      ).map((a) => a.verb);
      expect(disagreements(published, 'plan-review', state)).toEqual([]);
    }

    // KILL PROBE — the pre-DR-9 behaviour was exactly "publish every outbound
    // edge regardless of the verdict". Feeding the check that topology-only set
    // must make it FAIL, or the consistency assertion above proves nothing.
    const state = planReviewState();
    const topologyOnly = computeNextActions(
      { phase: 'plan-review', workflowType: 'feature' },
      hsm,
    ).map((a) => a.verb);
    expect(topologyOnly).toContain('delegate');
    expect(disagreements(topologyOnly, 'plan-review', state)).toContain('delegate');
  });

  it('NextActions_NoAdmissionFacts_KeepsTopologyOnlyBehaviour', () => {
    // A caller that supplies no facts must not have its affordances emptied —
    // an affordance list is advisory, and under-advertising on a payload that
    // never carried the evidence would strand the caller.
    const hsm = getHSMDefinition('feature');
    const verbs = computeNextActions(
      { phase: 'plan-review', workflowType: 'feature' },
      hsm,
    ).map((a) => a.verb);
    expect(verbs).toContain('delegate');
  });

  it('NextActions_EventGatedEdge_WithoutEventLog_IsAdvertisedAsUndecidable', () => {
    // `delegate → merge-pending` is decided from the event log. A payload
    // without `_events` cannot deny it — the verb stays published, flagged.
    const hsm = getHSMDefinition('feature');
    const edge = getEdgeIR('feature', 'delegate', 'merge-pending');
    expect(edge).toBeDefined();
    expect(edgeDependsOnEventLog(edge!)).toBe(true);

    const state = {
      featureId: 'feat-dr9',
      phase: 'delegate',
      workflowType: 'feature',
      updatedAt: EVALUATED_AT,
      artifacts: {},
      tasks: [],
      reviews: {},
    };
    const merge = computeNextActions(
      {
        phase: 'delegate',
        workflowType: 'feature',
        admission: admissionFor(state),
      },
      hsm,
    ).find((a) => a.verb === 'merge-pending');
    expect(merge).toBeDefined();
    expect(merge?.hint).toContain('undecidable');
  });

  it('NextActions_MalformedEvaluatedAt_FailsOpenToTopology', () => {
    // A fault inside adjudication must degrade to "advertise what the topology
    // allows", never to a silently empty affordance list. An APPROVED review is
    // used deliberately: it is the branch that actually mints evidence, so the
    // malformed instant reaches `AdmissionEvidenceV1Schema.parse` and throws.
    const hsm = getHSMDefinition('feature');
    const approved = planReviewState({
      planReview: { approved: true, gapsFound: false, revisionCount: 0 },
    });
    expect(() =>
      adjudicateEdge(
        getEdgeIR('feature', 'plan-review', 'delegate')!,
        approved,
        defaultTranslationContext('not-a-timestamp'),
      ),
    ).toThrow();

    const verbs = computeNextActions(
      {
        phase: 'plan-review',
        workflowType: 'feature',
        admission: {
          state: approved,
          evaluatedAt: 'not-a-timestamp',
          eventLogAvailable: false,
        },
      },
      hsm,
    ).map((a) => a.verb);
    // Topology-only fallback: `plan` and `blocked` are published too, which the
    // successful adjudication above (`_OmitsTheVerb`) denies — proving the
    // fallback really is the un-gated list rather than a lucky subset.
    expect(verbs).toContain('delegate');
    expect(verbs).toContain('plan');
  });

  it('NextActions_UnknownWorkflowType_NoAdmissionOpinion_PublishesTopology', () => {
    // A workflow type with no shared IR yields an empty verdict map. Absence of
    // an edge means "no opinion", which must never be read as deny.
    const hsm = getHSMDefinition('discovery');
    const state = {
      featureId: 'feat-dr9',
      phase: 'gathering',
      workflowType: 'discovery',
      updatedAt: EVALUATED_AT,
      artifacts: { sources: ['a', 'b'] },
      tasks: [],
      reviews: {},
    };
    const verbs = computeNextActions(
      {
        phase: 'gathering',
        workflowType: 'discovery',
        admission: admissionFor(state),
      },
      hsm,
    ).map((a) => a.verb);
    expect(verbs.length).toBeGreaterThan(0);
  });
});

// ─── Registry ActionId advertisements (allow-only, second envelope) ──────────
//
// Phase and control verbs stay on the HSM envelope. Registry ActionIds are
// published only when the shared ActionId evaluator returns allow.

const ADVERTISE_AT = '2026-01-01T00:00:00.000Z';
const GET_ACTION_ID = 'exarchos_workflow.get';
const HOST_OWNED_ACTION_ID = 'exarchos_orchestrate.check_coderabbit';
const GATED_ACTION_ID = 'exarchos_orchestrate.check_polish_scope';
const REQUIRES_ACTION_ID = 'exarchos_orchestrate.pre_synthesis_check';

function advertiseAuth(capabilityIds: readonly string[] = ['fs:read', 'shell:exec']) {
  return {
    authorizationId: 'authorization-advertise-001',
    posture: 'read-only' as const,
    capabilityIds,
    resolverVersion: '1.0',
    resolvedAt: ADVERTISE_AT,
  };
}

function advertiseFacts(over: {
  readonly phase?: string;
  readonly authorization?: unknown;
  readonly evidence?: readonly unknown[];
  readonly actionIds?: readonly string[];
  readonly omitAuthorization?: boolean;
  readonly featureId?: string;
  readonly stream?: string;
} = {}) {
  return {
    subject: {
      featureId: over.featureId ?? 'feat-advertise',
      stream: over.stream ?? over.featureId ?? 'feat-advertise',
    },
    evidence: over.evidence ?? [],
    ...(over.omitAuthorization ? {} : { authorization: over.authorization ?? advertiseAuth() }),
    hsmFacts: { phase: over.phase ?? 'plan' },
    ...(over.actionIds === undefined ? {} : { actionIds: over.actionIds }),
  };
}

describe('computeRegistryAdvertisements — allow-only ActionIds', () => {
  it('NextActions_Denied_IsNotAdvertised', () => {
    const ids = computeRegistryAdvertisements({
      phase: 'synthesize',
      workflowType: 'feature',
      actionAdmission: advertiseFacts({
        phase: 'synthesize',
        actionIds: [REQUIRES_ACTION_ID],
      }),
    }).map((a) => a.actionId);
    expect(ids).not.toContain(REQUIRES_ACTION_ID);
  });

  it('NextActions_Indeterminate_IsNotAdvertised', () => {
    const ids = computeRegistryAdvertisements({
      phase: 'plan',
      workflowType: 'feature',
      actionAdmission: advertiseFacts({
        authorization: { posture: 'read-only' },
        actionIds: [GET_ACTION_ID],
      }),
    }).map((a) => a.actionId);
    expect(ids).not.toContain(GET_ACTION_ID);
  });

  it('NextActions_AdjudicationFault_IsNotAdvertised', () => {
    const faultingAuth = new Proxy(
      {},
      {
        get() {
          throw new Error('admission evaluation fault');
        },
      },
    );
    const ids = computeRegistryAdvertisements({
      phase: 'plan',
      workflowType: 'feature',
      actionAdmission: advertiseFacts({
        authorization: faultingAuth,
        actionIds: [GET_ACTION_ID],
      }),
    }).map((a) => a.actionId);
    expect(ids).not.toContain(GET_ACTION_ID);
  });

  it('NextActions_TopologyFallback_IsNotAdvertised', () => {
    const hsm = getHSMDefinition('feature');
    const { control, registry } = computeNextActionEnvelopes(
      { phase: 'plan-review', workflowType: 'feature' },
      hsm,
    );
    expect(control.map((a) => a.verb)).toContain('delegate');
    expect(registry).toEqual([]);
  });

  it('NextActions_PhaseVerb_IsNotAnActionId', () => {
    const hsm = getHSMDefinition('feature');
    const { control, registry } = computeNextActionEnvelopes(
      {
        phase: 'plan-review',
        workflowType: 'feature',
        actionAdmission: advertiseFacts({
          phase: 'plan-review',
          actionIds: [GET_ACTION_ID],
        }),
      },
      hsm,
    );
    const phaseVerb = control.find((a) => a.verb === 'plan-review' || a.verb === 'delegate');
    expect(phaseVerb).toBeDefined();
    expect(phaseVerb).not.toHaveProperty('actionId');
    expect(isRegistryAdvertisement(phaseVerb)).toBe(false);
    expect(registry.map((a) => a.actionId)).not.toContain('plan-review');
    expect(registry.map((a) => a.actionId)).not.toContain('delegate');
  });

  it('NextActions_RetryWithTask_IsNotAnActionId', () => {
    const parsed = NextAction.parse({
      verb: 'retry_with_task',
      reason: 're-invoke with task TTL',
      ttl_suggestion_ms: 60_000,
    });
    expect(isControlOwnedVerb(parsed.verb)).toBe(true);
    expect(parsed).not.toHaveProperty('actionId');
    expect(isRegistryAdvertisement(parsed)).toBe(false);
    const ids = computeRegistryAdvertisements({
      phase: 'plan',
      workflowType: 'feature',
      actionAdmission: advertiseFacts({ actionIds: [GET_ACTION_ID, 'retry_with_task'] }),
    }).map((a) => a.actionId);
    expect(ids).not.toContain('retry_with_task');
  });

  it('NextActions_DivergentLoop_IsNotAnActionId', () => {
    const hsm = getHSMDefinition('feature');
    const { control, registry } = computeNextActionEnvelopes(
      {
        phase: 'plan',
        workflowType: 'feature',
        designDepth: 'deep',
        actionAdmission: advertiseFacts({ actionIds: [GET_ACTION_ID] }),
      },
      hsm,
    );
    expect(control.map((a) => a.verb)).toContain('divergent_loop');
    expect(isControlOwnedVerb('divergent_loop')).toBe(true);
    expect(registry.map((a) => a.actionId)).not.toContain('divergent_loop');
  });

  it('NextActions_MissingAuth_OmitsCapabilityGatedActionIds', () => {
    const ids = computeRegistryAdvertisements({
      phase: 'plan',
      workflowType: 'feature',
      actionAdmission: advertiseFacts({
        omitAuthorization: true,
        actionIds: [GATED_ACTION_ID, GET_ACTION_ID],
      }),
    }).map((a) => a.actionId);
    expect(ids).not.toContain(GATED_ACTION_ID);
    expect(ids).not.toContain(GET_ACTION_ID);
  });

  it('NextActions_HostOwned_AdvertisedWhenLocalChecksPass', () => {
    const advertised = computeRegistryAdvertisements({
      phase: 'plan',
      workflowType: 'feature',
      actionAdmission: advertiseFacts({ actionIds: [HOST_OWNED_ACTION_ID] }),
    });
    const hostOwned = advertised.find((a) => a.actionId === HOST_OWNED_ACTION_ID);
    expect(hostOwned).toBeDefined();
    expect(hostOwned?.subject).toEqual({
      featureId: 'feat-advertise',
      stream: 'feat-advertise',
    });
  });

  it('NextActions_MergeOrchestrate_RehydrateTopology_StillPublishes', () => {
    const hsm = getHSMDefinition('feature');
    const { control, registry } = computeNextActionEnvelopes(
      {
        phase: 'merge-pending',
        workflowType: 'feature',
        featureId: 'feat-x',
        mergeOrchestrator: { phase: 'pending', taskId: 'T11' },
      },
      hsm,
    );
    expect(control.map((a) => a.verb)).toContain('merge_orchestrate');
    expect(registry).toEqual([]);
    expect(isControlOwnedVerb('merge_orchestrate')).toBe(true);
  });

  it('NextActions_Advertised_UsesWorkflowScopedSubject', () => {
    const advertised = computeRegistryAdvertisements({
      phase: 'plan',
      workflowType: 'feature',
      actionAdmission: advertiseFacts({
        featureId: 'feat-alpha',
        stream: 'stream-alpha',
        actionIds: [GET_ACTION_ID],
      }),
    });
    expect(advertised).toHaveLength(1);
    expect(advertised[0]?.actionId).toBe(GET_ACTION_ID);
    expect(advertised[0]?.subject).toEqual({
      featureId: 'feat-alpha',
      stream: 'stream-alpha',
    });
    expect(advertised[0]).not.toHaveProperty('target');
    expect(advertised[0]).not.toHaveProperty('payload');
    expect(advertised[0]).not.toHaveProperty('now');
  });
});
