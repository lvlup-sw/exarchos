import type { ViewProjection } from './materializer.js';
import type { WorkflowEvent } from '../event-store/schemas.js';
import { deepMerge, isPlainObject } from '../workflow/state-store.js';

// ─── View Name Constant ────────────────────────────────────────────────────

export const WORKFLOW_STATE_VIEW = 'workflow-state';

// ─── Initial Phase by Workflow Type ────────────────────────────────────────
// Kept in sync with `getInitialPhase` in `workflow/state-machine.ts`. If a
// new built-in workflow type is added there, mirror it here so the
// event-sourced projection agrees with the file-based state store on the
// initial phase seeded by `workflow.started`.

const INITIAL_PHASE: Record<string, string> = {
  feature: 'ideate',
  debug: 'triage',
  refactor: 'explore',
  oneshot: 'plan',
};

// ─── WorkflowState View Shape ──────────────────────────────────────────────

export interface WorkflowStateView {
  version: string;
  featureId: string;
  workflowType: string;
  phase: string;
  createdAt: string;
  updatedAt: string;
  artifacts: { design: string | null; plan: string | null; pr: string | string[] | null };
  tasks: TaskEntry[];
  worktrees: Record<string, unknown>;
  reviews: Record<string, unknown>;
  integration: { passed: boolean } | null;
  synthesis: {
    integrationBranch: string | null;
    mergeOrder: string[];
    mergedBranches: string[];
    prUrl: string | string[] | null;
    prFeedback: unknown[];
  };
  _events: Array<{type: string; timestamp: string; data?: unknown}>;
  _version: number;
  _history: Record<string, string>;
  _checkpoint: CheckpointEntry;
  /**
   * The frozen verification obligation for the current phase (DR-13, epic #1546).
   * `phase.entered` resolve-then-freezes this from the resolver output at the
   * transition boundary; `phase.exited` stamps the aggregate gate status on
   * advance. Replaying the event log left-folds the same obligation a live HSM
   * observed — `kind` is read from the frozen event, never re-derived from the
   * phase name (#1208-class single-trigger). `null` until the first
   * `phase.entered` is folded.
   */
  phaseObligation: PhaseObligationEntry | null;
  [key: string]: unknown;
}

interface PhaseObligationEntry {
  phase: string;
  kind: string;
  resolver: string | null;
  resolvedGates: Array<{ family: string; gate: string }>;
  policySource: string;
  mode: string;
  enteredAt: string;
  exited: boolean;
  allRequiredGatesPassed: boolean | null;
}

interface TaskEntry {
  id: string;
  title: string;
  status: string;
  branch?: string;
  worktreePath?: string;
  completedAt?: string;
  [key: string]: unknown;
}

interface CheckpointEntry {
  timestamp: string;
  phase: string;
  summary: string;
  operationsSince: number;
  fixCycleCount: number;
  lastActivityTimestamp: string;
  staleAfterMinutes: number;
}

// ─── Helpers ───────────────────────────────────────────────────────────────

/** Immutably update a task by ID. Returns the original view if taskId not found. */
function updateTask(
  view: WorkflowStateView,
  taskId: string,
  updater: (task: TaskEntry) => TaskEntry,
): WorkflowStateView {
  const idx = view.tasks.findIndex((t) => t.id === taskId);
  if (idx < 0) return view;

  const updatedTasks = [...view.tasks];
  updatedTasks[idx] = updater(updatedTasks[idx]);
  return { ...view, tasks: updatedTasks };
}

// ─── Projection ────────────────────────────────────────────────────────────

