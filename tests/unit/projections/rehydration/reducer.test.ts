import { describe, it, expect } from 'vitest';
import { rehydrationReducer } from '../../../../src/projections/rehydration/reducer.js';
import { RehydrationDocumentSchema } from '../../../../src/projections/rehydration/schema.js';
import { EventTypes, type WorkflowEvent } from '../../../../src/events/schemas.js';

/** Builds a minimal `WorkflowEvent` on the `wf-test` stream with a fixed timestamp. */
function makeEvent<T extends Record<string, unknown>>(
  type: string,
  data: T,
  sequence: number,
): WorkflowEvent {
  return {
    streamId: 'wf-test',
    sequence,
    timestamp: '2026-04-24T00:00:00.000Z',
    type,
    schemaVersion: '1.0',
    data,
  } as WorkflowEvent;
}

/** Returns a document for a feature workflow in the `delegate` phase. The detour tests start from it, because only a feature workflow can detour. */
function featureInDelegate(featureId = 'wf-test') {
  let s = rehydrationReducer.apply(
    rehydrationReducer.initial,
    makeEvent('workflow.started', { featureId, workflowType: 'feature' }, 0),
  );
  s = rehydrationReducer.apply(
    s,
    makeEvent('workflow.transition', { from: '', to: 'delegate' }, 1),
  );
  return s;
}

describe('rehydration reducer — initial state (T022, DR-3)', () => {
  /** `phasePlaybook` is `null` in the initial document, because the rehydrate handler composes it at read time. */
  it('Rehydration_NoEvents_ReturnsV3InitialDocument', () => {
    const initial = rehydrationReducer.initial;

    expect(RehydrationDocumentSchema.parse(initial)).toEqual(initial);

    expect(initial.v).toBe(4);
    expect(initial.projectionSequence).toBe(0);

    expect(initial.taskProgress).toEqual([]);
    expect(initial.decisions).toEqual([]);
    expect(initial.artifacts).toEqual({});
    expect(initial.blockers).toEqual([]);
    expect(initial.nextAction).toBeUndefined();

    expect(initial.phasePlaybook).toBeNull();

    expect(typeof initial.workflowState.featureId).toBe('string');
    expect(typeof initial.workflowState.phase).toBe('string');
    expect(typeof initial.workflowState.workflowType).toBe('string');

    expect(initial.recentHandoffs).toEqual([]);
    expect(initial.latestHandoff).toBeUndefined();
  });

  it('Rehydration_ReducerIdentity_IsCanonical', () => {
    expect(rehydrationReducer.id).toBe('rehydration@v1');
    expect(rehydrationReducer.version).toBe(1);
  });

  it('Rehydration_ApplyUnknownEvent_ReturnsStateUnchanged', () => {
    const state = rehydrationReducer.initial;
    const unknownEvent = {
      type: 'unknown.event.type',
      workflowId: 'wf-test',
      sequence: 1,
      timestamp: '2026-04-24T00:00:00.000Z',
      source: 'model',
      data: {},
    } as unknown as Parameters<typeof rehydrationReducer.apply>[1];

    const next = rehydrationReducer.apply(state, unknownEvent);

    expect(next).toBe(state);
  });
});

describe('rehydration reducer — task events fold (T023, DR-3)', () => {
  /** `task.assigned` starts the task, and `task.completed` with the same `taskId` ends it. */
  it('Rehydration_Given_TaskStartedCompleted_When_Fold_Then_ProgressShows1Of1', () => {
    const initial = rehydrationReducer.initial;

    const assigned = makeEvent('task.assigned', { taskId: '001', title: 'T001' }, 1);
    const completed = makeEvent('task.completed', { taskId: '001' }, 2);

    const afterAssigned = rehydrationReducer.apply(initial, assigned);
    const afterCompleted = rehydrationReducer.apply(afterAssigned, completed);

    expect(afterCompleted.taskProgress).toHaveLength(1);
    expect(afterCompleted.taskProgress[0]).toMatchObject({
      id: '001',
      status: 'complete',
    });

    expect(afterCompleted.projectionSequence).toBe(2);

    expect(RehydrationDocumentSchema.safeParse(afterCompleted).success).toBe(true);

    expect(initial.taskProgress).toEqual([]);
    expect(initial.projectionSequence).toBe(0);
  });

  it('Rehydration_Given_TaskFailed_When_Fold_Then_ProgressShowsFailed', () => {
    const initial = rehydrationReducer.initial;
    const assigned = makeEvent('task.assigned', { taskId: '002', title: 'T002' }, 1);
    const afterAssigned = rehydrationReducer.apply(initial, assigned);

    const failed = makeEvent(
      'task.failed',
      { taskId: '002', error: 'baseline failed' },
      2,
    );
    const next = rehydrationReducer.apply(afterAssigned, failed);

    expect(next.taskProgress).toHaveLength(1);
    expect(next.taskProgress[0]).toMatchObject({
      id: '002',
      status: 'failed',
    });
    expect(next.projectionSequence).toBe(2);
  });

  it('Rehydration_Given_DuplicateTaskCompleted_When_Fold_Then_ProgressIdempotent', () => {
    const initial = rehydrationReducer.initial;
    const completed = makeEvent('task.completed', { taskId: '003' }, 1);
    const afterFirst = rehydrationReducer.apply(initial, completed);

    const afterSecond = rehydrationReducer.apply(afterFirst, completed);

    expect(afterSecond.taskProgress).toHaveLength(1);
    expect(afterSecond.taskProgress[0]).toMatchObject({
      id: '003',
      status: 'complete',
    });
  });
});

describe('rehydration reducer — workflow events fold (T024, DR-3)', () => {
  /** `workflow.started` has no phase field, so `phase` stays `''` until a `workflow.transition` event. */
  it('Rehydration_Given_WorkflowStarted_When_Fold_Then_WorkflowStatePopulated', () => {
    const initial = rehydrationReducer.initial;

    const started = makeEvent(
      'workflow.started',
      { featureId: 'feat-42', workflowType: 'axiom' },
      1,
    );

    const next = rehydrationReducer.apply(initial, started);

    expect(next.workflowState.featureId).toBe('feat-42');
    expect(next.workflowState.workflowType).toBe('axiom');
    expect(next.workflowState.phase).toBe('');

    expect(next.projectionSequence).toBe(1);

    expect(RehydrationDocumentSchema.safeParse(next).success).toBe(true);

    expect(initial.workflowState.featureId).toBe('');
    expect(initial.workflowState.workflowType).toBe('');
    expect(initial.projectionSequence).toBe(0);
  });

  it('Rehydration_Given_WorkflowTransition_When_Fold_Then_PhaseAdvances', () => {
    const initial = rehydrationReducer.initial;
    const started = makeEvent(
      'workflow.started',
      { featureId: 'feat-42', workflowType: 'axiom' },
      1,
    );
    const afterStarted = rehydrationReducer.apply(initial, started);

    const transition = makeEvent(
      'workflow.transition',
      {
        from: 'baseline',
        to: 'design',
        trigger: 'designComplete',
        featureId: 'feat-42',
      },
      2,
    );
    const next = rehydrationReducer.apply(afterStarted, transition);

    expect(next.workflowState.phase).toBe('design');
    expect(next.workflowState.featureId).toBe('feat-42');
    expect(next.workflowState.workflowType).toBe('axiom');
    expect(next.projectionSequence).toBe(2);
    expect(RehydrationDocumentSchema.safeParse(next).success).toBe(true);
  });
});

