import type { ViewProjection } from './materializer.js';
import type { WorkflowEvent } from '../../events/schemas.js';
import { canonicaliseTaskId } from '../../utils/task-id.js';
import { isTypedArtifactReference } from '../../workflow/guards.js';

export const DELEGATION_READINESS_VIEW = 'delegation-readiness';

export interface DelegationReadinessState {
  readonly ready: boolean;
  readonly blockers: readonly string[];
  readonly plan: {
    readonly approved: boolean;
    readonly taskCount: number;
    readonly artifactPresent: boolean;
  };
  readonly quality: {
    readonly queried: boolean;
    readonly gatePassRate: number | null;
    readonly regressions: readonly string[];
  };
  readonly worktrees: {
    readonly expected: number;
    readonly ready: number;
    readonly failed: readonly string[];
    /** Task ids from `task.assigned` events, without duplicates. `expected` is the length of this list. */
    readonly assignedTaskIds: readonly string[];
    /**
     * Task ids from `worktree.created` events that carry `data.taskId`, without duplicates.
     * `ready` counts these ids plus each legacy `worktree.created` event without a `taskId`.
     */
    readonly readyTaskIds: readonly string[];
  };
}

function computeBlockers(state: Omit<DelegationReadinessState, 'ready' | 'blockers'>): string[] {
  const blockers: string[] = [];

  if (!state.plan.approved) {
    blockers.push('plan not approved');
  }

  if (!state.plan.artifactPresent) {
    blockers.push('Plan artifact is missing');
  }

  if (state.plan.taskCount === 0) {
    blockers.push('no task.assigned events found — prepare_delegation announces the plan\'s tasks itself; give the workflow a task list (workflow update with tasks) or pass tasks, so there is something to announce');
  }

  const pendingWorktrees = state.worktrees.expected - state.worktrees.ready;
  if (state.worktrees.expected > 0 && pendingWorktrees > 0) {
    blockers.push(`${pendingWorktrees} worktrees pending`);
  }

  if (state.worktrees.expected === 0 && state.plan.taskCount > 0) {
    blockers.push('no worktrees expected');
  }

  if (state.worktrees.failed.length > 0) {
    blockers.push(`${state.worktrees.failed.length} worktrees failed baseline`);
  }

  return blockers;
}

function isReady(state: Omit<DelegationReadinessState, 'ready' | 'blockers'>): boolean {
  return (
    state.plan.approved &&
    state.plan.artifactPresent &&
    state.worktrees.ready >= state.worktrees.expected &&
    state.worktrees.expected > 0 &&
    state.worktrees.failed.length === 0
  );
}

function withReadiness(
  partial: Omit<DelegationReadinessState, 'ready' | 'blockers'>,
): DelegationReadinessState {
  const blockers = computeBlockers(partial);
  return {
    ...partial,
    ready: isReady(partial),
    blockers,
  };
}

function isPlanCoverageGate(gateName: string): boolean {
  return gateName.includes('plan-coverage');
}

function handleWorkflowTransition(
  state: DelegationReadinessState,
  event: WorkflowEvent,
): DelegationReadinessState {
  const data = event.data as { to?: string } | undefined;
  if (!data?.to) return state;

  if (data.to === 'plan-review') {
    return withReadiness({
      plan: { ...state.plan, approved: true },
      quality: state.quality,
      worktrees: state.worktrees,
    });
  }

  return state;
}

/**
 * Records the latest plan-coverage gate result as a pass rate of 1 or 0. A failure
 * with a reason adds the reason to `regressions`.
 */
function handleGateExecuted(
  state: DelegationReadinessState,
  event: WorkflowEvent,
): DelegationReadinessState {
  const data = event.data as {
    gateName?: string;
    passed?: boolean;
    details?: Record<string, unknown>;
  } | undefined;

  if (!data?.gateName) return state;
  if (!isPlanCoverageGate(data.gateName)) return state;

  const passed = data.passed ?? false;
  const reason = typeof data.details?.reason === 'string' ? data.details.reason : undefined;

  const gatePassRate = passed ? 1 : 0;

  const regressions = !passed && reason
    ? [...state.quality.regressions, reason]
    : [...state.quality.regressions];

  return withReadiness({
    plan: state.plan,
    quality: {
      queried: true,
      gatePassRate,
      regressions,
    },
    worktrees: state.worktrees,
  });
}

