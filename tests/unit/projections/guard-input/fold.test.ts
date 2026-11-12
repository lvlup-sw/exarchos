/**
 * These tests check the guard fold and the document side of the guard input.
 * `foldGuardInput` gives the guard input from the rows of one stream. Each task takes its status only from the task rows.
 * `documentGuardInput` gives the guard input of a state document, with `_events` from the rows.
 * Each case writes its rows and its expected inputs as literals, and some cases also run a guard or the facts step on the input.
 * The scan case plants a module in the guard-input directory and expects the retired-authority scan to find it.
 *
 * @oracle-sources: ../../../../src/projections/views/workflow-state-projection.ts, the rows and expected inputs written in this file
 */
import { describe, expect, it } from 'vitest';

import type { WorkflowEvent } from '../../../../src/events/schemas.js';
import type { GuardConfigOptions } from '../../../../src/projections/guard-input/config.js';
import {
  documentGuardInput,
  foldGuardInput,
  foldWorkflowState,
  type GuardInput,
  type GuardInputOptions,
} from '../../../../src/projections/guard-input/fold.js';
import { toGuardEvents } from '../../../../src/projections/guard-input/guard-events.js';
import { tallyPlanRevisions } from '../../../../src/projections/shared/plan-revision-count.js';
import { projectStateToFacts } from '../../../../src/workflow/admission/legacy-state-translation.js';
import { collectCleanupEvidence } from '../../../../src/workflow/cleanup.js';
import type { Guard } from '../../../../src/workflow/guards.js';
import { GUARD_BINDINGS } from '../../../../src/workflow/hsm-definitions.js';
import { resolveGateSet } from '../../../../src/workflow/phase-kind.js';
import {
  scanRetiredAuthorityReintroduction,
  type SourceModule,
} from '../../../../src/workflow/retirement/retirement-safety.js';

/** The stream id of the rows of this file. */
const FEATURE_ID = 'guard-fold';

/** The options that set each mutation field to a valid value. */
const MUTATION_OPTIONS: GuardConfigOptions = {
  mutationEnforcement: 'block',
  mutationThreshold: 80,
  maxNoCoverage: 2,
};

/** Returns one row with the envelope fields that the store gives a row. */
function row(sequence: number, type: string, data: Record<string, unknown>): WorkflowEvent {
  return {
    streamId: FEATURE_ID,
    sequence,
    timestamp: `2026-11-11T10:${String(sequence).padStart(2, '0')}:00.000Z`,
    type,
    schemaVersion: '1.0',
    data,
  };
}

/** Returns the rows that start a feature stream and move it to `delegate`. The sequences are 1 to 3. */
function delegateRows(): WorkflowEvent[] {
  return [
    row(1, 'workflow.started', { featureId: FEATURE_ID, workflowType: 'feature' }),
    row(2, 'workflow.transition', { featureId: FEATURE_ID, from: 'plan', to: 'plan-review', trigger: 'execute-transition' }),
    row(3, 'workflow.transition', { featureId: FEATURE_ID, from: 'plan-review', to: 'delegate', trigger: 'execute-transition' }),
  ];
}

/** True when the value is an object that is not an array. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Returns the entries of a list value, or an empty list when the value is not a list. */
function listOf(value: unknown): readonly unknown[] {
  if (!Array.isArray(value)) return [];
  const list: readonly unknown[] = value;
  return list;
}

/** Returns the id and the status of each task of an input, in list order. */
function taskStatuses(tasks: unknown): readonly { readonly id: unknown; readonly status: unknown }[] {
  return listOf(tasks).map((task) =>
    isRecord(task) ? { id: task.id, status: task.status } : { id: undefined, status: undefined },
  );
}

/** Returns the guard of an id from the binding table, or throws when the table holds no such guard. */
function guardOf(id: string): Guard {
  const guard = GUARD_BINDINGS.get(id);
  if (guard === undefined) throw new Error(`the binding table holds no guard '${id}'`);
  return guard;
}