/** `exarchos_workflow set` appends a `state.patched` event. The reducer reads the artifacts from `data.patch.artifacts`. */
describe('rehydration reducer — artifacts fold (T025, DR-3)', () => {
  it('Rehydration_Given_StatePatchedWithArtifacts_When_Fold_Then_ArtifactsPopulated', () => {
    const initial = rehydrationReducer.initial;

    const patched = makeEvent(
      'state.patched',
      {
        featureId: 'feat-42',
        fields: ['artifacts'],
        patch: {
          artifacts: {
            design: 'docs/designs/2026-04-23-rehydrate-foundation.md',
            plan: 'docs/plans/2026-04-23-rehydrate-foundation.md',
          },
        },
      },
      1,
    );

    const next = rehydrationReducer.apply(initial, patched);

    expect(next.artifacts).toMatchObject({
      design: 'docs/designs/2026-04-23-rehydrate-foundation.md',
      plan: 'docs/plans/2026-04-23-rehydrate-foundation.md',
    });
    expect(next.projectionSequence).toBe(1);
    expect(RehydrationDocumentSchema.safeParse(next).success).toBe(true);
    expect(initial.artifacts).toEqual({});
  });

  it('Rehydration_Given_StatePatchedArtifactsTwice_When_Fold_Then_KeysMergedLastWins', () => {
    const initial = rehydrationReducer.initial;
    const first = makeEvent(
      'state.patched',
      {
        featureId: 'feat-42',
        fields: ['artifacts'],
        patch: { artifacts: { design: 'old-design.md' } },
      },
      1,
    );
    const afterFirst = rehydrationReducer.apply(initial, first);

    const second = makeEvent(
      'state.patched',
      {
        featureId: 'feat-42',
        fields: ['artifacts'],
        patch: { artifacts: { design: 'new-design.md', plan: 'plan.md' } },
      },
      2,
    );
    const next = rehydrationReducer.apply(afterFirst, second);

    expect(next.artifacts).toEqual({
      design: 'new-design.md',
      plan: 'plan.md',
    });
    expect(next.projectionSequence).toBe(2);
  });

  it('Rehydration_Given_StatePatchedWithoutArtifacts_When_Fold_Then_Unchanged', () => {
    const initial = rehydrationReducer.initial;
    const patched = makeEvent(
      'state.patched',
      {
        featureId: 'feat-42',
        fields: ['tasks'],
        patch: { tasks: [] },
      },
      1,
    );
    const next = rehydrationReducer.apply(initial, patched);
    expect(next.artifacts).toEqual({});
    expect(next.projectionSequence).toBe(0);
    expect(next).toBe(initial);
  });

  /** A `null` value clears an artifact. `design` is not in the state, so the clear changes nothing and only `plan` is added. */
  it('Rehydration_Given_StatePatchedArtifactsWithNullEntry_When_Fold_Then_OtherKeysFolded', () => {
    const initial = rehydrationReducer.initial;
    const patched = makeEvent(
      'state.patched',
      {
        featureId: 'feat-42',
        fields: ['artifacts'],
        patch: { artifacts: { design: null, plan: 'plan.md' } },
      },
      1,
    );
    const next = rehydrationReducer.apply(initial, patched);
    expect(next.artifacts).toEqual({ plan: 'plan.md' });
    expect(RehydrationDocumentSchema.safeParse(next).success).toBe(true);
  });

  /** The fold removes a key that a later patch sets to `null`. Otherwise the rehydration document keeps the stale path. */
  it('Rehydration_Given_StatePatchedArtifactsNullForExistingKey_When_Fold_Then_KeyDeleted', () => {
    const initial = rehydrationReducer.initial;
    const seeded = rehydrationReducer.apply(
      initial,
      makeEvent(
        'state.patched',
        {
          featureId: 'feat-99',
          fields: ['artifacts'],
          patch: { artifacts: { design: 'design.md', plan: 'plan.md' } },
        },
        1,
      ),
    );
    expect(seeded.artifacts).toEqual({
      design: 'design.md',
      plan: 'plan.md',
    });

    const cleared = rehydrationReducer.apply(
      seeded,
      makeEvent(
        'state.patched',
        {
          featureId: 'feat-99',
          fields: ['artifacts'],
          patch: { artifacts: { design: null } },
        },
        2,
      ),
    );

    expect(cleared.artifacts).toEqual({ plan: 'plan.md' });
    expect(cleared.projectionSequence).toBe(seeded.projectionSequence + 1);
    expect(RehydrationDocumentSchema.safeParse(cleared).success).toBe(true);
  });

  /** An object, an array and `''` are neither a set nor a clear. The patch is a no-op, and `projectionSequence` does not advance. */
  it('Rehydration_Given_StatePatchedArtifactsAllUnactionable_When_Fold_Then_NoOp', () => {
    const initial = rehydrationReducer.initial;
    const patched = makeEvent(
      'state.patched',
      {
        featureId: 'feat-77',
        fields: ['artifacts'],
        patch: {
          artifacts: { nested: { x: 1 }, list: [1, 2], empty: '' },
        },
      },
      1,
    );
    const next = rehydrationReducer.apply(initial, patched);
    expect(next).toBe(initial);
    expect(next.projectionSequence).toBe(0);
  });
});

