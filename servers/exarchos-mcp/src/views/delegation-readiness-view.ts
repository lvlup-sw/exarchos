import type { ViewProjection } from './materializer.js';
import type { WorkflowEvent } from '../event-store/schemas.js';
import { canonicaliseTaskId } from '../utils/task-id.js';

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
    /**
     * DR-T-2 (#1206): per-task ID tracking for wave scoping. Populated by
     * `task.assigned` events; deduplicated. `expected` is derived from
     * `assignedTaskIds.length` and kept for back-compat consumers.
     */
    readonly assignedTaskIds: readonly string[];
    /**
     * DR-T-2 (#1206): per-task ID tracking for wave scoping. Populated by
     * `worktree.created` events that carry `data.taskId`; deduplicated.
     * `ready` is derived from `readyTaskIds.length` plus a fallback
     * counter for legacy events without taskId. See handleWorktreeCreated.
     */
    readonly readyTaskIds: readonly string[];
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

  // DR-T-2 (#1206): dedup by taskId. Multiple `task.assigned` events with
  // the same taskId (e.g. from rehydration replay) must not double-count.
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
      expected: assignedTaskIds.length, // derived
      assignedTaskIds,
    },
  });
}

function handleWorktreeCreated(
  state: DelegationReadinessState,
  event: WorkflowEvent,
): DelegationReadinessState {
  const data = event.data as { taskId?: string; worktreePath?: string } | undefined;
  const taskId = data?.taskId;

  // DR-T-2 (#1206): when the event carries a taskId, dedupe and add to
  // readyTaskIds. When it doesn't (legacy), bump the count via fallback
  // delta so totals stay sensible but per-task scoping skips it.
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

  // Legacy: no taskId on event. Bump count only.
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

// ─── Wave Scoping (WFQ-002 / DR-T-2 #1206, fix-005 #1213) ───────────────────

export interface ScopedWorktreesResult {
  readonly expected: number;
  readonly ready: number;
  readonly pending: number;
  readonly blockers: readonly string[];
}

/**
 * Recompute worktree counts and blockers against a wave subset.
 *
 * WFQ-002: the projection accumulates `expected` from EVERY historical
 * `task.assigned` event on the stream. A four-task wave inside a seventeen-task
 * workflow must NOT wait on seventeen worktrees, so every readiness consumer
 * scopes through this one helper. It lives beside the projection — not inside a
 * single consumer — so `prepare_delegation` and the `delegation_readiness` view
 * action cannot report different readiness for the same wave.
 *
 * Returns:
 * - `expected` — the size of the wave (or the projection's expected when
 *   no filter is provided).
 * - `ready` — count of wave members whose worktree is in `readyTaskIds`
 *   (or the projection's global `ready` when no filter is provided).
 * - `pending` — `expected - ready`.
 * - `blockers` — `readiness.blockers` with the canonical
 *   `"<N> worktrees pending"` message rewritten to the wave-scoped count
 *   (dropped entirely when the wave is fully ready). Other worktree-class
 *   blockers (e.g., "no worktrees expected", baseline failures) pass
 *   through unchanged — they're stream-global signals, not wave-scoped.
 *
 * Pure: no I/O, no shared state.
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

  // F19 (#1213): canonicalise IDs before comparing. Callers may pass
  // `T-001`/`T001`/`001` interchangeably; the projection's `readyTaskIds`
  // preserves the form recorded by upstream emitters. Without
  // canonicalisation a wave addressed as `T-001` reports "1 worktrees
  // pending" even when the projection holds `T001` as ready.
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
    // Only touch the canonical "<N> worktrees pending" message; pass
    // through other worktree-class blockers (failed, no-worktrees-expected).
    if (!/^\d+ worktrees pending$/.test(blocker)) {
      return [blocker];
    }
    if (pending === 0) {
      return []; // wave is complete — drop the blocker
    }
    return [`${pending} worktrees pending`];
  });

  // F-iter3 (#1213, sentry HIGH r3186305844): if the global readiness has no
  // "N worktrees pending" blocker (because the global state was ready) but
  // the wave subset still has pending worktrees, synthesise one. Without
  // this the caller sees an empty blockers array and dispatches prematurely
  // (e.g. mixed legacy/modern `worktree.created` events leave the global
  // view consistent but the wave-projection is not).
  if (
    pending > 0 &&
    !blockers.some(b => /^\d+ worktrees pending$/.test(b))
  ) {
    blockers = [...blockers, `${pending} worktrees pending`];
  }

  return { expected, ready: readyInWave, pending, blockers };
}

/**
 * Apply {@link computeScopedWorktrees} to a materialized readiness state,
 * returning a state whose visible counters, blockers, and `ready` flag all
 * describe the requested wave. Passing no filter returns the state unchanged.
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