describe('the guard fold and the document side', () => {
  /**
   * A patch forges a `complete` status, and no completion row names the task.
   * The base fold keeps the forged status, and the guard fold gives `pending` for each task.
   */
  it('FoldGuardInput_APatchedCompleteStatusWithNoCompletionRow_IsPending', () => {
    const rows = [
      ...delegateRows(),
      row(4, 'state.patched', {
        patch: {
          tasks: [
            { id: 't1', title: 'the first task', status: 'complete' },
            { id: 't2', title: 'the second task', status: 'in_progress' },
          ],
        },
      }),
    ];

    const input = foldGuardInput(rows);

    expect(taskStatuses(foldWorkflowState(rows).tasks)).toEqual([
      { id: 't1', status: 'complete' },
      { id: 't2', status: 'in_progress' },
    ]);
    expect(input.tasks).toEqual([
      { id: 't1', title: 'the first task', status: 'pending' },
      { id: 't2', title: 'the second task', status: 'pending' },
    ]);
  });

  /** A completion row gives `complete`. A later patch of `tasks` sets the task back to `pending`, and the completion row still wins. */
  it('FoldGuardInput_ACompletionRow_StaysCompleteAfterALaterPatchOfTasks', () => {
    const completed = [
      ...delegateRows(),
      row(4, 'task.assigned', { taskId: 't1', title: 'the first task' }),
      row(5, 'task.completed', { taskId: 't1' }),
    ];
    const patched = [
      ...completed,
      row(6, 'state.patched', { patch: { tasks: [{ id: 't1', title: 'the first task', status: 'pending' }] } }),
    ];

    expect(taskStatuses(foldGuardInput(completed).tasks)).toEqual([{ id: 't1', status: 'complete' }]);
    expect(taskStatuses(foldWorkflowState(patched).tasks)).toEqual([{ id: 't1', status: 'pending' }]);
    expect(taskStatuses(foldGuardInput(patched).tasks)).toEqual([{ id: 't1', status: 'complete' }]);
  });

  /** The last task row wins. A failure row after a completion gives `failed`, and a completion row after that gives `complete`. */
  it('FoldGuardInput_AFailedRowAfterACompletion_IsFailed_AndALaterCompletion_IsComplete', () => {
    const failed = [
      ...delegateRows(),
      row(4, 'task.assigned', { taskId: 't1', title: 'the first task' }),
      row(5, 'task.completed', { taskId: 't1' }),
      row(6, 'task.failed', { taskId: 't1', error: 'the review found a defect' }),
    ];
    const completedAgain = [...failed, row(7, 'task.completed', { taskId: 't1' })];

    expect(taskStatuses(foldGuardInput(failed).tasks)).toEqual([{ id: 't1', status: 'failed' }]);
    expect(taskStatuses(foldGuardInput(completedAgain).tasks)).toEqual([{ id: 't1', status: 'complete' }]);
  });

  /** The task list is the list of the projection. A completion row for a task that the list does not hold adds no task. */
  it('FoldGuardInput_ACompletionRowForAnUnknownTask_AddsNoTask', () => {
    const rows = [
      ...delegateRows(),
      row(4, 'task.assigned', { taskId: 't1', title: 'the first task' }),
      row(5, 'task.completed', { taskId: 'ghost' }),
    ];

    const input = foldGuardInput(rows);

    expect(taskStatuses(input.tasks)).toEqual([{ id: 't1', status: 'pending' }]);
    expect(taskStatuses(input.tasks).map((task) => task.id)).toEqual(
      foldWorkflowState(rows).tasks.map((task) => task.id),
    );
  });

  /**
   * The evidence function gets the folded state, and `_cleanup.mergeVerified` is its verdict.
   * A review at `needs_fixes` fails the evidence, and a later approval passes it. Without the option, the input holds no `_cleanup`.
   */
  it('FoldGuardInput_CleanupEvidence_SetsTheCleanupInputFromTheFoldedState', () => {
    const needsFixes = [
      ...delegateRows(),
      row(4, 'state.patched', {
        patch: {
          reviews: { quality: { status: 'needs_fixes' } },
          'synthesis.prUrl': 'https://example.test/pr/1',
        },
      }),
    ];
    const approved = [...needsFixes, row(5, 'state.patched', { patch: { 'reviews.quality.status': 'approved' } })];
    const seen: GuardInput[] = [];
    const options: GuardInputOptions = {
      cleanupEvidence: (state) => {
        seen.push(state);
        return collectCleanupEvidence(state).verified;
      },
    };

    const failing = foldGuardInput(needsFixes, options);
    const passing = foldGuardInput(approved, options);

    expect(failing._cleanup).toEqual({ mergeVerified: false });
    expect(passing._cleanup).toEqual({ mergeVerified: true });
    expect(seen.map((state) => [state.phase, state.reviews])).toEqual([
      ['delegate', { quality: { status: 'needs_fixes' } }],
      ['delegate', { quality: { status: 'approved' } }],
    ]);
    expect(guardOf('merge-verified').evaluate(failing)).not.toBe(true);
    expect(guardOf('merge-verified').evaluate(passing)).toBe(true);
    expect(Object.hasOwn(foldGuardInput(approved), '_cleanup')).toBe(false);
  });

  /**
   * The facts step counts the plan revisions from `_events` of the input, so the count is the tally of the rows.
   * Three dispatches and one revise row give 2. The projection field `planReview.revisionCount` gives 3, and the facts do not read it.
   */
  it('FoldGuardInput_TheRevisionCount_IsTheTallyOfTheRows', () => {
    const rows = [
      row(1, 'workflow.started', { featureId: FEATURE_ID, workflowType: 'feature' }),
      row(2, 'workflow.transition', { featureId: FEATURE_ID, from: 'plan', to: 'plan-review', trigger: 'execute-transition' }),
      row(3, 'workflow.plan-review-dispatched', { featureId: FEATURE_ID, ordinal: 0 }),
      row(4, 'workflow.plan-review-dispatched', { featureId: FEATURE_ID, ordinal: 1 }),
      row(5, 'workflow.plan-review-dispatched', { featureId: FEATURE_ID, ordinal: 2 }),
      row(6, 'workflow.plan-revision', { featureId: FEATURE_ID }),
    ];

    const input = foldGuardInput(rows, { config: { maxPlanRevisions: 2 } });
    const facts = projectStateToFacts(input).fields;

    expect(tallyPlanRevisions(rows).revisions).toBe(2);
    expect(facts['planReview.revisionCount']).toBe(2);
    expect(facts['policy.maxPlanRevisions']).toBe(2);
    expect(facts['planReview.revisionsExhausted']).toBe(true);
    expect(guardOf('revisions-exhausted').evaluate(input)).toBe(true);
    expect(foldWorkflowState(rows)).toMatchObject({ planReview: { revisionCount: 3 } });
  });

  /**
   * Each terminal merge row gives the orchestrator phase. A failed preflight gives `aborted`, and an execution gives `completed`.
   * A recovery and the retired rollback give `rolled-back`. A passing preflight gives no orchestrator block.
   */
  it('FoldGuardInput_TheFourMergeRows_GiveTheOrchestratorPhase', () => {
    const cases: readonly { readonly type: string; readonly data: Record<string, unknown>; readonly phase: string }[] = [
      { type: 'merge.preflight', data: { taskId: 't1', passed: false }, phase: 'aborted' },
      { type: 'merge.executed', data: { taskId: 't1', mergeSha: 'abc1234' }, phase: 'completed' },
      { type: 'merge.recovered', data: { taskId: 't1', recoveryPointSha: 'def5678' }, phase: 'rolled-back' },
      { type: 'merge.rollback', data: { taskId: 't1', rollbackSha: 'def5678' }, phase: 'rolled-back' },
    ];

    const phases = cases.map(({ type, data }) => {
      const input = foldGuardInput([...delegateRows(), row(4, type, data)]);
      return { type, orchestrator: input.mergeOrchestrator };
    });
    const passingPreflight = foldGuardInput([...delegateRows(), row(4, 'merge.preflight', { taskId: 't1', passed: true })]);

    expect(phases).toEqual(
      cases.map(({ type, phase }) => ({ type, orchestrator: expect.objectContaining({ phase, taskId: 't1' }) })),
    );
    expect(Object.hasOwn(passingPreflight, 'mergeOrchestrator')).toBe(false);
  });

  /**
   * With `config`, the fold computes the config from its own tier and boundary status.
   * The rows patch the tier to `high`, so the fold gets the mutation fields. A document at `medium` gets none on the same rows.
   */
  it('FoldGuardInput_Config_ReadsTheTierOfTheFold', () => {
    const rows = [...delegateRows(), row(4, 'state.patched', { patch: { riskTier: 'high', boundaryTouching: true } })];
    const document: GuardInput = { featureId: FEATURE_ID, workflowType: 'feature', phase: 'delegate', riskTier: 'medium' };
    const highReviews = resolveGateSet('REVIEW', { riskTier: 'high', boundaryTouching: true, workflowType: 'feature' })
      .flatMap((gate) => (gate.family === 'review' ? [gate.gate] : []));

    const fold = foldGuardInput(rows, { config: MUTATION_OPTIONS });
    const side = documentGuardInput(document, rows, { config: MUTATION_OPTIONS });
    const noConfig = foldGuardInput(rows);

    expect(highReviews).toEqual(['review', 'mutation-adequacy']);
    expect(fold).toMatchObject({
      riskTier: 'high',
      boundaryTouching: true,
      _requiredReviews: ['review', 'mutation-adequacy'],
      _mutationEnforcement: 'block',
      _mutationThreshold: 80,
      _maxNoCoverage: 2,
    });
    expect(side._requiredReviews).toEqual(['review']);
    for (const key of ['_mutationEnforcement', '_mutationThreshold', '_maxNoCoverage']) {
      expect(Object.hasOwn(side, key)).toBe(false);
    }
    for (const key of ['_requiredReviews', '_mutationEnforcement', '_mutationThreshold', '_maxNoCoverage']) {
      expect(Object.hasOwn(noConfig, key)).toBe(false);
    }
  });

  /** Two folds of the same rows and options give equal inputs, and neither fold changes a row. */
  it('FoldGuardInput_TheSameRows_GiveEqualInputsAndLeaveTheRowsUnchanged', () => {
    const rows = [
      ...delegateRows(),
      row(4, 'state.patched', {
        patch: {
          tasks: [
            { id: 't1', title: 'the first task', status: 'complete' },
            { id: 't2', title: 'the second task', status: 'complete' },
          ],
        },
      }),
      row(5, 'task.completed', { taskId: 't2', worktree: 'worktrees/t2' }),
      row(6, 'synthesize.requested', { featureId: FEATURE_ID }),
    ];
    const before = structuredClone(rows);
    const options: GuardInputOptions = {
      config: {},
      cleanupEvidence: (state) => collectCleanupEvidence(state).verified,
    };

    const first = foldGuardInput(rows, options);
    const second = foldGuardInput(rows, options);

    expect(second).toStrictEqual(first);
    expect(taskStatuses(first.tasks)).toEqual([
      { id: 't1', status: 'pending' },
      { id: 't2', status: 'complete' },
    ]);
    expect(rows).toStrictEqual(before);
  });

  /**
   * The document side keeps each field of the document and replaces only `_events` with the map of the rows.
   * It keeps a forged task status, and it does not change the document. The `ephemerals` apply last on both sides.
   */
  it('DocumentGuardInput_KeepsEachDocumentFieldAndTakesTheEventsFromTheRows', () => {
    const rows = [...delegateRows(), row(4, 'task.assigned', { taskId: 't1', title: 'the first task' })];
    const document: GuardInput = {
      featureId: FEATURE_ID,
      workflowType: 'feature',
      phase: 'delegate',
      _version: 4,
      artifacts: { design: null, plan: 'plans/plan.md', pr: null },
      tasks: [{ id: 't1', title: 'the first task', status: 'complete' }],
      _events: [{ type: 'transition', timestamp: '2026-11-11T09:00:00.000Z', from: 'plan', to: 'plan-review' }],
    };
    const before = structuredClone(document);
    const pinnedEvents = [{ type: 'synthesize.requested', timestamp: '2026-11-11T11:00:00.000Z' }];

    const input = documentGuardInput(document, rows);
    const pinnedDocument = documentGuardInput(document, rows, { ephemerals: { _events: pinnedEvents } });
    const pinnedFold = foldGuardInput(rows, { ephemerals: { _events: pinnedEvents } });

    expect(input).toStrictEqual({ ...before, _events: toGuardEvents(rows) });
    expect(toGuardEvents(rows)).toHaveLength(4);
    expect(taskStatuses(input.tasks)).toEqual([{ id: 't1', status: 'complete' }]);
    expect(input.tasks).not.toBe(document.tasks);
    expect(document).toStrictEqual(before);
    expect(pinnedDocument._events).toEqual(pinnedEvents);
    expect(pinnedFold._events).toEqual(pinnedEvents);
  });

  /**
   * The verdict of today on the store path. A guard event holds no `data` key, so `merge-pending-entry` denies a completion with a worktree.
   * The same guard admits an entry that holds the worktree under `data`, so only the missing key decides the denial.
   */
  it('FoldGuardInput_OnTheStorePath_MergePendingEntryDeniesACompletionWithAWorktree', () => {
    const rows = [
      ...delegateRows(),
      row(4, 'task.assigned', { taskId: 't1', title: 'the first task' }),
      row(5, 'task.completed', { taskId: 't1', worktree: 'worktrees/t1' }),
    ];
    const guard = guardOf('merge-pending-entry');

    const input = foldGuardInput(rows, { config: {} });
    const latest = listOf(input._events).at(-1);
    const withDataKey = {
      ...input,
      _events: [{ type: 'task.completed', timestamp: '2026-11-11T10:05:00.000Z', data: { taskId: 't1', worktree: 'worktrees/t1' } }],
    };

    expect(latest).toStrictEqual({
      type: 'task.completed',
      timestamp: '2026-11-11T10:05:00.000Z',
      taskId: 't1',
      worktree: 'worktrees/t1',
      metadata: { taskId: 't1', worktree: 'worktrees/t1' },
    });
    expect(guard.evaluate(input)).toEqual({
      passed: false,
      reason: expect.stringContaining('latest task.completed event lacks data.worktree'),
      suggestedFix: expect.objectContaining({ tool: 'exarchos_orchestrate' }),
    });
    expect(projectStateToFacts(input).fields['mergePending.entryReady']).toBe(false);
    expect(guard.evaluate(withDataKey)).toBe(true);
  });

  /**
   * The retired-authority scan reads the guard-input modules. A pass literal of `_cleanup` there is a violation.
   * The same literal in another projection module is outside each scope, so the scan stays limited to its scopes.
   */
  it('RetiredAuthorityScan_APassLiteralInTheGuardInputModules_IsAViolation', () => {
    const content = [
      'export function foldGuardInput(state) {',
      '  state._cleanup = { mergeVerified: true };',
      '}',
    ].join('\n');
    const planted: readonly SourceModule[] = [{ path: 'projections/guard-input/fold.ts', content, isTest: false }];
    const outside: readonly SourceModule[] = [{ path: 'projections/views/workflow-state-projection.ts', content, isTest: false }];

    const violations = scanRetiredAuthorityReintroduction(planted);

    expect(violations.map((v) => [v.modulePath, v.patternId, v.line])).toEqual([
      ['projections/guard-input/fold.ts', 'force-write-merge-verified', 2],
      ['projections/guard-input/fold.ts', 'force-write-cleanup-pass-state', 2],
    ]);
    expect(violations.every((v) => v.authorityId === 'cleanup-pass-state-fix')).toBe(true);
    expect(scanRetiredAuthorityReintroduction(outside)).toEqual([]);
  });
});
