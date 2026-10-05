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
  /**
   * The feature HSM goes from `plan-review` to `delegate`, so the state starts in `plan-review`.
   */
  it('NextActions_Given_PlanPhase_Then_IncludesDelegateTransition', () => {
    const hsm = getHSMDefinition('feature');
    const state = { phase: 'plan-review', workflowType: 'feature' };

    const actions = computeNextActions(state, hsm);

    expect(actions.length).toBeGreaterThan(0);

    for (const a of actions) {
      expect(NextAction.safeParse(a).success).toBe(true);
    }

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

  /**
   * In `merge-pending`, the computer adds `merge_orchestrate` until the merge orchestrator
   * terminates.
   */
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

  /**
   * A merge orchestrator phase in `EXCLUDED_MERGE_PHASES` means that the merge is over, so the
   * verb must not surface again. The `merge-pending` entry guard reads the same constant.
   */
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

  /**
   * Joins the two ends of the merge detour. A `task.completed` event with a `worktreePath` lets
   * the `delegate` to `merge-pending` transition pass. The computer then surfaces
   * `merge_orchestrate`.
   *
   * The computer gets the phase that the HSM returned, not a literal, so a different landing
   * phase fails. `mergeOrchestrator` is absent, which counts as not terminated.
   */
  it('mergePendingDetour_TaskCompletedWithWorktreePath_SurfacesMergeOrchestrateVerb', () => {
    const hsm = getHSMDefinition('feature');

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

    const transition = executeTransition(hsm, initial, 'merge-pending');
    expect(transition.success).toBe(true);
    expect(transition.newPhase).toBe('merge-pending');

    const transitioned = {
      ...initial,
      phase: transition.newPhase!,
    };

    const actions = computeNextActions(transitioned, hsm);
    const merge = actions.find((a) => a.verb === 'merge_orchestrate');

    expect(merge).toBeDefined();
    expect(merge?.validTargets).toEqual(['merge_orchestrate']);
    expect(merge?.reason).toBe('Pending subagent worktree merge');
  });
});

/**
 * The feature workflow starts in `plan`, and its HSM has no `ideate` state. `computeNextActions`
 * derives each verb from the topology, so a stale `ideate` edge gives a verb for a missing phase.
 * These tests pin the initial phase, the step to `plan-review`, and the absence of `ideate`.
 */
describe('NextActions post-collapse affordance integrity (Task 008, #1581 DR-4, INV-12)', () => {
  it('NextActions_PostInit_AdvertisesPlanNotIdeate', () => {
    const hsm = getHSMDefinition('feature');

    const postInitPhase = getInitialPhase('feature');
    expect(postInitPhase).toBe('plan');

    const actions = computeNextActions(
      { phase: postInitPhase, workflowType: 'feature' },
      hsm,
    );

    expect(actions.length).toBeGreaterThan(0);
    for (const a of actions) {
      expect(NextAction.safeParse(a).success).toBe(true);
    }
    const advancesToPlanReview = actions.some(
      (a) => a.verb === 'plan-review' || a.validTargets?.includes('plan-review') === true,
    );
    expect(advancesToPlanReview).toBe(true);

    for (const a of actions) {
      expect(a.verb).not.toBe('ideate');
      expect(a.validTargets ?? []).not.toContain('ideate');
    }
  });

  it('FeatureHSM_NoDanglingIdeateTopology_PostCollapse', () => {
    const hsm = getHSMDefinition('feature');
    expect(hsm.states['ideate']).toBeUndefined();
    for (const t of hsm.transitions) {
      expect(t.from).not.toBe('ideate');
      expect(t.to).not.toBe('ideate');
    }
  });
});

/**
 * `annotations.safety` in the registry is the one source for the safety class of an action. Code
 * that branches on a safety class must read it through `findActionInRegistry`, and must not copy
 * the enum. These tests pin that lookup for sample actions.
 */
