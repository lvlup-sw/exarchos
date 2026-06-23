import { guards, composeGuards } from './guards.js';
import type { Guard, GuardResult } from './guards.js';
import type { HSMDefinition, State, Transition } from './state-machine.js';
import { eventDataHasWorktreeAssociation } from '../projections/rehydration/reducer.js';
import type { WorkflowEvent } from '../event-store/schemas.js';

// ─── Merge Orchestrator Phase Filtering (T17 / T19) ─────────────────────────

/**
 * Phases of `state.mergeOrchestrator.phase` that mean the merge has already
 * terminated and a `merge-pending` transition should NOT fire (and the
 * `merge_orchestrate` next-action should NOT be surfaced).
 *
 * Shared by:
 *   - The feature HSM `merge-pending` entry predicate (this file, T17).
 *   - `next-actions-computer` surfacing filter (T19).
 *
 * Reusing one constant keeps the entry predicate and the surfacing filter in
 * lockstep so a `merge-pending` HSM state can never sit live without a
 * corresponding next-action, and a completed/rolled-back merge can never be
 * re-entered.
 */
export const EXCLUDED_MERGE_PHASES: ReadonlySet<string> = new Set<string>([
  'completed',
  'rolled-back',
  'aborted',
]);

// ─── merge-pending guards (T17 / DR-MO-1, DR-MO-2) ──────────────────────────

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
 * True when the most recent `task.completed` event in `state._events` carries
 * a worktree association (either `data.worktree` or `data.worktreePath`).
 *
 * Captures the design's "task whose state carries a `worktree` association"
 * trigger from DR-MO-1 / DR-MO-2. The same predicate is reused by the
 * rehydration projection (`eventDataHasWorktreeAssociation` in
 * projections/rehydration/reducer.ts) so HSM guard and projection observe
 * the same trigger condition — see #1208.
 */
function latestTaskCompletedHasWorktree(state: Record<string, unknown>): boolean {
  const events = (state._events as readonly Record<string, unknown>[]) ?? [];
  const latest = findLatestTaskCompleted(events);
  if (!latest) return false;
  // Single source of truth: delegate to the rehydration reducer's predicate
  // so the HSM guard and the rehydration projection NEVER diverge on what
  // counts as a worktree association. Per #1109 Constraint 1
  // (event-sourcing integrity), the live HSM and the replayed projection
  // must observe the same trigger — otherwise a whitespace-only worktree
  // value would advance the live state to merge-pending while the
  // rehydrated state would not, and consumers downstream would miss
  // merge_orchestrate after a server restart.
  return eventDataHasWorktreeAssociation(
    latest.data as WorkflowEvent['data'],
  );
}

/**
 * True when `state.mergeOrchestrator?.phase` is NOT one of the terminal
 * `EXCLUDED_MERGE_PHASES`. Undefined / missing is treated as "not excluded"
 * (i.e. transition is permitted) — first-time entry has no prior phase.
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
 * Guard for `merge-pending → delegate`: fires when the event stream contains
 * a `merge.executed`, `merge.rollback`/`merge.recovered`, or any explicit abort
 * signal (`merge.aborted`, or `mergeOrchestrator.phase === 'aborted'`).
 */