/** Three events add a blocker: `review.completed` with a `blocked` verdict, `review.escalated` and `workflow.guard-failed`. */
describe('rehydration reducer — blockers fold (T025, DR-3)', () => {
  it('Rehydration_Given_ReviewCompletedBlocked_When_Fold_Then_BlockerAppended', () => {
    const initial = rehydrationReducer.initial;
    const reviewed = makeEvent(
      'review.completed',
      {
        stage: 'quality-review',
        verdict: 'blocked',
        findingsCount: 2,
        summary: 'Blocking: missing ADR for new public API',
      },
      1,
    );
    const next = rehydrationReducer.apply(initial, reviewed);
    expect(next.blockers).toHaveLength(1);
    expect(next.projectionSequence).toBe(1);
    expect(RehydrationDocumentSchema.safeParse(next).success).toBe(true);
  });

  /** A `pass` verdict is not a blocker, and the reducer does not count the event. */
  it('Rehydration_Given_ReviewCompletedPass_When_Fold_Then_NoBlockerAdded', () => {
    const initial = rehydrationReducer.initial;
    const reviewed = makeEvent(
      'review.completed',
      {
        stage: 'spec-review',
        verdict: 'pass',
        findingsCount: 0,
        summary: 'all good',
      },
      1,
    );
    const next = rehydrationReducer.apply(initial, reviewed);
    expect(next.blockers).toEqual([]);
    expect(next.projectionSequence).toBe(0);
    expect(next).toBe(initial);
  });

  it('Rehydration_Given_ReviewEscalated_When_Fold_Then_BlockerAppended', () => {
    const initial = rehydrationReducer.initial;
    const escalated = makeEvent(
      'review.escalated',
      {
        pr: 7,
        reason: 'critical security finding',
        originalScore: 0.3,
        triggeringFinding: 'hardcoded secret',
      },
      1,
    );
    const next = rehydrationReducer.apply(initial, escalated);
    expect(next.blockers).toHaveLength(1);
    expect(next.projectionSequence).toBe(1);
    expect(RehydrationDocumentSchema.safeParse(next).success).toBe(true);
  });

  it('Rehydration_Given_WorkflowGuardFailed_When_Fold_Then_BlockerAppended', () => {
    const initial = rehydrationReducer.initial;
    const guard = makeEvent(
      'workflow.guard-failed',
      {
        guard: 'designApproved',
        from: 'design',
        to: 'plan',
        featureId: 'feat-42',
      },
      1,
    );
    const next = rehydrationReducer.apply(initial, guard);
    expect(next.blockers).toHaveLength(1);
    expect(next.projectionSequence).toBe(1);
    expect(RehydrationDocumentSchema.safeParse(next).success).toBe(true);
  });
});

/**
 * No `decision.*` event type is registered, so the reducer has no decisions fold.
 * The test asserts that premise. When such a type is registered, the test fails and its message asks for the fold.
 */
describe('rehydration reducer — decisions fold (T025, DR-3)', () => {
  it('RehydrationReducer_DecisionsFold_HasNoRegisteredEventSourceToFold', () => {
    const decisionEvents = EventTypes.filter((type) => type.startsWith('decision.'));
    expect(
      decisionEvents,
      `A 'decision.*' event type is now registered (${decisionEvents.join(', ')}). The ` +
        `rehydration reducer has no decisions fold — it was omitted precisely because no ` +
        `event produced decisions. Extend the reducer and replace this premise check with ` +
        `real fold coverage.`,
    ).toEqual([]);
  });
});

/** `taskProgress` uses the `TaskSchema.status` words, so a consumer can compare it with the canonical task state. */
describe('rehydration reducer — canonical vocabulary (#1359 / PR4)', () => {
  /** The plan status `complete` stays `complete`. The reducer does not rename it to `completed`. */
  it('RehydrationReducer_StatePatchedCompleteTask_SurfacesCanonicalCompleteVocabulary', () => {
    const initial = rehydrationReducer.initial;
    const patched = makeEvent(
      'state.patched',
      {
        featureId: 'feat-1359',
        fields: ['tasks'],
        patch: {
          tasks: [{ id: 'T001', title: 'first', status: 'complete' }],
        },
      },
      1,
    );

    const next = rehydrationReducer.apply(initial, patched);

    expect(next.taskProgress[0]?.status).toBe('complete');
    expect(next.taskProgress[0]?.id).toBe('T001');
  });
});

/**
 * `data.patch.tasks` of `state.patched` holds the full task list of the planner.
 * The reducer adds those tasks to `taskProgress`, so a pending task with no `task.*` event is visible.
 * A plan status never lowers a status that a `task.*` event set.
 */
