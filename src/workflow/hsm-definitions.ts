import { guards, composeGuards } from './guards.js';
import type { Guard, GuardResult } from './guards.js';
import type { HSMDefinition, State, Transition } from './state-machine.js';
import { eventDataHasWorktreeAssociation } from '../projections/rehydration/reducer.js';
import type { WorkflowEvent } from '../events/schemas.js';

/**
 * Phases of `state.mergeOrchestrator.phase` that mean the merge is over. In
 * these phases the `merge-pending` transition does not fire, and
 * `next-actions-computer` does not surface `merge_orchestrate`. One constant
 * keeps the entry predicate and the surfacing filter in step.
 */
export const EXCLUDED_MERGE_PHASES: ReadonlySet<string> = new Set<string>([
  'completed',
  'rolled-back',
  'aborted',
]);

/**
 * Returns the most recent `task.completed` event from `state._events`, or
 * undefined if none exist.
 */
function findLatestTaskCompleted(
  events: readonly Record<string, unknown>[],
): Record<string, unknown> | undefined {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    if (events[i]?.type === 'task.completed') return events[i];
  }
  return undefined;
}

/**
 * True when the latest `task.completed` event in `state._events` carries a
 * worktree association (`data.worktree` or `data.worktreePath`).
 *
 * It delegates to `eventDataHasWorktreeAssociation` from the rehydration
 * reducer, so the live HSM and the replayed projection see the same trigger.
 * Otherwise a whitespace-only worktree value moves only the live state to
 * `merge-pending`, and a restart loses `merge_orchestrate`.
 */
function latestTaskCompletedHasWorktree(state: Record<string, unknown>): boolean {
  const events = (state._events as readonly Record<string, unknown>[]) ?? [];
  const latest = findLatestTaskCompleted(events);
  if (!latest) return false;
  return eventDataHasWorktreeAssociation(
    latest.data as WorkflowEvent['data'],
  );
}

/**
 * True when `state.mergeOrchestrator?.phase` is not one of the terminal
 * `EXCLUDED_MERGE_PHASES`. A missing phase counts as not excluded, because a
 * first entry has no prior phase.
 */
function mergeOrchestratorPhaseNotExcluded(state: Record<string, unknown>): boolean {
  const merge = state.mergeOrchestrator as Record<string, unknown> | undefined;
  const phase = typeof merge?.phase === 'string' ? merge.phase : undefined;
  if (phase === undefined) return true;
  return !EXCLUDED_MERGE_PHASES.has(phase);
}

/**
 * Guard for `delegate → merge-pending`: fires when the most recent
 * `task.completed` carries a worktree association AND the merge orchestrator
 * has not already terminated for this feature.
 */
const mergePendingEntry: Guard = {
  id: 'merge-pending-entry',
  description:
    'Most recent task.completed must carry a worktree association and mergeOrchestrator must not already be in a terminal phase',
  evaluate: (state: Record<string, unknown>): GuardResult => {
    if (!latestTaskCompletedHasWorktree(state)) {
      return {
        passed: false,
        reason:
          'merge-pending-entry not satisfied: latest task.completed event lacks data.worktree / data.worktreePath',
        expectedShape: {
          _events: [{ type: 'task.completed', data: { worktree: '<worktree-path>' } }],
        },
      };
    }
    if (!mergeOrchestratorPhaseNotExcluded(state)) {
      const merge = state.mergeOrchestrator as Record<string, unknown> | undefined;
      const phase = typeof merge?.phase === 'string' ? merge.phase : '<unknown>';
      return {
        passed: false,
        reason: `merge-pending-entry not satisfied: mergeOrchestrator.phase='${phase}' is in EXCLUDED_MERGE_PHASES`,
      };
    }
    return true;
  },
};

