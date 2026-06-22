import { describe, it, expect } from 'vitest';
import { computeNextActions } from './next-actions-computer.js';
import { NextAction } from './next-action.js';
import { getHSMDefinition, executeTransition, getInitialPhase } from './workflow/state-machine.js';
import { findActionInRegistry } from './registry.js';

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
  });
});