describe('rehydration reducer — state.patched.tasks fold (Fix 2 / #1179)', () => {
  /** `T5` has no `task.*` event, so it keeps the `pending` status of the plan. */
  it('Rehydration_StatePatchedTasksWithMixedStatuses_FoldsAllAndAppliesEventOverrides', () => {
    const initial = rehydrationReducer.initial;
    const started = makeEvent(
      'workflow.started',
      { featureId: 'feat-1179', workflowType: 'feature' },
      1,
    );
    const afterStarted = rehydrationReducer.apply(initial, started);

    const planPatched = makeEvent(
      'state.patched',
      {
        featureId: 'feat-1179',
        fields: ['tasks'],
        patch: {
          tasks: [
            { id: 'T1', title: 'Task 1', status: 'pending' },
            { id: 'T2', title: 'Task 2', status: 'pending' },
            { id: 'T3', title: 'Task 3', status: 'pending' },
            { id: 'T4', title: 'Task 4', status: 'pending' },
            { id: 'T5', title: 'Task 5', status: 'pending' },
          ],
        },
      },
      2,
    );
    const afterPlan = rehydrationReducer.apply(afterStarted, planPatched);

    const assignedT1 = makeEvent('task.assigned', { taskId: 'T1', title: 'Task 1' }, 3);
    const completedT2 = makeEvent('task.completed', { taskId: 'T2' }, 4);
    const completedT3 = makeEvent('task.completed', { taskId: 'T3' }, 5);
    const failedT4 = makeEvent('task.failed', { taskId: 'T4', error: 'boom' }, 6);

    let next = rehydrationReducer.apply(afterPlan, assignedT1);
    next = rehydrationReducer.apply(next, completedT2);
    next = rehydrationReducer.apply(next, completedT3);
    next = rehydrationReducer.apply(next, failedT4);

    expect(next.taskProgress).toHaveLength(5);

    const byId = new Map(next.taskProgress.map((t) => [t.id, t.status]));
    expect(byId.get('T1')).toBe('in_progress');
    expect(byId.get('T2')).toBe('complete');
    expect(byId.get('T3')).toBe('complete');
    expect(byId.get('T4')).toBe('failed');
    expect(byId.get('T5')).toBe('pending');

    const completed = next.taskProgress.filter((t) => t.status === 'complete');
    expect(completed).toHaveLength(2);

    expect(RehydrationDocumentSchema.safeParse(next).success).toBe(true);
  });

  /**
   * A plan-review revision can narrow the plan, which is a normal outcome.
   * The fold drops the pending tasks that the new plan does not list. Thus the document does not report the union of all revisions.
   */
  it('Rehydration_PlanNarrowedByRevision_RetractsDroppedPendingTasks', () => {
    const initial = rehydrationReducer.initial;
    const widePlan = rehydrationReducer.apply(
      initial,
      makeEvent(
        'state.patched',
        {
          featureId: 'feat-narrow',
          fields: ['tasks'],
          patch: {
            tasks: [
              { id: 'T1', title: 'kept', status: 'pending' },
              { id: 'T2', title: 'kept', status: 'pending' },
              { id: 'T3', title: 'dropped by revision', status: 'pending' },
              { id: 'T4', title: 'dropped by revision', status: 'pending' },
            ],
          },
        },
        1,
      ),
    );
    expect(widePlan.taskProgress).toHaveLength(4);

    const narrowPlan = rehydrationReducer.apply(
      widePlan,
      makeEvent(
        'state.patched',
        {
          featureId: 'feat-narrow',
          fields: ['tasks'],
          patch: {
            tasks: [
              { id: 'T1', title: 'kept', status: 'pending' },
              { id: 'T2', title: 'kept', status: 'pending' },
            ],
          },
        },
        2,
      ),
    );

    expect(narrowPlan.taskProgress).toHaveLength(2);
    expect(narrowPlan.taskProgress.map((t) => t.id).sort()).toEqual(['T1', 'T2']);

    expect(RehydrationDocumentSchema.safeParse(narrowPlan).success).toBe(true);
  });

  /** A dropped task with a `task.*` status stays, because it shows real work. Only the untouched pending task goes. */
  it('Rehydration_PlanDropsTaskCarryingLifecycleEvidence_RetainsIt', () => {
    const initial = rehydrationReducer.initial;
    const plan = rehydrationReducer.apply(
      initial,
      makeEvent(
        'state.patched',
        {
          featureId: 'feat-evidence',
          fields: ['tasks'],
          patch: {
            tasks: [
              { id: 'KEEP', title: 'stays in plan', status: 'pending' },
              { id: 'WORKED', title: 'dropped while in flight', status: 'pending' },
              { id: 'DONE', title: 'dropped after completing', status: 'pending' },
              { id: 'GHOST', title: 'dropped untouched', status: 'pending' },
            ],
          },
        },
        1,
      ),
    );
    let next = rehydrationReducer.apply(
      plan,
      makeEvent('task.assigned', { taskId: 'WORKED', title: 'w' }, 2),
    );
    next = rehydrationReducer.apply(next, makeEvent('task.completed', { taskId: 'DONE' }, 3));

    const narrowed = rehydrationReducer.apply(
      next,
      makeEvent(
        'state.patched',
        {
          featureId: 'feat-evidence',
          fields: ['tasks'],
          patch: { tasks: [{ id: 'KEEP', title: 'stays in plan', status: 'pending' }] },
        },
        4,
      ),
    );

    const byId = new Map(narrowed.taskProgress.map((t) => [t.id, t.status]));
    expect(byId.get('KEEP')).toBe('pending');
    expect(byId.get('WORKED')).toBe('in_progress');
    expect(byId.get('DONE')).toBe('complete');
    expect(byId.has('GHOST')).toBe(false);
    expect(narrowed.taskProgress).toHaveLength(3);

    expect(RehydrationDocumentSchema.safeParse(narrowed).success).toBe(true);
  });

  /**
   * An absent `tasks` subtree says nothing about the plan, so the fold must not read it as an empty plan.
   * Otherwise an artifacts-only patch erases the plan tasks.
   */
  it('Rehydration_StatePatchedWithoutTasksSubtree_LeavesTaskProgressIntact', () => {
    const initial = rehydrationReducer.initial;
    const plan = rehydrationReducer.apply(
      initial,
      makeEvent(
        'state.patched',
        {
          featureId: 'feat-artifacts-only',
          fields: ['tasks'],
          patch: {
            tasks: [
              { id: 'T1', title: 'a', status: 'pending' },
              { id: 'T2', title: 'b', status: 'pending' },
            ],
          },
        },
        1,
      ),
    );

    const artifactsOnly = rehydrationReducer.apply(
      plan,
      makeEvent(
        'state.patched',
        {
          featureId: 'feat-artifacts-only',
          fields: ['artifacts'],
          patch: { artifacts: { pr: 'https://example.test/pr/1' } },
        },
        2,
      ),
    );

    expect(artifactsOnly.taskProgress).toHaveLength(2);
    expect(artifactsOnly.artifacts['pr']).toBe('https://example.test/pr/1');

    expect(RehydrationDocumentSchema.safeParse(artifactsOnly).success).toBe(true);
  });

  /**
   * The planner stamps `tasks` again on a later `set` call, with A and B still `pending`.
   * The plan status must not lower the `complete` and `failed` statuses that the events set.
   */
  it('Rehydration_StatePatchedTasksFollowedByPlanReexpansion_DoesNotResurrectCompleted', () => {
    const initial = rehydrationReducer.initial;
    const firstPlan = rehydrationReducer.apply(
      initial,
      makeEvent(
        'state.patched',
        {
          featureId: 'feat-x',
          fields: ['tasks'],
          patch: {
            tasks: [
              { id: 'A', title: 'A', status: 'pending' },
              { id: 'B', title: 'B', status: 'pending' },
            ],
          },
        },
        1,
      ),
    );
    const afterCompletion = rehydrationReducer.apply(
      firstPlan,
      makeEvent('task.completed', { taskId: 'A' }, 2),
    );
    expect(
      afterCompletion.taskProgress.find((t) => t.id === 'A')?.status,
    ).toBe('complete');

    const afterFailure = rehydrationReducer.apply(
      afterCompletion,
      makeEvent('task.failed', { taskId: 'B', error: 'boom' }, 3),
    );
    expect(
      afterFailure.taskProgress.find((t) => t.id === 'B')?.status,
    ).toBe('failed');

    const secondPlan = rehydrationReducer.apply(
      afterFailure,
      makeEvent(
        'state.patched',
        {
          featureId: 'feat-x',
          fields: ['tasks'],
          patch: {
            tasks: [
              { id: 'A', title: 'A', status: 'pending' },
              { id: 'B', title: 'B', status: 'pending' },
              { id: 'C', title: 'C', status: 'pending' },
            ],
          },
        },
        4,
      ),
    );

    const byId = new Map(secondPlan.taskProgress.map((t) => [t.id, t.status]));
    expect(byId.get('A')).toBe('complete');
    expect(byId.get('B')).toBe('failed');
    expect(byId.get('C')).toBe('pending');
    expect(secondPlan.taskProgress).toHaveLength(3);
  });
});

/**
 * A `task.completed` event with `data.worktree` or `data.worktreePath` moves a feature workflow to `merge-pending`.
 * Then a consumer of the rehydration document can offer the `merge_orchestrate` verb.
 */