/** Adds a new `taskId` to `assignedTaskIds`. A repeated `taskId`, for example from a replay, does not count twice. */
function handleTaskAssigned(
  state: DelegationReadinessState,
  event: WorkflowEvent,
): DelegationReadinessState {
  const data = event.data as { taskId?: string } | undefined;
  if (!data?.taskId) return state;

  if (state.worktrees.assignedTaskIds.includes(data.taskId)) {
    return state;
  }

  const assignedTaskIds = [...state.worktrees.assignedTaskIds, data.taskId];

  return withReadiness({
    plan: {
      ...state.plan,
      taskCount: state.plan.taskCount + 1,
    },
    quality: state.quality,
    worktrees: {
      ...state.worktrees,
      expected: assignedTaskIds.length,
      assignedTaskIds,
    },
  });
}

/**
 * Counts a ready worktree. An event with a `taskId` counts once for each task id. A
 * legacy event without a `taskId` increments `ready` only, so a wave scope does not see it.
 */
function handleWorktreeCreated(
  state: DelegationReadinessState,
  event: WorkflowEvent,
): DelegationReadinessState {
  const data = event.data as { taskId?: string; worktreePath?: string } | undefined;
  const taskId = data?.taskId;

  if (taskId) {
    if (state.worktrees.readyTaskIds.includes(taskId)) {
      return state;
    }
    const readyTaskIds = [...state.worktrees.readyTaskIds, taskId];
    return withReadiness({
      plan: state.plan,
      quality: state.quality,
      worktrees: {
        ...state.worktrees,
        ready: state.worktrees.ready + 1,
        readyTaskIds,
      },
    });
  }

  return withReadiness({
    plan: state.plan,
    quality: state.quality,
    worktrees: {
      ...state.worktrees,
      ready: state.worktrees.ready + 1,
    },
  });
}

function handleWorktreeBaseline(
  state: DelegationReadinessState,
  event: WorkflowEvent,
): DelegationReadinessState {
  const data = event.data as {
    worktreePath?: string;
    status?: string;
  } | undefined;

  if (!data) return state;

  if (data.status === 'failed' && data.worktreePath) {
    return withReadiness({
      plan: state.plan,
      quality: state.quality,
      worktrees: {
        ...state.worktrees,
        failed: [...state.worktrees.failed, data.worktreePath],
      },
    });
  }

  return state;
}

/**
 * Reads `planReview.approved` and `artifacts.plan` from a patch, in nested or dot-path
 * form. Plan presence uses `isTypedArtifactReference` from `workflow/guards.ts`, so
 * readiness and the guards agree that a whitespace-only plan is absent.
 */
function handleStatePatched(
  state: DelegationReadinessState,
  event: WorkflowEvent,
): DelegationReadinessState {
  const data = event.data as { patch?: Record<string, unknown> } | undefined;
  if (!data?.patch) return state;

  const planReview = data.patch.planReview as { approved?: boolean } | undefined;
  const dotPathValue = data.patch['planReview.approved'];

  const approved = typeof dotPathValue === 'boolean'
    ? dotPathValue
    : typeof planReview?.approved === 'boolean'
      ? planReview.approved
      : undefined;

  const artifacts = data.patch.artifacts as { plan?: unknown } | undefined;
  const artifactsPlanDotPath = data.patch['artifacts.plan'];
  const artifactsPlanRaw = artifactsPlanDotPath !== undefined
    ? artifactsPlanDotPath
    : artifacts?.plan;
  const artifactPresent = artifactsPlanRaw === undefined
    ? undefined
    : isTypedArtifactReference(artifactsPlanRaw);

  const planChanged =
    (approved !== undefined && approved !== state.plan.approved) ||
    (artifactPresent !== undefined && artifactPresent !== state.plan.artifactPresent);

  if (planChanged) {
    return withReadiness({
      plan: {
        ...state.plan,
        ...(approved !== undefined ? { approved } : {}),
        ...(artifactPresent !== undefined ? { artifactPresent } : {}),
      },
      quality: state.quality,
      worktrees: state.worktrees,
    });
  }

  return state;
}

