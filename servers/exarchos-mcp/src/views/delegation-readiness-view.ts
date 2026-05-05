import type { ViewProjection } from './materializer.js';
import type { WorkflowEvent } from '../event-store/schemas.js';

// ─── View Name Constant ────────────────────────────────────────────────────

export const DELEGATION_READINESS_VIEW = 'delegation-readiness';

// ─── View State Interface ─────────────────────────────────────────────────

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
  };
}

// ─── Blocker Computation ────────────────────────────────────────────────────

function computeBlockers(state: Omit<DelegationReadinessState, 'ready' | 'blockers'>): string[] {
  const blockers: string[] = [];

  if (!state.plan.approved) {
    blockers.push('plan not approved');
  }

  if (!state.plan.artifactPresent) {
    blockers.push('Plan artifact is missing');
  }

  if (state.plan.taskCount === 0) {
    blockers.push('no task.assigned events found — emit task.assigned events for each task via exarchos_event before calling prepare_delegation');
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

// ─── Gate Name Matching ─────────────────────────────────────────────────────

function isPlanCoverageGate(gateName: string): boolean {
  return gateName.includes('plan-coverage');
}

// ─── Event Handlers ────────────────────────────────────────────────────────

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

  // For plan-coverage gates, track the latest pass/fail result
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

function handleTaskAssigned(
  state: DelegationReadinessState,
  event: WorkflowEvent,
): DelegationReadinessState {
  const data = event.data as { taskId?: string } | undefined;
  if (!data?.taskId) return state;

  return withReadiness({
    plan: {
      ...state.plan,
      taskCount: state.plan.taskCount + 1,
    },
    quality: state.quality,
    worktrees: {
      ...state.worktrees,
      expected: state.worktrees.expected + 1,
    },
  });
}

function handleWorktreeCreated(
  state: DelegationReadinessState,
  _event: WorkflowEvent,
): DelegationReadinessState {
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

function handleStatePatched(
  state: DelegationReadinessState,
  event: WorkflowEvent,
): DelegationReadinessState {
  const data = event.data as { patch?: Record<string, unknown> } | undefined;
  if (!data?.patch) return state;

  // Resolve approved value from nested or dot-path form
  const planReview = data.patch.planReview as { approved?: boolean } | undefined;
  const dotPathValue = data.patch['planReview.approved'];

  const approved = typeof dotPathValue === 'boolean'
    ? dotPathValue
    : typeof planReview?.approved === 'boolean'
      ? planReview.approved
      : undefined;

  // DR-T-1 (#1205): Resolve artifacts.plan presence from nested or dot-path form.
  // Truthy non-empty string = present; empty string = absent.
  const artifacts = data.patch.artifacts as { plan?: unknown } | undefined;
  const artifactsPlanDotPath = data.patch['artifacts.plan'];
  const artifactsPlanRaw = artifactsPlanDotPath !== undefined
    ? artifactsPlanDotPath
    : artifacts?.plan;
  const artifactPresent = artifactsPlanRaw === undefined
    ? undefined
    : typeof artifactsPlanRaw === 'string' && artifactsPlanRaw.length > 0;

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

// ─── Projection ────────────────────────────────────────────────────────────

export const delegationReadinessProjection: ViewProjection<DelegationReadinessState> = {
  init: (): DelegationReadinessState => ({
    ready: false,
    blockers: [
      'plan not approved',
      'Plan artifact is missing',
      'no task.assigned events found — emit task.assigned events for each task via exarchos_event before calling prepare_delegation',
    ],
    plan: { approved: false, taskCount: 0, artifactPresent: false },
    quality: { queried: false, gatePassRate: null, regressions: [] },
    worktrees: { expected: 0, ready: 0, failed: [] },
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

    // Handle event types not in the schema enum via string comparison
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