describe('rehydration reducer — worktree auto-detour (#1208)', () => {
  it('Rehydration_TaskCompletedWithWorktreePath_StampsMergePending', () => {
    const seeded = featureInDelegate();
    const completed = makeEvent(
      'task.completed',
      { taskId: '001', worktreePath: '/tmp/wt/001' },
      2,
    );
    const next = rehydrationReducer.apply(seeded, completed);

    expect(next.workflowState.phase).toBe('merge-pending');
    expect(next.workflowState.mergeOrchestrator).toEqual({
      taskId: '001',
      phase: 'pending',
    });
    expect(RehydrationDocumentSchema.safeParse(next).success).toBe(true);
  });

  it('Rehydration_TaskCompletedWithWorktree_StampsMergePending', () => {
    const seeded = featureInDelegate();
    const completed = makeEvent(
      'task.completed',
      { taskId: '002', worktree: '.worktrees/002' },
      2,
    );
    const next = rehydrationReducer.apply(seeded, completed);

    expect(next.workflowState.phase).toBe('merge-pending');
    expect(next.workflowState.mergeOrchestrator).toEqual({
      taskId: '002',
      phase: 'pending',
    });
  });

  it('Rehydration_TaskCompletedNoWorktree_LeavesPhaseUntouched', () => {
    const seeded = featureInDelegate();
    const completed = makeEvent('task.completed', { taskId: '003' }, 2);
    const next = rehydrationReducer.apply(seeded, completed);

    expect(next.workflowState.phase).toBe('delegate');
    expect(next.workflowState.mergeOrchestrator).toBeUndefined();
  });

  /** Only the feature HSM defines `merge-pending`, so a worktree on a non-feature workflow must not change the phase. */
  it('Rehydration_TaskCompletedWithWorktreeOnRefactorWorkflow_DoesNotDetour', () => {
    let s = rehydrationReducer.apply(
      rehydrationReducer.initial,
      makeEvent(
        'workflow.started',
        { featureId: 'rf-1', workflowType: 'refactor' },
        0,
      ),
    );
    s = rehydrationReducer.apply(
      s,
      makeEvent('workflow.transition', { from: '', to: 'delegate' }, 1),
    );
    const next = rehydrationReducer.apply(
      s,
      makeEvent('task.completed', { taskId: 'r1', worktree: '.wt/r1' }, 2),
    );
    expect(next.workflowState.phase).toBe('delegate');
    expect(next.workflowState.mergeOrchestrator).toBeUndefined();
  });

  /** The detour applies only in the `''`, `delegate` and `merge-pending` phases. A `task.completed` in `synthesize` must not rewrite the phase. */
  it('Rehydration_TaskCompletedWithWorktreeFeatureOutsideDelegate_DoesNotDetour', () => {
    let s = rehydrationReducer.apply(
      rehydrationReducer.initial,
      makeEvent(
        'workflow.started',
        { featureId: 'feat-out', workflowType: 'feature' },
        0,
      ),
    );
    s = rehydrationReducer.apply(
      s,
      makeEvent('workflow.transition', { from: '', to: 'synthesize' }, 1),
    );
    const next = rehydrationReducer.apply(
      s,
      makeEvent('task.completed', { taskId: 'fo', worktree: '.wt/fo' }, 2),
    );
    expect(next.workflowState.phase).toBe('synthesize');
    expect(next.workflowState.mergeOrchestrator).toBeUndefined();
  });

  it('Rehydration_MergeExecuted_RevertsPhaseAndStampsTerminal', () => {
    const seeded = featureInDelegate();
    const stampedPending = rehydrationReducer.apply(
      seeded,
      makeEvent('task.completed', { taskId: '004', worktree: '.wt/004' }, 2),
    );
    const afterMerge = rehydrationReducer.apply(
      stampedPending,
      makeEvent('merge.executed', { taskId: '004', mergeSha: 'abc' }, 3),
    );

    expect(afterMerge.workflowState.phase).toBe('delegate');
    expect(afterMerge.workflowState.mergeOrchestrator).toEqual({
      taskId: '004',
      phase: 'completed',
    });
  });

  it('Rehydration_MergeRollback_RevertsPhaseAndStampsRolledBack', () => {
    const seeded = featureInDelegate();
    const stamped = rehydrationReducer.apply(
      seeded,
      makeEvent('task.completed', { taskId: '005', worktree: '.wt/005' }, 2),
    );
    const after = rehydrationReducer.apply(
      stamped,
      makeEvent('merge.rollback', { taskId: '005', reason: 'preflight' }, 3),
    );

    expect(after.workflowState.phase).toBe('delegate');
    expect(after.workflowState.mergeOrchestrator?.phase).toBe('rolled-back');
  });

  it('Rehydration_MergeAborted_RevertsPhaseAndStampsAborted', () => {
    const seeded = featureInDelegate();
    const stamped = rehydrationReducer.apply(
      seeded,
      makeEvent('task.completed', { taskId: '006', worktree: '.wt/006' }, 2),
    );
    const after = rehydrationReducer.apply(
      stamped,
      makeEvent('merge.aborted', { taskId: '006', reason: 'manual' }, 3),
    );

    expect(after.workflowState.phase).toBe('delegate');
    expect(after.workflowState.mergeOrchestrator?.phase).toBe('aborted');
  });

  /**
   * A merge event with no earlier worktree `task.completed` must not invent a `mergeOrchestrator` entry.
   * The handler returns `state` unchanged, so `projectionSequence` keeps the seed value.
   */
  it('Rehydration_MergeTerminalEventWithoutPriorPending_NoOps', () => {
    const seeded = featureInDelegate();
    const next = rehydrationReducer.apply(
      seeded,
      makeEvent('merge.executed', { taskId: '007', mergeSha: 'def' }, 2),
    );
    expect(next.workflowState.mergeOrchestrator).toBeUndefined();
    expect(next.projectionSequence).toBe(seeded.projectionSequence);
  });

  /** A whitespace-only `worktree` is not an association, so it must not start the detour. */
  it('Rehydration_TaskCompletedWithWhitespaceWorktree_DoesNotDetour', () => {
    const seeded = featureInDelegate();
    const completed = makeEvent(
      'task.completed',
      { taskId: 'ws', worktree: '   ' },
      2,
    );
    const next = rehydrationReducer.apply(seeded, completed);
    expect(next.workflowState.phase).toBe('delegate');
    expect(next.workflowState.mergeOrchestrator).toBeUndefined();
  });

  /**
   * While task A has a pending merge, a worktree `task.completed` for task B must not replace that entry.
   * Otherwise a later terminal merge event applies to the wrong task. `taskProgress` still records B as `complete`.
   */
  it('Rehydration_TaskCompletedWithDifferentTaskActivePending_DoesNotClobberMergeOrchestrator', () => {
    const seeded = featureInDelegate();
    const stampedA = rehydrationReducer.apply(
      seeded,
      makeEvent('task.completed', { taskId: 'A', worktree: '.wt/A' }, 2),
    );
    expect(stampedA.workflowState.mergeOrchestrator).toEqual({
      taskId: 'A',
      phase: 'pending',
    });

    const afterB = rehydrationReducer.apply(
      stampedA,
      makeEvent('task.completed', { taskId: 'B', worktree: '.wt/B' }, 3),
    );
    expect(afterB.workflowState.mergeOrchestrator).toEqual({
      taskId: 'A',
      phase: 'pending',
    });
    expect(afterB.workflowState.phase).toBe('merge-pending');
    expect(afterB.taskProgress.find((t) => t.id === 'B')?.status).toBe(
      'complete',
    );
  });

  /**
   * After the merge of task A ends, a worktree `task.completed` for task B must set a new pending entry.
   * Otherwise a workflow with more than one task stops at the first merge.
   */
  it('Rehydration_TaskCompletedAfterTerminalForOtherTask_StampsForNewTask', () => {
    const seeded = featureInDelegate();
    const stampedA = rehydrationReducer.apply(
      seeded,
      makeEvent('task.completed', { taskId: 'A', worktree: '.wt/A' }, 2),
    );
    const mergedA = rehydrationReducer.apply(
      stampedA,
      makeEvent('merge.executed', { taskId: 'A', mergeSha: 'sha-A' }, 3),
    );
    expect(mergedA.workflowState.mergeOrchestrator?.phase).toBe('completed');
    expect(mergedA.workflowState.phase).toBe('delegate');

    const afterB = rehydrationReducer.apply(
      mergedA,
      makeEvent('task.completed', { taskId: 'B', worktree: '.wt/B' }, 4),
    );
    expect(afterB.workflowState.mergeOrchestrator).toEqual({
      taskId: 'B',
      phase: 'pending',
    });
    expect(afterB.workflowState.phase).toBe('merge-pending');
  });

  /** A repeated terminal merge event must not advance `projectionSequence`, because it changes nothing. */
  it('Rehydration_RefoldedTerminalMergeEvent_IsNoOp', () => {
    const seeded = featureInDelegate();
    const stamped = rehydrationReducer.apply(
      seeded,
      makeEvent('task.completed', { taskId: '009', worktree: '.wt/009' }, 2),
    );
    const merged = rehydrationReducer.apply(
      stamped,
      makeEvent('merge.executed', { taskId: '009', mergeSha: 'abc' }, 3),
    );
    const beforeSequence = merged.projectionSequence;

    const refolded = rehydrationReducer.apply(
      merged,
      makeEvent('merge.executed', { taskId: '009', mergeSha: 'abc' }, 4),
    );
    expect(refolded.projectionSequence).toBe(beforeSequence);
    expect(refolded.workflowState.mergeOrchestrator?.phase).toBe('completed');
  });

  /**
   * A replayed worktree `task.completed` after the merge ended must not set the entry back to `pending`.
   * Otherwise `next_actions` offers `merge_orchestrate` again.
   */
  it('Rehydration_RefoldedSameTaskCompleted_DoesNotRegressTerminalMerge', () => {
    const seeded = featureInDelegate();
    const stamped = rehydrationReducer.apply(
      seeded,
      makeEvent('task.completed', { taskId: '008', worktree: '.wt/008' }, 2),
    );
    const merged = rehydrationReducer.apply(
      stamped,
      makeEvent('merge.executed', { taskId: '008', mergeSha: 'sha' }, 3),
    );
    const refolded = rehydrationReducer.apply(
      merged,
      makeEvent('task.completed', { taskId: '008', worktree: '.wt/008' }, 4),
    );
    expect(refolded.workflowState.phase).toBe('delegate');
    expect(refolded.workflowState.mergeOrchestrator?.phase).toBe('completed');
  });
});