export interface ScopedWorktreesResult {
  readonly expected: number;
  readonly ready: number;
  readonly pending: number;
  readonly blockers: readonly string[];
}

/**
 * Recomputes worktree counts and blockers for a wave of tasks. With no filter, it
 * returns the global values.
 *
 * The projection counts each `task.assigned` event on the stream, so a small wave must
 * not wait on all worktrees. `prepare_delegation` and the `delegation_readiness` view
 * both use this helper, so they report the same readiness for a wave. It compares ids
 * after `canonicaliseTaskId`, because emitters and callers spell one id in different forms.
 *
 * The `"<N> worktrees pending"` blocker gets the wave count. It goes away when the wave
 * is ready, and the helper adds it when only the wave has pending worktrees. Other
 * blockers pass through, because they apply to the full stream.
 */
export function computeScopedWorktrees(
  readiness: DelegationReadinessState,
  tasksFilter: readonly { id: string }[] | undefined,
): ScopedWorktreesResult {
  if (!tasksFilter || tasksFilter.length === 0) {
    return {
      expected: readiness.worktrees.expected,
      ready: readiness.worktrees.ready,
      pending: Math.max(0, readiness.worktrees.expected - readiness.worktrees.ready),
      blockers: readiness.blockers,
    };
  }

  const canonicalReady = new Set(
    readiness.worktrees.readyTaskIds.map(canonicaliseTaskId),
  );
  const taskIds = tasksFilter.map(t => t.id);
  const readyInWave = taskIds.filter(id =>
    canonicalReady.has(canonicaliseTaskId(id)),
  ).length;
  const expected = taskIds.length;
  const pending = expected - readyInWave;

  let blockers = readiness.blockers.flatMap(blocker => {
    if (!/^\d+ worktrees pending$/.test(blocker)) {
      return [blocker];
    }
    if (pending === 0) {
      return [];
    }
    return [`${pending} worktrees pending`];
  });

  if (
    pending > 0 &&
    !blockers.some(b => /^\d+ worktrees pending$/.test(b))
  ) {
    blockers = [...blockers, `${pending} worktrees pending`];
  }

  return { expected, ready: readyInWave, pending, blockers };
}

/**
 * Applies {@link computeScopedWorktrees} to a readiness state. The counts, blockers,
 * and `ready` flag of the result describe the wave. With no filter, the state returns unchanged.
 */
export function scopeReadinessToWave(
  readiness: DelegationReadinessState,
  tasksFilter: readonly { id: string }[] | undefined,
): DelegationReadinessState {
  if (!tasksFilter || tasksFilter.length === 0) return readiness;
  const scoped = computeScopedWorktrees(readiness, tasksFilter);
  return {
    ...readiness,
    ready: scoped.blockers.length === 0,
    blockers: scoped.blockers,
    worktrees: {
      ...readiness.worktrees,
      expected: scoped.expected,
      ready: scoped.ready,
    },
  };
}

export const delegationReadinessProjection: ViewProjection<DelegationReadinessState> = {
  init: (): DelegationReadinessState => ({
    ready: false,
    blockers: [
      'plan not approved',
      'Plan artifact is missing',
      'no task.assigned events found — prepare_delegation announces the plan\'s tasks itself; give the workflow a task list (workflow update with tasks) or pass tasks, so there is something to announce',
    ],
    plan: { approved: false, taskCount: 0, artifactPresent: false },
    quality: { queried: false, gatePassRate: null, regressions: [] },
    worktrees: {
      expected: 0,
      ready: 0,
      failed: [],
      assignedTaskIds: [],
      readyTaskIds: [],
    },
  }),

  apply: (view: DelegationReadinessState, event: WorkflowEvent): DelegationReadinessState => {
    switch (event.type) {
      case 'workflow.transition':
        return handleWorkflowTransition(view, event);

      case 'gate.executed':
        return handleGateExecuted(view, event);

      case 'task.assigned':
        return handleTaskAssigned(view, event);

      default:
        break;
    }

    const eventType = event.type as string;

    if (eventType === 'state.patched') {
      return handleStatePatched(view, event);
    }

    if (eventType === 'worktree.created') {
      return handleWorktreeCreated(view, event);
    }

    if (eventType === 'worktree.baseline') {
      return handleWorktreeBaseline(view, event);
    }

    return view;
  },
};