/**
 * Guard for `merge-pending → delegate`. It fires when a `merge.executed`,
 * `merge.rollback`, `merge.recovered`, or `merge.aborted` event follows the
 * latest `task.completed`, or when `mergeOrchestrator.phase` is terminal.
 *
 * Only events after the latest `task.completed` count. A check over the whole
 * history stays true after the first merge cycle, so each later entry exits at
 * once. The `merge.rollback` arm lets old event logs exit too.
 */
const mergePendingExit: Guard = {
  id: 'merge-pending-exit',
  description:
    'A merge.executed/merge.rollback/merge.recovered/merge.aborted must follow the latest task.completed (or mergeOrchestrator.phase must be terminal)',
  evaluate: (state: Record<string, unknown>): GuardResult => {
    const events = (state._events as readonly Record<string, unknown>[]) ?? [];
    let latestTaskCompletedIdx = -1;
    for (let i = events.length - 1; i >= 0; i -= 1) {
      if (events[i]?.type === 'task.completed') {
        latestTaskCompletedIdx = i;
        break;
      }
    }
    const cycleEvents = latestTaskCompletedIdx >= 0
      ? events.slice(latestTaskCompletedIdx + 1)
      : events;
    const hasTerminalEvent = cycleEvents.some(
      (e) =>
        e.type === 'merge.executed' ||
        e.type === 'merge.rollback' ||
        e.type === 'merge.recovered' ||
        e.type === 'merge.aborted',
    );
    if (hasTerminalEvent) return true;
    const merge = state.mergeOrchestrator as Record<string, unknown> | undefined;
    const phase = typeof merge?.phase === 'string' ? merge.phase : undefined;
    if (phase !== undefined && EXCLUDED_MERGE_PHASES.has(phase)) return true;
    return {
      passed: false,
      reason:
        'merge-pending-exit not satisfied: no merge.executed/merge.rollback/merge.recovered/merge.aborted event found after the latest task.completed and mergeOrchestrator.phase is not terminal',
    };
  },
};

/**
 * The feature workflow HSM, with `plan` as the initial state. `maxFixCycles: 3`
 * bounds the delegate and review loop. Keep it separate from the escalation
 * auto-fix bound `DEFAULT_MAX_ITERATIONS`.
 *
 * `merge-pending` has kind MERGE, not SYNTHESIZE, so the boundary does not
 * freeze synthesis legs that the merge playbook never runs. Transitions are
 * first-match-wins, so `blocked` comes before the revise edge, and the revision
 * cap ends the loop. The revise edge sets `isRevision`, which emits the counted
 * `plan-revision` event that the cap reads.
 */
export function createFeatureHSM(): HSMDefinition {
  const states: Record<string, State> = {
    plan: { id: 'plan', type: 'atomic', kind: 'PLAN' },
    'plan-review': { id: 'plan-review', type: 'atomic', kind: 'PLAN' },
    implementation: {
      id: 'implementation',
      type: 'compound',
      initial: 'delegate',
      maxFixCycles: 3,
      onEntry: ['log'],
      onExit: ['log'],
    },
    delegate: { id: 'delegate', type: 'atomic', kind: 'IMPLEMENT', parent: 'implementation' },
    review: { id: 'review', type: 'atomic', kind: 'REVIEW', parent: 'implementation' },
    'merge-pending': {
      id: 'merge-pending',
      type: 'atomic',
      kind: 'MERGE',
      parent: 'implementation',
    },
    synthesize: { id: 'synthesize', type: 'atomic', kind: 'SYNTHESIZE' },
    completed: { id: 'completed', type: 'final' },
    cancelled: { id: 'cancelled', type: 'final' },
    blocked: { id: 'blocked', type: 'atomic', kind: 'GATHER' },
  };

  const transitions: Transition[] = [
    { from: 'plan', to: 'plan-review', guard: guards.planArtifactExists },
    { from: 'plan-review', to: 'delegate', guard: guards.planReviewComplete },
    { from: 'plan-review', to: 'blocked', guard: guards.revisionsExhausted },
    {
      from: 'plan-review',
      to: 'plan',
      guard: guards.planReviewGapsFound,
      isRevision: true,
      effects: ['log'],
    },
    { from: 'delegate', to: 'review', guard: composeGuards(
      'all-tasks-complete+team-disbanded',
      'All tasks must be complete and team must be disbanded',
      guards.allTasksComplete,
      guards.teamDisbandedEmitted,
    ) },
    { from: 'delegate', to: 'merge-pending', guard: mergePendingEntry },
    { from: 'merge-pending', to: 'delegate', guard: mergePendingExit },
    { from: 'review', to: 'synthesize', guard: guards.allReviewsPassed },
    {
      from: 'review',
      to: 'delegate',
      guard: guards.anyReviewFailed,
      isFixCycle: true,
      effects: ['increment-fix-cycle'],
    },
    { from: 'synthesize', to: 'delegate', guard: guards.synthesizeRetryable },
    { from: 'synthesize', to: 'completed', guard: guards.prUrlExists },
    { from: 'blocked', to: 'delegate', guard: guards.humanUnblocked },
  ];

  return { id: 'feature', states, transitions };
}