describe('rehydration reducer — workflow.checkpoint handoff fold (T2 / #1240 / #1246)', () => {
  function makeCheckpoint(
    sequence: number,
    handoff: {
      context?: string;
      nextSteps?: string[];
      suggestions?: string[];
    } | undefined,
    overrides: { phase?: string; counter?: number; timestamp?: string } = {},
  ): WorkflowEvent {
    const phase = overrides.phase ?? 'design';
    const counter = overrides.counter ?? sequence;
    const data: Record<string, unknown> = {
      counter,
      phase,
      featureId: 'wf-test',
    };
    if (handoff !== undefined) {
      data['handoff'] = handoff;
    }
    const evt: WorkflowEvent = {
      streamId: 'wf-test',
      sequence,
      timestamp: overrides.timestamp ?? `2026-05-08T00:00:0${sequence % 10}.000Z`,
      type: 'workflow.checkpoint',
      schemaVersion: '1.0',
      data,
    } as WorkflowEvent;
    return evt;
  }

  /** `eventRef` holds only `sequence` and `timestamp`, with no `id` key. */
  it('applyWorkflowCheckpoint_NonEmptyHandoff_SetsLatestHandoff', () => {
    const initial = rehydrationReducer.initial;

    const evt = makeCheckpoint(
      7,
      {
        context: 'design phase wrapping up',
        nextSteps: ['run typecheck', 'open PR'],
        suggestions: ['re-read CLAUDE.md'],
      },
      { timestamp: '2026-05-08T12:34:56.000Z' },
    );

    const next = rehydrationReducer.apply(initial, evt);

    expect(next.latestHandoff).toBeDefined();
    expect(next.latestHandoff?.context).toBe('design phase wrapping up');
    expect(next.latestHandoff?.nextSteps).toEqual(['run typecheck', 'open PR']);
    expect(next.latestHandoff?.suggestions).toEqual(['re-read CLAUDE.md']);
    expect(next.latestHandoff?.eventRef.sequence).toBe(7);
    expect(next.latestHandoff?.eventRef.timestamp).toBe('2026-05-08T12:34:56.000Z');

    expect(Object.keys(next.latestHandoff!.eventRef).sort()).toEqual([
      'sequence',
      'timestamp',
    ]);

    expect(next.recentHandoffs).toHaveLength(1);
    expect(next.recentHandoffs[0]).toEqual(next.latestHandoff);

    expect(next.projectionSequence).toBe(1);

    expect(initial.latestHandoff).toBeUndefined();
    expect(initial.recentHandoffs).toEqual([]);
    expect(initial.projectionSequence).toBe(0);

    expect(RehydrationDocumentSchema.safeParse(next).success).toBe(true);
  });

  /** Three cases return `state` unchanged: no `handoff`, a `handoff` with no fields, and a `handoff` with only empty arrays. */
  it('applyWorkflowCheckpoint_EmptyHandoff_NoStateChange', () => {
    const initial = rehydrationReducer.initial;

    const evtNoHandoff = makeCheckpoint(1, undefined);
    const next1 = rehydrationReducer.apply(initial, evtNoHandoff);
    expect(next1).toBe(initial);
    expect(next1.projectionSequence).toBe(0);
    expect(next1.latestHandoff).toBeUndefined();
    expect(next1.recentHandoffs).toEqual([]);

    const evtAllUndef = makeCheckpoint(2, {});
    const next2 = rehydrationReducer.apply(initial, evtAllUndef);
    expect(next2).toBe(initial);
    expect(next2.projectionSequence).toBe(0);

    const evtEmptyArrays = makeCheckpoint(3, {
      nextSteps: [],
      suggestions: [],
    });
    const next3 = rehydrationReducer.apply(initial, evtEmptyArrays);
    expect(next3).toBe(initial);
    expect(next3.projectionSequence).toBe(0);
  });

  /** After 5 checkpoints, `recentHandoffs` holds the last 3, newest first. */
  it('applyWorkflowCheckpoint_MultipleEvents_RecentHandoffsBoundedToThree', () => {
    let state = rehydrationReducer.initial;
    for (let i = 1; i <= 5; i++) {
      state = rehydrationReducer.apply(
        state,
        makeCheckpoint(i, {
          context: `checkpoint ${i}`,
          nextSteps: [`step-${i}`],
        }),
      );
    }

    expect(state.recentHandoffs).toHaveLength(3);

    expect(state.recentHandoffs[0]?.context).toBe('checkpoint 5');
    expect(state.recentHandoffs[1]?.context).toBe('checkpoint 4');
    expect(state.recentHandoffs[2]?.context).toBe('checkpoint 3');

    expect(state.recentHandoffs[0]?.eventRef.sequence).toBe(5);
    expect(state.recentHandoffs[1]?.eventRef.sequence).toBe(4);
    expect(state.recentHandoffs[2]?.eventRef.sequence).toBe(3);

    expect(state.latestHandoff?.context).toBe('checkpoint 5');
    expect(state.latestHandoff?.eventRef.sequence).toBe(5);

    expect(state.projectionSequence).toBe(5);

    expect(RehydrationDocumentSchema.safeParse(state).success).toBe(true);
  });

  /** Two folds of the same 4 events from the initial document must give equal documents. */
  it('applyWorkflowCheckpoint_ReplayFromInitial_ReconstructsLatest', () => {
    const events = [1, 2, 3, 4].map((i) =>
      makeCheckpoint(i, {
        context: `phase ${i} done`,
        nextSteps: [`task-${i}`],
        suggestions: [`hint-${i}`],
      }),
    );

    let incremental = rehydrationReducer.initial;
    for (const evt of events) {
      incremental = rehydrationReducer.apply(incremental, evt);
    }

    let replayed = rehydrationReducer.initial;
    for (const evt of events) {
      replayed = rehydrationReducer.apply(replayed, evt);
    }

    expect(replayed).toEqual(incremental);

    expect(replayed.latestHandoff?.eventRef.sequence).toBe(4);
    expect(replayed.latestHandoff?.context).toBe('phase 4 done');

    expect(replayed.recentHandoffs.map((e) => e.eventRef.sequence)).toEqual([
      4, 3, 2,
    ]);

    for (const entry of replayed.recentHandoffs) {
      expect(Object.keys(entry.eventRef).sort()).toEqual([
        'sequence',
        'timestamp',
      ]);
    }

    expect(RehydrationDocumentSchema.safeParse(replayed).success).toBe(true);
  });

  /** The strict schema already rejects an `id` in `eventRef`. This test checks the keys directly as a second guard. */
  it('applyWorkflowCheckpoint_EventRefSequenceIsPrimary_NoIdField', () => {
    let state = rehydrationReducer.initial;
    for (let i = 10; i <= 12; i++) {
      state = rehydrationReducer.apply(
        state,
        makeCheckpoint(i, {
          context: `cp-${i}`,
          nextSteps: [`step-${i}`],
        }),
      );
    }

    expect(state.recentHandoffs.length).toBeGreaterThan(0);
    for (const entry of state.recentHandoffs) {
      const refKeys = Object.keys(entry.eventRef).sort();
      expect(refKeys).toEqual(['sequence', 'timestamp']);
      expect(refKeys).not.toContain('id');
      expect(typeof entry.eventRef.sequence).toBe('number');
      expect(Number.isInteger(entry.eventRef.sequence)).toBe(true);
      expect(entry.eventRef.sequence).toBeGreaterThanOrEqual(0);
      expect(typeof entry.eventRef.timestamp).toBe('string');
    }

    expect(state.latestHandoff).toBeDefined();
    expect(Object.keys(state.latestHandoff!.eventRef).sort()).toEqual([
      'sequence',
      'timestamp',
    ]);
  });

  /**
   * The upgrade of a v:1 snapshot drops a handoff entry whose `eventRef` has no usable `sequence`.
   * A fresh replay of the events gives the full `recentHandoffs` list, because each event has a sequence.
   * The event at sequence 22 stands for the dropped entry.
   */
  it('applyWorkflowCheckpoint_FreshReplayRecoversSnapshotDroppedEntries', () => {
    const evtA = makeCheckpoint(21, {
      context: 'phase A done',
      nextSteps: ['next-A'],
    });
    const evtB = makeCheckpoint(22, {
      context: 'phase B done — entry the legacy snapshot dropped',
      nextSteps: ['next-B'],
    });
    const evtC = makeCheckpoint(23, {
      context: 'phase C done',
      nextSteps: ['next-C'],
    });

    let replayed = rehydrationReducer.initial;
    for (const evt of [evtA, evtB, evtC]) {
      replayed = rehydrationReducer.apply(replayed, evt);
    }

    expect(replayed.recentHandoffs).toHaveLength(3);
    const sequences = replayed.recentHandoffs.map((e) => e.eventRef.sequence);
    expect(sequences).toEqual([23, 22, 21]);

    const recovered = replayed.recentHandoffs.find(
      (e) => e.eventRef.sequence === 22,
    );
    expect(recovered).toBeDefined();
    expect(recovered?.context).toBe(
      'phase B done — entry the legacy snapshot dropped',
    );
    expect(recovered?.nextSteps).toEqual(['next-B']);
    expect(Object.keys(recovered!.eventRef).sort()).toEqual([
      'sequence',
      'timestamp',
    ]);

    expect(RehydrationDocumentSchema.safeParse(replayed).success).toBe(true);
  });
});