export const workflowStateProjection: ViewProjection<WorkflowStateView> = {
  init: (): WorkflowStateView => ({
    version: '1.1',
    featureId: '',
    workflowType: 'feature',
    phase: 'ideate',
    createdAt: '',
    updatedAt: '',
    artifacts: { design: null, plan: null, pr: null },
    tasks: [],
    worktrees: {},
    reviews: {},
    integration: null,
    synthesis: {
      integrationBranch: null,
      mergeOrder: [],
      mergedBranches: [],
      prUrl: null,
      prFeedback: [],
    },
    _events: [],
    _version: 1,
    _history: {},
    _checkpoint: {
      timestamp: '',
      phase: '',
      summary: '',
      operationsSince: 0,
      fixCycleCount: 0,
      lastActivityTimestamp: '',
      staleAfterMinutes: 120,
    },
    phaseObligation: null,
  }),

  apply: (view: WorkflowStateView, event: WorkflowEvent): WorkflowStateView => {
    switch (event.type) {
      // ── Workflow Lifecycle ──────────────────────────────────────────────

      case 'workflow.started': {
        const data = event.data as {
          featureId?: string;
          workflowType?: string;
          synthesisPolicy?: 'always' | 'never' | 'on-request';
        } | undefined;
        if (!data) return view;

        const workflowType = data.workflowType ?? view.workflowType;
        const phase = INITIAL_PHASE[workflowType] ?? view.phase;

        // Oneshot-only: surface the init-time `synthesisPolicy` on the
        // projected view under `state.oneshot.synthesisPolicy` so the
        // `synthesisOptedIn` / `synthesisOptedOut` guards see the same
        // value after rematerialization that they would on a fresh state
        // file. The guards read `state.oneshot.synthesisPolicy` directly
        // via `readSynthesisPolicy` in `workflow/guards.ts`.
        const nextOneshot =
          workflowType === 'oneshot' && data.synthesisPolicy !== undefined
            ? {
                ...((view as unknown as Record<string, unknown>).oneshot as
                  | Record<string, unknown>
                  | undefined),
                synthesisPolicy: data.synthesisPolicy,
              }
            : undefined;

        return {
          ...view,
          featureId: data.featureId ?? view.featureId,
          workflowType,
          phase,
          createdAt: event.timestamp,
          updatedAt: event.timestamp,
          ...(nextOneshot !== undefined ? { oneshot: nextOneshot } : {}),
        };
      }

      case 'workflow.transition': {
        const data = event.data as {
          to?: string;
          historyUpdates?: Record<string, string>;
        } | undefined;
        if (!data?.to) return view;

        const newHistory = data.historyUpdates
          ? { ...view._history, ...data.historyUpdates }
          : view._history;

        return {
          ...view,
          phase: data.to,
          updatedAt: event.timestamp,
          _history: newHistory,
        };
      }

      // ── Phase-Kind Resolve-then-Freeze (DR-13, epic #1546) ──────────────
      // `phase.entered` freezes the obligation the executeTransition boundary
      // resolved for the target kind; `phase.exited` stamps the aggregate gate
      // status on advance. `kind` is read straight from the frozen event (never
      // re-derived from the phase name), so a left-fold of the log reconstructs
      // the same obligation a live HSM observed (#1208-class single-trigger).

      case 'phase.entered': {
        const data = event.data as {
          phase?: string;
          kind?: string;
          resolver?: string | null;
          resolvedGates?: Array<{ family: string; gate: string }>;
          policySource?: string;
          mode?: string;
        } | undefined;
        if (!data?.phase || !data.kind) return view;

        return {
          ...view,
          updatedAt: event.timestamp,
          phaseObligation: {
            phase: data.phase,
            kind: data.kind,
            resolver: data.resolver ?? null,
            resolvedGates: data.resolvedGates ?? [],
            policySource: data.policySource ?? 'builtin',
            mode: data.mode ?? 'enforce',
            enteredAt: event.timestamp,
            exited: false,
            allRequiredGatesPassed: null,
          },
        };
      }

      case 'phase.exited': {
        const data = event.data as {
          phase?: string;
          allRequiredGatesPassed?: boolean;
        } | undefined;
        // Stamp the in-flight obligation only. Absent a frozen obligation (e.g.
        // replaying a pre-DR-13 log) there is nothing to fold.
        if (!data?.phase || view.phaseObligation === null) return view;

        return {
          ...view,
          updatedAt: event.timestamp,
          phaseObligation: {
            ...view.phaseObligation,
            exited: true,
            allRequiredGatesPassed: data.allRequiredGatesPassed ?? null,
          },
        };
      }

      case 'workflow.checkpoint': {
        const data = event.data as {
          phase?: string;
          counter?: number;
        } | undefined;
        if (!data?.phase) return view;

        return {
          ...view,
          _checkpoint: {
            ...view._checkpoint,
            phase: data.phase,
            timestamp: event.timestamp,
            lastActivityTimestamp: event.timestamp,
            ...(data.counter !== undefined ? { operationsSince: data.counter } : {}),
          },
        };
      }

      // ── Task Events ────────────────────────────────────────────────────

      case 'task.assigned': {
        const data = event.data as {
          taskId?: string;
          title?: string;
          branch?: string;
          worktree?: string;
        } | undefined;
        if (!data?.taskId) return view;

        const newTask: TaskEntry = {
          id: data.taskId,
          title: data.title ?? '',
          status: 'pending',
          branch: data.branch,
          worktreePath: data.worktree,
        };

        const existingIndex = view.tasks.findIndex((t) => t.id === data.taskId);
        if (existingIndex >= 0) {
          // Update existing task
          const updatedTasks = [...view.tasks];
          updatedTasks[existingIndex] = { ...updatedTasks[existingIndex], ...newTask };
          return { ...view, tasks: updatedTasks };
        }

        return { ...view, tasks: [...view.tasks, newTask] };
      }

      case 'task.completed': {
        const data = event.data as { taskId?: string } | undefined;
        if (!data?.taskId) return view;
        return updateTask(view, data.taskId, (t) => ({
          ...t,
          status: 'complete',
          completedAt: event.timestamp,
        }));
      }

      case 'task.failed': {
        const data = event.data as { taskId?: string } | undefined;
        if (!data?.taskId) return view;
        return updateTask(view, data.taskId, (t) => ({ ...t, status: 'failed' }));
      }

      // ── Stack/Review Events ────────────────────────────────────────────

      case 'stack.position-filled': {
        const data = event.data as {
          taskId?: string;
          branch?: string;
        } | undefined;
        if (!data?.taskId) return view;
        return updateTask(view, data.taskId, (t) => ({
          ...t,
          ...(data.branch !== undefined ? { branch: data.branch } : {}),
        }));
      }

      case 'review.routed': {
        const data = event.data as { pr?: number } | undefined;
        if (data?.pr === undefined) return view;

        return {
          ...view,
          reviews: {
            ...view.reviews,
            [String(data.pr)]: data,
          },
        };
      }

      // ── State Patch (generic field updates) ────────────────────────────

      case 'state.patched': {
        const data = event.data as { patch?: unknown } | undefined;
        if (!data?.patch || !isPlainObject(data.patch)) return view;

        return deepMerge(
          view as unknown as Record<string, unknown>,
          data.patch as Record<string, unknown>,
        ) as unknown as WorkflowStateView;
      }

      // ── Observability-only (return state unchanged) ────────────────────

      case 'team.spawned':
      case 'team.disbanded':
      case 'synthesize.requested':
      case 'workflow.pruned':
        return {
          ...view,
          _events: [...(view._events ?? []), { type: event.type, timestamp: event.timestamp, data: event.data }],
        };

      case 'team.task.assigned':
      case 'team.task.completed':
      case 'team.task.failed':
      case 'team.task.planned':
      case 'team.teammate.dispatched':
      case 'tool.invoked':
      case 'tool.completed':
      case 'tool.errored':
      case 'benchmark.completed':
      case 'quality.regression':
      case 'gate.executed':
      case 'review.finding':
      case 'review.escalated':
      case 'workflow.fix-cycle':
      case 'workflow.guard-failed':
      case 'workflow.compound-entry':
      case 'workflow.compound-exit':
      case 'workflow.compensation':
      case 'workflow.circuit-open':
      case 'workflow.cas-failed':
      case 'workflow.cancel':
      case 'workflow.cleanup':
      case 'stack.restacked':
      case 'stack.enqueued':
      case 'task.claimed':
      case 'task.progressed':
        return view;

      // ── Default (unrecognized event types) ─────────────────────────────

      default:
        return view;
    }
  },
};