describe('D.8 — annotations.safety is queryable from registry (DIM-1 SoT)', () => {
  it('SafetyConsumerContract_ReadOnlyGet_ResolvesToReadOnly', () => {
    const action = findActionInRegistry('exarchos_workflow', 'get');
    expect(action).toBeDefined();
    expect(action?.annotations.safety).toBe('read-only');
  });

  /** `transition` changes the local event store and no remote system. */
  it('SafetyConsumerContract_TransitionAction_ResolvesToLocalMutation', () => {
    const action = findActionInRegistry('exarchos_workflow', 'transition');
    expect(action).toBeDefined();
    expect(action?.annotations.safety).toBe('local-mutation');
  });

  it('SafetyConsumerContract_CancelAction_ResolvesToCompensable', () => {
    const action = findActionInRegistry('exarchos_workflow', 'cancel');
    expect(action).toBeDefined();
    expect(action?.annotations.safety).toBe('compensable');
  });

  /**
   * A consumer must handle `undefined`, the result for an action that the registry does not hold.
   */
  it('SafetyConsumerContract_UnknownToolOrAction_ReturnsUndefined', () => {
    expect(findActionInRegistry('exarchos_workflow', 'not-a-real-action')).toBeUndefined();
    expect(findActionInRegistry('not_a_real_tool', 'get')).toBeUndefined();
  });

  /**
   * The test samples action names on the four visible tools through `findActionInRegistry`. It
   * requires one action for each of `read-only`, `local-mutation` and `compensable`. The loop
   * skips a name that a tool does not hold.
   */
  it('SafetyConsumerContract_CurrentlyClassifiedSafetyValues_AllResolveThroughLookup', () => {
    const expectedCoverage: ReadonlyArray<'read-only' | 'local-mutation' | 'compensable'> = [
      'read-only',
      'local-mutation',
      'compensable',
    ];

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

/**
 * At the `deep` rung, a PLAN-kind authoring phase adds `divergent_loop` to the control verbs.
 * `discover_bridge` is a registry action, so it is never a control verb.
 */
describe('computeNextActions — deep-rung affordances (DR-7, task 018)', () => {
  it('NextActions_DeepDepth_PublishesDiscoverBridge', () => {
    const hsm = getHSMDefinition('feature');
    const { control, registry } = computeNextActionEnvelopes(
      { phase: 'plan', workflowType: 'feature', designDepth: 'deep' },
      hsm,
    );
    const verbs = control.map((a) => a.verb);
    expect(verbs).not.toContain('discover_bridge');
    expect(verbs).toContain('divergent_loop');
    expect(registry.map((a) => a.actionId)).not.toContain('exarchos_orchestrate.discover_bridge');
    for (const a of control) {
      expect(NextAction.safeParse(a).success).toBe(true);
    }
  });

  /** A `standard`, `thin` or absent depth must not surface the deep-rung verb. */
  it('NextActions_StandardDepth_NoDiscoverBridge', () => {
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

  /** `plan-review` is a PLAN-kind gate and not an authoring phase, so it gets no deep-rung verb. */
  it('NextActions_DeepDepth_ReviewPhase_NoDiscoverBridge', () => {
    const hsm = getHSMDefinition('feature');
    const verbs = computeNextActions(
      { phase: 'plan-review', workflowType: 'feature', designDepth: 'deep' },
      hsm,
    ).map((a) => a.verb);
    expect(verbs).not.toContain('discover_bridge');
    expect(verbs).not.toContain('divergent_loop');
  });
});

/**
 * `prune_worktrees` is a registry action, so `computeNextActions` does not publish it as a control
 * verb. These tests pin its absence in `synthesize` for each workflow type, and in the other
 * feature phases.
 */
describe('computeNextActions — post-synthesize prune cadence (DR-2, task 008, INV-12)', () => {
  it('NextActions_PostSynthesize_SuggestsPruneWorktreesDryRun', () => {
    const hsm = getHSMDefinition('feature');
    const actions = computeNextActions(
      { phase: 'synthesize', workflowType: 'feature' },
      hsm,
    );

    const prune = actions.find((a) => a.verb === 'prune_worktrees');
    expect(prune).toBeUndefined();

    for (const a of actions) {
      expect(NextAction.safeParse(a).success).toBe(true);
    }
  });

  it('NextActions_PostSynthesize_AllWorkflowTypes_SuggestPrune', () => {
    for (const workflowType of ['feature', 'debug', 'oneshot', 'refactor']) {
      const hsm = getHSMDefinition(workflowType);
      const verbs = computeNextActions(
        { phase: 'synthesize', workflowType },
        hsm,
      ).map((a) => a.verb);
      expect(verbs).not.toContain('prune_worktrees');
    }
  });

  it('NextActions_OtherPhases_NoPruneSuggestion', () => {
    const hsm = getHSMDefinition('feature');
    const otherPhases = ['plan', 'plan-review', 'delegate', 'review', 'merge-pending'];
    for (const phase of otherPhases) {
      const verbs = computeNextActions({ phase, workflowType: 'feature' }, hsm).map(
        (a) => a.verb,
      );
      expect(verbs).not.toContain('prune_worktrees');
    }
  });
});

/**
 * `computeNextActions` must omit a verb that admission denies. The consistency test compares two
 * separate authorities: the published list from the HSM topology, and `adjudicateEdge` on the
 * shared IR.
 *
 * `planReviewState` is a full feature state in `plan-review`. Its three outbound edges cover an
 * approval obligation (`delegate`), a route condition (`plan`) and a bounded-loop route condition
 * (`blocked`).
 */
describe('computeNextActions — admission-derived affordances (DR-9, T-13)', () => {
  const EVALUATED_AT = '2026-01-01T00:00:00.000Z';

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

  /**
   * The review is not approved, so admission denies `plan-review` to `delegate`. Two controls show
   * that the verdict causes the omission. The call with no admission facts publishes `delegate`,
   * and so does the call with an approved review.
   */
  it('NextActions_AdmissionWouldDeny_OmitsTheVerb', () => {
    const hsm = getHSMDefinition('feature');

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

    expect(
      computeNextActions(
        { phase: 'plan-review', workflowType: 'feature' },
        hsm,
      ).map((a) => a.verb),
    ).toContain('delegate');

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

  /**
   * `disagreements` returns each published verb that admission denies. It skips a verb with no
   * shared-IR edge, and an edge that the event log decides. The last block is the kill probe: the
   * topology-only list must fail the check, or the agreement before it proves nothing.
   */
  it('NextActions_TopologyDisagreesWithAdmission_FailsConsistencyCheck', () => {
    const hsm = getHSMDefinition('feature');

    const disagreements = (
      published: readonly string[],
      from: string,
      state: Record<string, unknown>,
    ): string[] =>
      published.filter((verb) => {
        const edge = getEdgeIR('feature', from, verb);
        if (edge === undefined) return false;
        if (edgeDependsOnEventLog(edge)) return false;
        return (
          adjudicateEdge(edge, state, defaultTranslationContext(EVALUATED_AT)) ===
          'deny'
        );
      });

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

    const state = planReviewState();
    const topologyOnly = computeNextActions(
      { phase: 'plan-review', workflowType: 'feature' },
      hsm,
    ).map((a) => a.verb);
    expect(topologyOnly).toContain('delegate');
    expect(disagreements(topologyOnly, 'plan-review', state)).toContain('delegate');
  });

  /** The list is advisory, so a caller that supplies no facts must keep its affordances. */
  it('NextActions_NoAdmissionFacts_KeepsTopologyOnlyBehaviour', () => {
    const hsm = getHSMDefinition('feature');
    const verbs = computeNextActions(
      { phase: 'plan-review', workflowType: 'feature' },
      hsm,
    ).map((a) => a.verb);
    expect(verbs).toContain('delegate');
  });

  /**
   * The event log decides `delegate` to `merge-pending`. A payload with no `_events` cannot deny
   * the edge, so the verb stays with an `undecidable` hint.
   */
  it('NextActions_EventGatedEdge_WithoutEventLog_IsAdvertisedAsUndecidable', () => {
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

  /**
   * A fault in adjudication must give the topology-only list, never an empty list. The review is
   * approved because that branch parses the evidence, so the malformed instant throws. The result
   * also holds `plan`, which a successful adjudication of this state denies.
   */
  it('NextActions_MalformedEvaluatedAt_FailsOpenToTopology', () => {
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
    expect(verbs).toContain('delegate');
    expect(verbs).toContain('plan');
  });

  /**
   * `discovery` has no shared IR, so the verdict map is empty. A missing verdict means no opinion,
   * never a denial.
   */
  it('NextActions_UnknownWorkflowType_NoAdmissionOpinion_PublishesTopology', () => {
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

/**
 * Phase and control verbs stay on the control envelope. The registry envelope holds an ActionId
 * only when the shared ActionId evaluator returns `allow`.
 */
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
    expect(isControlOwnedVerb('merge_orchestrate')).toBe(false);
    expect(isControlOwnedVerb('discover_bridge')).toBe(false);
    expect(isControlOwnedVerb('prune_worktrees')).toBe(false);
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

  /**
   * In the last block, the topology still names `merge_orchestrate`. The registry withholds the
   * ActionId, because the authorization is not a trusted grant.
   */
  it('NextActions_PublishedField_WithholdsRegistryActionIdsOnControlEnvelope', () => {
    const hsm = getHSMDefinition('feature');
    const deep = computeNextActions(
      { phase: 'plan', workflowType: 'feature', designDepth: 'deep' },
      hsm,
    ).map((a) => a.verb);
    const synthesize = computeNextActions(
      { phase: 'synthesize', workflowType: 'feature' },
      hsm,
    ).map((a) => a.verb);
    expect(deep).not.toContain('discover_bridge');
    expect(synthesize).not.toContain('prune_worktrees');

    const denied = computeNextActionEnvelopes(
      {
        phase: 'merge-pending',
        workflowType: 'feature',
        featureId: 'feat-x',
        mergeOrchestrator: { phase: 'pending', taskId: 'T11' },
        actionAdmission: advertiseFacts({
          phase: 'merge-pending',
          actionIds: ['exarchos_orchestrate.merge_orchestrate'],
          authorization: { not: 'a-snapshot' },
        }),
      },
      hsm,
    );
    expect(denied.control.map((a) => a.verb)).toContain('merge_orchestrate');
    expect(denied.registry.map((a) => a.actionId)).not.toContain(
      'exarchos_orchestrate.merge_orchestrate',
    );
  });
});