describe('rehydration reducer — workflow.handoff_summarized fold (#1242)', () => {
  function makeSummarized(
    sequence: number,
    handoff: { context?: string; nextSteps?: string[]; suggestions?: string[] } | undefined,
    overrides: { phase?: string; timestamp?: string } = {},
  ): WorkflowEvent {
    const data: Record<string, unknown> = {
      featureId: 'wf-test',
      ...(overrides.phase !== undefined ? { phase: overrides.phase } : {}),
    };
    if (handoff !== undefined) data['handoff'] = handoff;
    return {
      streamId: 'wf-test',
      sequence,
      timestamp: overrides.timestamp ?? `2026-05-08T01:00:0${sequence % 10}.000Z`,
      type: 'workflow.handoff_summarized',
      schemaVersion: '1.0',
      data,
    } as WorkflowEvent;
  }

  function makeCheckpoint(
    sequence: number,
    handoff: { context?: string; nextSteps?: string[]; suggestions?: string[] },
    timestamp = `2026-05-08T00:00:0${sequence % 10}.000Z`,
  ): WorkflowEvent {
    return {
      streamId: 'wf-test',
      sequence,
      timestamp,
      type: 'workflow.checkpoint',
      schemaVersion: '1.0',
      data: { counter: sequence, phase: 'design', featureId: 'wf-test', handoff },
    } as WorkflowEvent;
  }

  it('Summarized_NoOperatorHandoff_FillsLatestHandoffWithAutoSource', () => {
    const next = rehydrationReducer.apply(
      rehydrationReducer.initial,
      makeSummarized(5, { context: 'auto: wrapping up plan phase', nextSteps: ['dispatch wave 1'] }, { timestamp: '2026-05-08T09:00:00.000Z' }),
    );

    expect(next.latestHandoff?.context).toBe('auto: wrapping up plan phase');
    expect(next.latestHandoff?.nextSteps).toEqual(['dispatch wave 1']);
    expect(next.latestHandoff?.source).toBe('auto');
    expect(next.latestHandoff?.eventRef).toEqual({ sequence: 5, timestamp: '2026-05-08T09:00:00.000Z' });
    expect(next.recentHandoffs).toHaveLength(1);
    expect(next.projectionSequence).toBe(1);
    expect(RehydrationDocumentSchema.safeParse(next).success).toBe(true);
  });

  it('Summarized_DoesNotOverwriteOperatorHandoff_OperatorPrecedence', () => {
    const afterOperator = rehydrationReducer.apply(
      rehydrationReducer.initial,
      makeCheckpoint(3, { context: 'operator: hand-written handoff' }),
    );
    expect(afterOperator.latestHandoff?.source).toBe('operator');

    const afterSummary = rehydrationReducer.apply(afterOperator, makeSummarized(4, { context: 'auto: should be suppressed' }));

    expect(afterSummary).toBe(afterOperator);
    expect(afterSummary.latestHandoff?.context).toBe('operator: hand-written handoff');
    expect(afterSummary.latestHandoff?.source).toBe('operator');
    expect(afterSummary.recentHandoffs).toHaveLength(1);
    expect(afterSummary.projectionSequence).toBe(afterOperator.projectionSequence);
  });

  it('OperatorCheckpoint_OverwritesPriorSummary_OperatorAlwaysWins', () => {
    const afterSummary = rehydrationReducer.apply(rehydrationReducer.initial, makeSummarized(1, { context: 'auto: placeholder' }));
    expect(afterSummary.latestHandoff?.source).toBe('auto');

    const afterOperator = rehydrationReducer.apply(afterSummary, makeCheckpoint(2, { context: 'operator: real handoff' }));

    expect(afterOperator.latestHandoff?.context).toBe('operator: real handoff');
    expect(afterOperator.latestHandoff?.source).toBe('operator');
    expect(afterOperator.recentHandoffs[0]?.source).toBe('operator');
  });

  it('Summarized_OverwritesPriorSummary_MostRecentAutoWins', () => {
    const s1 = rehydrationReducer.apply(rehydrationReducer.initial, makeSummarized(1, { context: 'auto v1' }));
    const s2 = rehydrationReducer.apply(s1, makeSummarized(2, { context: 'auto v2' }));
    expect(s2.latestHandoff?.context).toBe('auto v2');
    expect(s2.latestHandoff?.source).toBe('auto');
    expect(s2.recentHandoffs).toHaveLength(2);
  });

  it('Summarized_EmptyHandoff_NoStateChange', () => {
    const initial = rehydrationReducer.initial;
    expect(rehydrationReducer.apply(initial, makeSummarized(1, undefined))).toBe(initial);
    expect(rehydrationReducer.apply(initial, makeSummarized(2, {}))).toBe(initial);
    expect(rehydrationReducer.apply(initial, makeSummarized(3, { nextSteps: [], suggestions: [] }))).toBe(initial);
  });

  /**
   * The stored summary is the source of truth, so a replay gives the same projection and does not call the summarizer.
   * The operator handoff at sequence 2 wins, and the reducer ignores the later summary.
   */
  it('Summarized_ReplayDeterminism_FoldingTwiceYieldsEqualProjection', () => {
    const events = [
      makeSummarized(1, { context: 'auto: phase A summary' }),
      makeCheckpoint(2, { context: 'operator: phase B handoff' }),
      makeSummarized(3, { context: 'auto: suppressed by operator' }),
    ];
    const foldOnce = events.reduce((s, e) => rehydrationReducer.apply(s, e), rehydrationReducer.initial);
    const foldTwice = events.reduce((s, e) => rehydrationReducer.apply(s, e), rehydrationReducer.initial);
    expect(foldOnce).toEqual(foldTwice);
    expect(foldOnce.latestHandoff?.context).toBe('operator: phase B handoff');
    expect(foldOnce.latestHandoff?.source).toBe('operator');
  });

  /**
   * The summarized fold always writes `source: 'auto'`, so a `latestHandoff` with no `source` is an operator entry.
   * The summary must not replace it.
   */
  it('Summarized_LegacyEntryWithoutSource_TreatedAsOperator', () => {
    const legacyState = {
      ...rehydrationReducer.initial,
      latestHandoff: {
        context: 'legacy operator handoff',
        eventRef: { sequence: 9, timestamp: '2026-05-01T00:00:00.000Z' },
      },
    } as typeof rehydrationReducer.initial;

    const next = rehydrationReducer.apply(legacyState, makeSummarized(10, { context: 'auto: should defer to legacy' }));
    expect(next).toBe(legacyState);
    expect(next.latestHandoff?.context).toBe('legacy operator handoff');
  });
});