export function createDebugHSM(): HSMDefinition {
  const states: Record<string, State> = {
    triage: { id: 'triage', type: 'atomic', kind: 'GATHER' },
    investigate: { id: 'investigate', type: 'atomic', kind: 'GATHER' },

    'thorough-track': {
      id: 'thorough-track',
      type: 'compound',
      initial: 'rca',
      maxFixCycles: 2,
      onEntry: ['log'],
      onExit: ['log'],
    },
    rca: { id: 'rca', type: 'atomic', kind: 'PLAN', parent: 'thorough-track' },
    design: { id: 'design', type: 'atomic', kind: 'PLAN', parent: 'thorough-track' },
    'debug-implement': {
      id: 'debug-implement',
      type: 'atomic',
      kind: 'IMPLEMENT',
      parent: 'thorough-track',
    },
    'debug-validate': {
      id: 'debug-validate',
      type: 'atomic',
      kind: 'REVIEW',
      parent: 'thorough-track',
    },
    'debug-review': {
      id: 'debug-review',
      type: 'atomic',
      kind: 'REVIEW',
      parent: 'thorough-track',
    },

    'hotfix-track': {
      id: 'hotfix-track',
      type: 'compound',
      initial: 'hotfix-implement',
      onEntry: ['log'],
      onExit: ['log'],
    },
    'hotfix-implement': {
      id: 'hotfix-implement',
      type: 'atomic',
      kind: 'IMPLEMENT',
      parent: 'hotfix-track',
    },
    'hotfix-validate': {
      id: 'hotfix-validate',
      type: 'atomic',
      kind: 'REVIEW',
      parent: 'hotfix-track',
    },

    synthesize: { id: 'synthesize', type: 'atomic', kind: 'SYNTHESIZE' },
    completed: { id: 'completed', type: 'final' },
    cancelled: { id: 'cancelled', type: 'final' },
    blocked: { id: 'blocked', type: 'atomic', kind: 'GATHER' },
  };

  const transitions: Transition[] = [
    { from: 'triage', to: 'investigate', guard: guards.triageComplete },

    { from: 'investigate', to: 'rca', guard: guards.thoroughTrackSelected },
    {
      from: 'investigate',
      to: 'hotfix-implement',
      guard: guards.hotfixTrackSelected,
    },
    { from: 'investigate', to: 'cancelled', guard: guards.escalationRequired },
    { from: 'investigate', to: 'completed', guard: guards.fixVerifiedDirectly },

    { from: 'rca', to: 'design', guard: guards.rcaDocumentComplete },
    { from: 'design', to: 'debug-implement', guard: guards.fixDesignComplete },
    {
      from: 'debug-implement',
      to: 'debug-validate',
      guard: guards.implementationComplete,
    },
    { from: 'debug-validate', to: 'debug-review', guard: guards.validationPassed },
    { from: 'debug-review', to: 'synthesize', guard: guards.reviewPassed },

    {
      from: 'hotfix-implement',
      to: 'hotfix-validate',
      guard: guards.implementationComplete,
    },
    { from: 'hotfix-validate', to: 'synthesize', guard: composeGuards(
      'validation+pr-requested',
      'Validation must pass and PR must be requested',
      guards.validationPassed,
      guards.prRequested,
    ) },
    { from: 'hotfix-validate', to: 'completed', guard: guards.validationPassed },

    { from: 'synthesize', to: 'debug-implement', guard: composeGuards(
      'synthesize-retryable+thorough-track',
      'Synthesis retryable on thorough track',
      guards.synthesizeRetryable,
      guards.thoroughTrackSelected,
    ) },
    { from: 'synthesize', to: 'hotfix-implement', guard: composeGuards(
      'synthesize-retryable+hotfix-track',
      'Synthesis retryable on hotfix track',
      guards.synthesizeRetryable,
      guards.hotfixTrackSelected,
    ) },
    { from: 'synthesize', to: 'completed', guard: guards.prUrlExists },
  ];

  return { id: 'debug', states, transitions };
}