const mergePendingExit: Guard = {
  id: 'merge-pending-exit',
  description:
    'A merge.executed/merge.rollback/merge.recovered/merge.aborted must follow the latest task.completed (or mergeOrchestrator.phase must be terminal)',
  evaluate: (state: Record<string, unknown>): GuardResult => {
    const events = (state._events as readonly Record<string, unknown>[]) ?? [];
    // Cycle-scoped: only terminal events that follow the latest task.completed
    // count. A history-wide `some()` would stay true forever after the first
    // merge cycle, so subsequent task.completed → merge-pending entries would
    // exit immediately on stale events from prior cycles.
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
        // #1306 — merge.recovered is the successor to merge.rollback; both are
        // terminal during the v2.11.x dual-emit deprecation window.
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

// ─── Feature Workflow HSM ───────────────────────────────────────────────────

export function createFeatureHSM(): HSMDefinition {
  const states: Record<string, State> = {
    // DR-4 (#1581): GATHER collapsed into PLAN. The former `ideate` (GATHER)
    // state is removed; `plan` (PLAN, read-only) is the feature workflow's
    // INITIAL state (initialPhaseRegistry.feature === 'plan'). Entry obligation
    // is the unified `docs/specs/` artifact's existence; `plan-review` remains
    // the single human approval point. No new kind (INV-6); a phase removed
    // (INV-15).
    plan: { id: 'plan', type: 'atomic', kind: 'PLAN' },
    'plan-review': { id: 'plan-review', type: 'atomic', kind: 'PLAN' },
    implementation: {
      id: 'implementation',
      type: 'compound',
      initial: 'delegate',
      // HSM circuit-breaker fix-cycle bound for the delegate↔review loop. This
      // is the structural delegate-loop guard and is a DELIBERATE value, kept
      // distinct from the shared escalation auto-fix bound
      // (`DEFAULT_MAX_ITERATIONS` = 5 in orchestrate/escalation-policy.ts, DR-3
      // #1595) that governs the spec/quality/shepherd fix-loops — do not fold
      // the two together.
      maxFixCycles: 3,
      onEntry: ['log'],
      onExit: ['log'],
    },
    delegate: { id: 'delegate', type: 'atomic', kind: 'IMPLEMENT', parent: 'implementation' },
    review: { id: 'review', type: 'atomic', kind: 'REVIEW', parent: 'implementation' },
    // T17: substate entered when a delegated subagent worktree task completes
    // and an autonomous merge is required before progressing. Exits back to
    // `delegate` once `merge.executed` / `merge.rollback` / `merge.aborted`
    // is observed.
    'merge-pending': {
      id: 'merge-pending',
      type: 'atomic',
      kind: 'SYNTHESIZE',
      parent: 'implementation',
    },
    synthesize: { id: 'synthesize', type: 'atomic', kind: 'SYNTHESIZE' },
    completed: { id: 'completed', type: 'final' },
    cancelled: { id: 'cancelled', type: 'final' },
    blocked: { id: 'blocked', type: 'atomic', kind: 'GATHER' },
  };

  const transitions: Transition[] = [
    // DR-4 (#1581): the `ideate → plan` transition (guarded by
    // `designArtifactExists`) is retired with the `ideate` state — `plan` is now
    // initial, so it needs no inbound bootstrap transition.
    { from: 'plan', to: 'plan-review', guard: guards.planArtifactExists },
    { from: 'plan-review', to: 'delegate', guard: guards.planReviewComplete },
    {
      from: 'plan-review',
      to: 'plan',
      guard: guards.planReviewGapsFound,
      effects: ['log'],
    },
    { from: 'plan-review', to: 'blocked', guard: guards.revisionsExhausted },
    { from: 'delegate', to: 'review', guard: composeGuards(
      'all-tasks-complete+team-disbanded',
      'All tasks must be complete and team must be disbanded',
      guards.allTasksComplete,
      guards.teamDisbandedEmitted,
    ) },
    // T17: auto-trigger entry into `merge-pending` when a delegated task
    // completed inside a subagent worktree and the merge has not already
    // terminated. See DR-MO-1 / DR-MO-2.
    { from: 'delegate', to: 'merge-pending', guard: mergePendingEntry },
    // T17: exit `merge-pending` once the merge has been executed, rolled
    // back, or explicitly aborted.
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

// ─── Debug Workflow HSM ─────────────────────────────────────────────────────

export function createDebugHSM(): HSMDefinition {
  const states: Record<string, State> = {
    triage: { id: 'triage', type: 'atomic', kind: 'GATHER' },
    investigate: { id: 'investigate', type: 'atomic', kind: 'GATHER' },

    // Thorough track compound
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

    // Hotfix track compound
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

    // Investigate -> thorough or hotfix
    { from: 'investigate', to: 'rca', guard: guards.thoroughTrackSelected },
    {
      from: 'investigate',
      to: 'hotfix-implement',
      guard: guards.hotfixTrackSelected,
    },
    { from: 'investigate', to: 'cancelled', guard: guards.escalationRequired },
    { from: 'investigate', to: 'completed', guard: guards.fixVerifiedDirectly },

    // Thorough track flow
    { from: 'rca', to: 'design', guard: guards.rcaDocumentComplete },
    { from: 'design', to: 'debug-implement', guard: guards.fixDesignComplete },
    {
      from: 'debug-implement',
      to: 'debug-validate',
      guard: guards.implementationComplete,
    },
    { from: 'debug-validate', to: 'debug-review', guard: guards.validationPassed },
    { from: 'debug-review', to: 'synthesize', guard: guards.reviewPassed },

    // Hotfix track flow
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

    // Synthesize -> retry (track-aware) or completed
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

// ─── Oneshot Workflow HSM ───────────────────────────────────────────────────
//
// Lightweight lifecycle for small changes: plan → implementing → (choice state).
// The `implementing` phase evaluates two mutually exclusive guards
// (synthesisOptedIn / synthesisOptedOut) which are pure functions of
// (synthesisPolicy, synthesize.requested events) per the design doc.
//
// Declaration order matters: the state machine tries transitions in array
// order. We keep both branches listed so getValidTransitions advertises
// both to callers; exactly one will pass its guard for any given state
// (enforced by the choice-state mutual-exclusivity property test in
// state-machine.test.ts and the inverse-guard property test in
// guards.test.ts).

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

// ─── Discovery Workflow HSM ─────────────────────────────────────────────────

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

// ─── Refactor Workflow HSM ──────────────────────────────────────────────────

export function createRefactorHSM(): HSMDefinition {
  const states: Record<string, State> = {
    explore: { id: 'explore', type: 'atomic', kind: 'GATHER' },
    brief: { id: 'brief', type: 'atomic', kind: 'PLAN' },

    // Polish track compound
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

    // Overhaul track compound
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

    // Brief -> polish or overhaul
    {
      from: 'brief',
      to: 'polish-implement',
      guard: guards.polishTrackSelected,
    },
    { from: 'brief', to: 'overhaul-plan', guard: guards.overhaulTrackSelected },

    // Polish track flow
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

    // Overhaul track flow
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
    {
      from: 'overhaul-plan-review',
      to: 'overhaul-plan',
      guard: guards.planReviewGapsFound,
      effects: ['log'],
    },
    { from: 'overhaul-plan-review', to: 'blocked', guard: guards.revisionsExhausted },
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

    // Synthesize -> retry or completed
    { from: 'synthesize', to: 'overhaul-delegate', guard: guards.synthesizeRetryable },
    { from: 'synthesize', to: 'completed', guard: guards.prUrlExists },
  ];

  return { id: 'refactor', states, transitions };
}