/**
 * Oneshot lifecycle for small changes: plan, implementing, then a choice state.
 * `implementing` has two mutually exclusive guards, `synthesisOptedIn` and
 * `synthesisOptedOut`. Both are pure functions of `synthesisPolicy` and the
 * `synthesize.requested` events. The list keeps both branches, so
 * `getValidTransitions` advertises both, and exactly one guard passes.
 */
export const oneshotTransitions: readonly Transition[] = [
  { from: 'plan', to: 'implementing', guard: guards.oneshotPlanSet },
  { from: 'implementing', to: 'synthesize', guard: guards.synthesisOptedIn },
  { from: 'implementing', to: 'completed', guard: guards.synthesisOptedOut },
  { from: 'synthesize', to: 'completed', guard: guards.mergeVerified },
];

export function createOneshotHSM(): HSMDefinition {
  const states: Record<string, State> = {
    plan: { id: 'plan', type: 'atomic', kind: 'PLAN' },
    implementing: { id: 'implementing', type: 'atomic', kind: 'IMPLEMENT' },
    synthesize: { id: 'synthesize', type: 'atomic', kind: 'SYNTHESIZE' },
    completed: { id: 'completed', type: 'final' },
    cancelled: { id: 'cancelled', type: 'final' },
  };

  return { id: 'oneshot', states, transitions: [...oneshotTransitions] };
}

export function createDiscoveryHSM(): HSMDefinition {
  const states: Record<string, State> = {
    gathering:    { id: 'gathering', type: 'atomic', kind: 'GATHER' },
    synthesizing: { id: 'synthesizing', type: 'atomic', kind: 'GATHER' },
    completed:    { id: 'completed', type: 'final' },
    cancelled:    { id: 'cancelled', type: 'final' },
  };

  const transitions: Transition[] = [
    { from: 'gathering', to: 'synthesizing', guard: guards.sourcesCollected },
    { from: 'synthesizing', to: 'completed', guard: guards.reportArtifactExists },
  ];

  return { id: 'discovery', states, transitions };
}

/**
 * The refactor workflow HSM, with a polish track and an overhaul track.
 * Transitions are first-match-wins, so `blocked` comes before the overhaul
 * revise edge, and the revision cap ends the loop. The revise edge sets
 * `isRevision`. Without it the revision count never increments, and the cap
 * never trips.
 */
export function createRefactorHSM(): HSMDefinition {
  const states: Record<string, State> = {
    explore: { id: 'explore', type: 'atomic', kind: 'GATHER' },
    brief: { id: 'brief', type: 'atomic', kind: 'PLAN' },

    'polish-track': {
      id: 'polish-track',
      type: 'compound',
      initial: 'polish-implement',
      onEntry: ['log'],
      onExit: ['log'],
    },
    'polish-implement': {
      id: 'polish-implement',
      type: 'atomic',
      kind: 'IMPLEMENT',
      parent: 'polish-track',
    },
    'polish-validate': {
      id: 'polish-validate',
      type: 'atomic',
      kind: 'REVIEW',
      parent: 'polish-track',
    },
    'polish-update-docs': {
      id: 'polish-update-docs',
      type: 'atomic',
      kind: 'GATHER',
      parent: 'polish-track',
    },

    'overhaul-track': {
      id: 'overhaul-track',
      type: 'compound',
      initial: 'overhaul-plan',
      maxFixCycles: 3,
      onEntry: ['log'],
      onExit: ['log'],
    },
    'overhaul-plan': {
      id: 'overhaul-plan',
      type: 'atomic',
      kind: 'PLAN',
      parent: 'overhaul-track',
    },
    'overhaul-plan-review': {
      id: 'overhaul-plan-review',
      type: 'atomic',
      kind: 'PLAN',
      parent: 'overhaul-track',
    },
    'overhaul-delegate': {
      id: 'overhaul-delegate',
      type: 'atomic',
      kind: 'IMPLEMENT',
      parent: 'overhaul-track',
    },
    'overhaul-review': {
      id: 'overhaul-review',
      type: 'atomic',
      kind: 'REVIEW',
      parent: 'overhaul-track',
    },
    'overhaul-update-docs': {
      id: 'overhaul-update-docs',
      type: 'atomic',
      kind: 'GATHER',
      parent: 'overhaul-track',
    },

    synthesize: { id: 'synthesize', type: 'atomic', kind: 'SYNTHESIZE' },
    completed: { id: 'completed', type: 'final' },
    cancelled: { id: 'cancelled', type: 'final' },
    blocked: { id: 'blocked', type: 'atomic', kind: 'GATHER' },
  };

  const transitions: Transition[] = [
    { from: 'explore', to: 'brief', guard: guards.scopeAssessmentComplete },

    {
      from: 'brief',
      to: 'polish-implement',
      guard: guards.polishTrackSelected,
    },
    { from: 'brief', to: 'overhaul-plan', guard: guards.overhaulTrackSelected },

    {
      from: 'polish-implement',
      to: 'polish-validate',
      guard: guards.implementationComplete,
    },
    {
      from: 'polish-validate',
      to: 'polish-update-docs',
      guard: guards.goalsVerified,
    },
    { from: 'polish-update-docs', to: 'completed', guard: guards.docsUpdated },

    {
      from: 'overhaul-plan',
      to: 'overhaul-plan-review',
      guard: guards.planArtifactExists,
    },
    {
      from: 'overhaul-plan-review',
      to: 'overhaul-delegate',
      guard: guards.planReviewComplete,
    },
    { from: 'overhaul-plan-review', to: 'blocked', guard: guards.revisionsExhausted },
    {
      from: 'overhaul-plan-review',
      to: 'overhaul-plan',
      guard: guards.planReviewGapsFound,
      isRevision: true,
      effects: ['log'],
    },
    { from: 'blocked', to: 'overhaul-delegate', guard: guards.humanUnblocked },
    {
      from: 'overhaul-delegate',
      to: 'overhaul-review',
      guard: guards.allTasksComplete,
    },
    {
      from: 'overhaul-review',
      to: 'overhaul-update-docs',
      guard: guards.allReviewsPassed,
    },
    {
      from: 'overhaul-review',
      to: 'overhaul-delegate',
      guard: guards.anyReviewFailed,
      isFixCycle: true,
      effects: ['increment-fix-cycle'],
    },
    { from: 'overhaul-update-docs', to: 'synthesize', guard: guards.docsUpdated },

    { from: 'synthesize', to: 'overhaul-delegate', guard: guards.synthesizeRetryable },
    { from: 'synthesize', to: 'completed', guard: guards.prUrlExists },
  ];

  return { id: 'refactor', states, transitions };
}
