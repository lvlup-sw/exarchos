/**
 * The `workflow-state` view: a fold of the event log into the workflow state.
 *
 * The state-mutation helpers come from the leaf module `workflow/state-mutation.ts`, not
 * from `state-store.ts`. `state-store.ts` imports this projection for
 * `reconcileFromEvents`, so the leaf import keeps that edge one-way and prevents a
 * runtime import cycle.
 */

import type { ViewProjection } from './materializer.js';
import type {
  AdmissionContradictionRecorded,
  AdmissionEvidenceRecorded,
  WorkflowEvent,
  EventType,
} from '../../events/schemas.js';
import { isBuiltInEventType } from '../../events/schemas.js';
import { getInitialPhase, isBuiltInWorkflowType } from '../../workflow/state-machine.js';
import {
  selectEvidence,
  type EvidenceContradiction,
  type EvidenceSelectionDiagnostic,
  type EvidenceSupersession,
} from '../../workflow/admission/select-evidence.js';
import {
  foldPhaseAttemptAdmission,
  type AdmissionFoldDiagnostic,
  type AdmissionFoldIntegrity,
  type PhaseAttemptAdmissionState,
} from '../../workflow/admission/phase-attempt-state.js';
import { isPlainObject, applyDotPath, StateStoreError } from '../../workflow/state-mutation.js';
import { ErrorCode } from '../../workflow/schemas.js';
import type { DesignDepth } from '../../workflow/plan-depth-policy.js';

export const WORKFLOW_STATE_VIEW = 'workflow-state';

export interface WorkflowStateView {
  version: string;
  featureId: string;
  workflowType: string;
  phase: string;
  /** Active phase-entry identity, sourced only from persisted lifecycle data. */
  phaseAttemptId?: string;
  /**
   * The timestamp of the first `workflow.started` fold. A re-fold keeps a stamped value,
   * so the fold stays idempotent. The `''` from `init()` counts as unset.
   */
  createdAt: string;
  updatedAt: string;
  artifacts: { design: string | null; plan: string | null; pr: string | string[] | null };
  tasks: TaskEntry[];
  worktrees: Record<string, unknown>;
  /**
   * Review entries. `review.routed` stores its data under the PR number. The
   * `mutation-adequacy` gate result becomes `reviews['mutation-adequacy']` with status
   * `pass`, so `allReviewsPassed` finds the dimension. The `passed`, `mutationScore`,
   * `noCoverage`, `skipped`, and `degraded` fields come from the gate result. A
   * `degraded` run has no score, and `allReviewsPassed` fails it under block enforcement.
   */
  reviews: Record<string, unknown>;
  integration: { passed: boolean } | null;
  synthesis: {
    integrationBranch: string | null;
    mergeOrder: string[];
    mergedBranches: string[];
    prUrl: string | string[] | null;
    prFeedback: unknown[];
  };
  /** Records of the `team.spawned`, `team.disbanded`, `synthesize.requested`, and `workflow.pruned` events. */
  _events: Array<{type: string; timestamp: string; data?: unknown}>;
  _version: number;
  _history: Record<string, string>;
  _checkpoint: CheckpointEntry;
  /**
   * The frozen verification obligation for the current phase. `phase.entered` freezes
   * the resolver output of the transition, and `phase.exited` adds the gate status to an
   * existing obligation. The fold reads `kind` from the event, not from the phase name.
   * So a replay gives the same obligation that the live HSM saw. The value is `null`
   * until the first `phase.entered`.
   */
  phaseObligation: PhaseObligationEntry | null;
  /**
   * Proof data for audit and shadow use only. The histories are append-only event data.
   * The derived arrays are a deterministic selection, and they do not change the phase.
   */
  admissionProof: AdmissionProofView;
  /**
   * The frozen planning depth of the feature, the feature-level analog of the task
   * `riskTier`. The PLAN `phase.entered` event freezes it, and the plan-structure gate
   * resolver reads it. A `phase.entered` event without the field does not clear it.
   * It is absent until the first PLAN `phase.entered`, and readers then use `'standard'`.
   */
  designDepth?: DesignDepth;
  /**
   * The terminal merge-orchestrator state, so `resolveWorkflowState` can rebuild it.
   * Each terminal merge event replaces the block, so no field of an earlier phase stays.
   * A `merge.preflight` writes a block (`aborted`) only when it failed. `merge.executed` gives
   * `completed`. `merge.recovered` and the legacy `merge.rollback` give `rolled-back`.
   * The field is absent until the first terminal merge event.
   */
  mergeOrchestrator?: MergeOrchestratorView;
  /**
   * Fields without a declared type. The `revisionsExhausted` guard reads
   * `planReview.revisionCount`. `workflow.plan-revision` adds 1 to it.
   * `workflow.plan-review-dispatched` sets it to the max of the count and its 0-based
   * `ordinal`. So the first review is revision 0, and a retry does not count twice.
   *
   * `workflow.started` copies `oneshot.synthesisPolicy`, so the synthesis guards read
   * the same value after a rebuild.
   */
  [key: string]: unknown;
}

interface MergeOrchestratorView {
  phase: 'pending' | 'executing' | 'completed' | 'rolled-back' | 'aborted';
  sourceBranch?: string;
  targetBranch?: string;
  taskId?: string;
  strategy?: 'squash' | 'rebase' | 'merge' | undefined;
  rollbackSha?: string;
  mergeSha?: string;
  reason?: 'merge-failed' | 'verification-failed' | 'timeout' | undefined;
  rollbackError?: string;
  recoveryError?: 'reset-keep-blocked' | 'reset-failed' | 'unexpected-mid-merge-drift' | undefined;
  abortReason?: string;
  preflight?: unknown;
  [key: string]: unknown;
}

interface PhaseObligationEntry {
  phase: string;
  kind: string;
  resolver: string | null;
  resolvedGates: Array<{ family: string; gate: string }>;
  policySource: string;
  mode: string;
  /** The frozen POLA posture (trust tier) for the phase kind. */
  posture: string;
  /**
   * The risk tier at which the obligation was resolved, frozen with it. Later
   * resolutions read it as the authority. It is absent on old logs, and the fold does
   * not invent a default, because an invented value is the defect.
   */
  riskTier?: string;
  boundaryTouching?: boolean;
  enteredAt: string;
  exited: boolean;
  allRequiredGatesPassed: boolean | null;
}

interface TaskEntry {
  id: string;
  title: string;
  status: string;
  branch?: string | undefined;
  worktreePath?: string | undefined;
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

export interface AdmissionProofView {
  evidenceHistory: readonly AdmissionEvidenceRecorded[];
  contradictionHistory: readonly AdmissionContradictionRecorded[];
  activeEvidence: readonly AdmissionEvidenceRecorded[];
  supersessions: readonly EvidenceSupersession[];
  contradictions: readonly EvidenceContradiction[];
  diagnostics: readonly EvidenceSelectionDiagnostic[];
  /**
   * Raw `admission.requirement-resolved` payloads, append-only. They stay `unknown`,
   * because the attempt fold parses them on each rebuild and reports a malformed fact.
   * So a replay gives the frozen set that the writer resolved, not what current policy gives.
   */
  requirementHistory: readonly unknown[];
  /** Raw `admission.transition-decided` payloads, append-only. */
  decisionHistory: readonly unknown[];
  /**
   * Per-phase-attempt frozen requirement set, bound evidence, and decision,
   * reconstructed from the histories above with no policy handle and no I/O.
   */
  phaseAttempts: readonly PhaseAttemptAdmissionState[];
  /** Persisted admission facts the attempt fold refused to trust. */
  phaseAttemptDiagnostics: readonly AdmissionFoldDiagnostic[];
  /** `'contested'` whenever any admission fact was quarantined. */
  phaseAttemptIntegrity: AdmissionFoldIntegrity;
}

function emptyAdmissionProof(): AdmissionProofView {
  return {
    evidenceHistory: [],
    contradictionHistory: [],
    activeEvidence: [],
    supersessions: [],
    contradictions: [],
    diagnostics: [],
    requirementHistory: [],
    decisionHistory: [],
    phaseAttempts: [],
    phaseAttemptDiagnostics: [],
    phaseAttemptIntegrity: 'intact',
  };
}

/**
 * The admission proof of a view, with each absent field set to its empty seed.
 * Reconciliation can apply a new proof event to a state older than the proof block, or
 * older than the phase-attempt fields. A fold must not read `undefined` from that state.
 */
function admissionProofOf(view: WorkflowStateView): AdmissionProofView {
  const seed = emptyAdmissionProof();
  const proof: Partial<AdmissionProofView> | undefined = view.admissionProof;
  if (proof === undefined) return seed;
  return {
    evidenceHistory: proof.evidenceHistory ?? seed.evidenceHistory,
    contradictionHistory: proof.contradictionHistory ?? seed.contradictionHistory,
    activeEvidence: proof.activeEvidence ?? seed.activeEvidence,
    supersessions: proof.supersessions ?? seed.supersessions,
    contradictions: proof.contradictions ?? seed.contradictions,
    diagnostics: proof.diagnostics ?? seed.diagnostics,
    requirementHistory: proof.requirementHistory ?? seed.requirementHistory,
    decisionHistory: proof.decisionHistory ?? seed.decisionHistory,
    phaseAttempts: proof.phaseAttempts ?? seed.phaseAttempts,
    phaseAttemptDiagnostics:
      proof.phaseAttemptDiagnostics ?? seed.phaseAttemptDiagnostics,
    phaseAttemptIntegrity:
      proof.phaseAttemptIntegrity ?? seed.phaseAttemptIntegrity,
  };
}

/**
 * Recomputes the frozen fold of each phase attempt from the append-only proof histories.
 * Each fold starts from the history, so a partial re-fold and a replay from zero agree.
 */
function foldPhaseAttempts(
  proof: AdmissionProofView,
  overrides: {
    readonly requirementHistory?: readonly unknown[];
    readonly evidenceHistory?: readonly unknown[];
    readonly decisionHistory?: readonly unknown[];
  },
): Pick<
  AdmissionProofView,
  'phaseAttempts' | 'phaseAttemptDiagnostics' | 'phaseAttemptIntegrity'
> {
  const fold = foldPhaseAttemptAdmission({
    requirementEvents: overrides.requirementHistory ?? proof.requirementHistory,
    evidenceEvents: overrides.evidenceHistory ?? proof.evidenceHistory,
    decisionEvents: overrides.decisionHistory ?? proof.decisionHistory,
  });
  return {
    phaseAttempts: fold.attempts,
    phaseAttemptDiagnostics: fold.diagnostics,
    phaseAttemptIntegrity: fold.integrity,
  };
}

/** Immutably update a task by ID. Returns the original view if taskId not found. */
function updateTask(
  view: WorkflowStateView,
  taskId: string,
  updater: (task: TaskEntry) => TaskEntry,
): WorkflowStateView {
  const idx = view.tasks.findIndex((t) => t.id === taskId);
  if (idx < 0) return view;

  const updatedTasks = [...view.tasks];
  const existing = updatedTasks[idx];
  if (existing === undefined) return view;
  updatedTasks[idx] = updater(existing);
  return { ...view, tasks: updatedTasks };
}

/**
 * The projection of the `workflow-state` view. For a built-in workflow type,
 * `workflow.started` takes the initial phase from `getInitialPhase`. A custom type keeps
 * the seed phase, because `getInitialPhase` throws for an unknown type.
 */
export const workflowStateProjection: ViewProjection<WorkflowStateView> = {
  init: (): WorkflowStateView => ({
    version: '1.1',
    featureId: '',
    workflowType: 'feature',
    phase: 'plan',
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
    admissionProof: emptyAdmissionProof(),
  }),

  /**
   * Folds one event. A custom event type returns the view unchanged. A built-in type
   * narrows to `EventType`, so the `never` default makes a missing case a compile error.
   * Each built-in type that does not change the state has its own no-op case.
   *
   * `state.patched` applies each dot-path key to a clone with `applyDotPath`, as the file
   * write does, so an array-index path keeps the other elements. An empty patch returns
   * the same reference, because `reconcileFromEvents` counts a new reference as a change.
   * A reserved-field path is skipped on replay, and each other error throws.
   */
  apply: (view: WorkflowStateView, event: WorkflowEvent): WorkflowStateView => {
    if (!isBuiltInEventType(event.type)) return view;
    const type: EventType = event.type as EventType;
    switch (type) {
      case 'workflow.started': {
        const data = event.data as {
          featureId?: string;
          workflowType?: string;
          synthesisPolicy?: 'always' | 'never' | 'on-request';
          phaseAttemptId?: string;
        } | undefined;
        if (!data) return view;

        const workflowType = data.workflowType ?? view.workflowType;
        const phase = isBuiltInWorkflowType(workflowType)
          ? getInitialPhase(workflowType)
          : view.phase;

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
          ...(data.phaseAttemptId !== undefined
            ? { phaseAttemptId: data.phaseAttemptId }
            : {}),
          createdAt: view.createdAt || event.timestamp,
          updatedAt: event.timestamp,
          ...(nextOneshot !== undefined ? { oneshot: nextOneshot } : {}),
        };
      }

      case 'workflow.transition': {
        const data = event.data as {
          to?: string;
          historyUpdates?: Record<string, string>;
          phaseAttemptId?: string;
        } | undefined;
        if (!data?.to) return view;

        const newHistory = data.historyUpdates
          ? { ...view._history, ...data.historyUpdates }
          : view._history;

        return {
          ...view,
          phase: data.to,
          ...(data.phaseAttemptId !== undefined
            ? { phaseAttemptId: data.phaseAttemptId }
            : {}),
          updatedAt: event.timestamp,
          _history: newHistory,
        };
      }

      case 'phase.entered': {
        const data = event.data as {
          phase?: string;
          kind?: string;
          resolver?: string | null;
          resolvedGates?: Array<{ family: string; gate: string }>;
          policySource?: string;
          mode?: string;
          posture?: string;
          designDepth?: DesignDepth;
          riskTier?: string;
          boundaryTouching?: boolean;
        } | undefined;
        if (!data?.phase || !data.kind) return view;

        return {
          ...view,
          updatedAt: event.timestamp,
          ...(data.designDepth ? { designDepth: data.designDepth } : {}),
          phaseObligation: {
            phase: data.phase,
            kind: data.kind,
            resolver: data.resolver ?? null,
            resolvedGates: data.resolvedGates ?? [],
            policySource: data.policySource ?? 'builtin',
            mode: data.mode ?? 'enforce',
            posture: data.posture ?? 'read-only',
            ...(data.riskTier !== undefined ? { riskTier: data.riskTier } : {}),
            ...(typeof data.boundaryTouching === 'boolean'
              ? { boundaryTouching: data.boundaryTouching }
              : {}),
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

      case 'workflow.plan-revision': {
        const priorPlanReview = isPlainObject(view.planReview)
          ? (view.planReview as Record<string, unknown>)
          : {};
        const rawCount = priorPlanReview.revisionCount;
        const currentCount =
          typeof rawCount === 'number' && Number.isFinite(rawCount)
            ? rawCount
            : 0;
        return {
          ...view,
          planReview: {
            ...priorPlanReview,
            revisionCount: currentCount + 1,
          },
        };
      }

      case 'workflow.plan-review-dispatched': {
        const data = event.data as { ordinal?: number } | undefined;
        const rawOrdinal = data?.ordinal;
        const ordinal =
          typeof rawOrdinal === 'number' && Number.isFinite(rawOrdinal) && rawOrdinal >= 0
            ? rawOrdinal
            : 0;
        const priorPlanReview = isPlainObject(view.planReview)
          ? (view.planReview as Record<string, unknown>)
          : {};
        const rawCount = priorPlanReview.revisionCount;
        const currentCount =
          typeof rawCount === 'number' && Number.isFinite(rawCount)
            ? rawCount
            : 0;
        return {
          ...view,
          planReview: {
            ...priorPlanReview,
            revisionCount: Math.max(currentCount, ordinal),
          },
        };
      }

      case 'gate.executed': {
        const data = event.data as
          | {
              gateName?: string;
              layer?: string;
              passed?: boolean;
              details?: Record<string, unknown>;
            }
          | undefined;
        if (data?.gateName !== 'mutation-adequacy') return view;
        const details = isPlainObject(data.details)
          ? (data.details as Record<string, unknown>)
          : {};
        const rawScore = details.mutationScore;
        const rawNoCoverage = details.noCoverage;
        return {
          ...view,
          reviews: {
            ...view.reviews,
            'mutation-adequacy': {
              status: 'pass',
              gateName: 'mutation-adequacy',
              passed: data.passed === true,
              ...(typeof rawScore === 'number' ? { mutationScore: rawScore } : {}),
              ...(typeof rawNoCoverage === 'number' ? { noCoverage: rawNoCoverage } : {}),
              ...(details.skipped === true ? { skipped: true } : {}),
              ...(details.degraded === true ? { degraded: true } : {}),
            },
          },
        };
      }

      case 'merge.preflight': {
        const data = event.data as Record<string, unknown> | undefined;
        if (!data) return view;
        if (data.passed === false) {
          return {
            ...view,
            updatedAt: event.timestamp,
            mergeOrchestrator: {
              phase: 'aborted',
              preflight: data,
              abortReason: 'preflight-failed',
              ...(data.taskId !== undefined ? { taskId: data.taskId as string } : {}),
              ...(data.sourceBranch !== undefined ? { sourceBranch: data.sourceBranch as string } : {}),
              ...(data.targetBranch !== undefined ? { targetBranch: data.targetBranch as string } : {}),
            },
          };
        }
        return view;
      }

      case 'merge.executed': {
        const data = event.data as Record<string, unknown> | undefined;
        if (!data) return view;
        return {
          ...view,
          updatedAt: event.timestamp,
          mergeOrchestrator: {
            phase: 'completed',
            ...(data.taskId !== undefined ? { taskId: data.taskId as string } : {}),
            ...(data.sourceBranch !== undefined ? { sourceBranch: data.sourceBranch as string } : {}),
            ...(data.targetBranch !== undefined ? { targetBranch: data.targetBranch as string } : {}),
            ...(data.strategy !== undefined ? { strategy: data.strategy as MergeOrchestratorView['strategy'] } : {}),
            ...(data.mergeSha !== undefined ? { mergeSha: data.mergeSha as string } : {}),
            ...(data.rollbackSha !== undefined ? { rollbackSha: data.rollbackSha as string } : {}),
          },
        };
      }

      case 'merge.rollback': {
        const data = event.data as Record<string, unknown> | undefined;
        if (!data) return view;
        return {
          ...view,
          updatedAt: event.timestamp,
          mergeOrchestrator: {
            phase: 'rolled-back',
            ...(data.taskId !== undefined ? { taskId: data.taskId as string } : {}),
            ...(data.sourceBranch !== undefined ? { sourceBranch: data.sourceBranch as string } : {}),
            ...(data.targetBranch !== undefined ? { targetBranch: data.targetBranch as string } : {}),
            ...(data.rollbackSha !== undefined ? { rollbackSha: data.rollbackSha as string } : {}),
            ...(data.reason !== undefined ? { reason: data.reason as MergeOrchestratorView['reason'] } : {}),
            ...(data.recoveryError !== undefined ? { recoveryError: data.recoveryError as MergeOrchestratorView['recoveryError'] } : {}),
            ...(data.rollbackError !== undefined ? { rollbackError: data.rollbackError as string } : {}),
          },
        };
      }

      case 'merge.recovered': {
        const data = event.data as Record<string, unknown> | undefined;
        if (!data) return view;
        return {
          ...view,
          updatedAt: event.timestamp,
          mergeOrchestrator: {
            phase: 'rolled-back',
            ...(data.taskId !== undefined ? { taskId: data.taskId as string } : {}),
            ...(data.sourceBranch !== undefined ? { sourceBranch: data.sourceBranch as string } : {}),
            ...(data.targetBranch !== undefined ? { targetBranch: data.targetBranch as string } : {}),
            ...(data.recoveryPointSha !== undefined ? { rollbackSha: data.recoveryPointSha as string } : {}),
            ...(data.reason !== undefined ? { reason: data.reason as MergeOrchestratorView['reason'] } : {}),
            ...(data.recoveryError !== undefined ? { recoveryError: data.recoveryError as MergeOrchestratorView['recoveryError'] } : {}),
            ...(data.recoveryErrorDetail !== undefined ? { rollbackError: data.recoveryErrorDetail as string } : {}),
          },
        };
      }

      case 'state.patched': {
        const data = event.data as { patch?: unknown } | undefined;
        if (!data?.patch || !isPlainObject(data.patch) || Object.keys(data.patch).length === 0) {
          return view;
        }

        const next = structuredClone(view) as unknown as Record<string, unknown>;
        for (const [dotPath, value] of Object.entries(data.patch as Record<string, unknown>)) {
          try {
            applyDotPath(next, dotPath, value);
          } catch (err) {
            if (err instanceof StateStoreError && err.code === ErrorCode.RESERVED_FIELD) {
              continue;
            }
            throw err;
          }
        }

        return next as unknown as WorkflowStateView;
      }

      case 'team.spawned':
      case 'team.disbanded':
      case 'synthesize.requested':
      case 'workflow.pruned':
        return {
          ...view,
          _events: [...(view._events ?? []), { type: event.type, timestamp: event.timestamp, data: event.data }],
        };

      case 'workflow.cancel':
      case 'workflow.cleanup': {
        const data = event.data as {
          to?: string;
          phaseAttemptId?: string;
        } | undefined;
        if (!data?.to) return view;
        return {
          ...view,
          phase: data.to,
          updatedAt: event.timestamp,
          ...(data.phaseAttemptId !== undefined
            ? { phaseAttemptId: data.phaseAttemptId }
            : {}),
        };
      }
      case 'task.claimed':
      case 'task.progressed':
      case 'task.created':
      case 'task.polled':
      case 'task.result':
      case 'task.cancelled':
      case 'stack.restacked':
      case 'stack.enqueued':
      case 'stack.submitted':
      case 'workflow.fix-cycle':
      case 'workflow.guard-failed':
      case 'workflow.compound-entry':
      case 'workflow.compound-exit':
      case 'workflow.compensation':
      case 'workflow.circuit-open':
      case 'workflow.cas-failed':
      case 'workflow.checkpoint_requested':
      case 'workflow.checkpoint_written':
      case 'workflow.checkpoint_superseded':
      case 'workflow.rehydrated':
      case 'workflow.snapshot_taken':
      case 'workflow.projection_degraded':
      case 'tool.invoked':
      case 'tool.completed':
      case 'tool.errored':
      case 'tool.action_errored':
      case 'tool.budget_exceeded':
      case 'turn.completed':
      case 'subagent.tokens_used':
      case 'benchmark.completed':
      case 'team.task.assigned':
      case 'team.task.completed':
      case 'team.task.failed':
      case 'team.task.planned':
      case 'team.teammate.dispatched':
      case 'quality.regression':
      case 'quality.hint.generated':
      case 'quality.refinement.suggested':
      case 'review.completed':
      case 'review.finding':
      case 'review.escalated':
      case 'eval.run.started':
      case 'eval.case.completed':
      case 'eval.run.completed':
      case 'eval.judge.calibrated':
      case 'shepherd.started':
      case 'shepherd.iteration':
      case 'shepherd.approval_requested':
      case 'shepherd.escalated':
      case 'shepherd.completed':
      case 'remediation.attempted':
      case 'remediation.succeeded':
      case 'session.tagged':
      case 'session.machinery_consumed':
      case 'worktree.created':
      case 'worktree.baseline':
      case 'worktree.remove.requested':
      case 'worktree.remove.executed':
      case 'worktree.adopted':
      case 'worktree.reserved':
      case 'worktree.released':
      case 'worktree.orphan_detected':
      case 'worktree.merge_requested':
      case 'worktree.merge_executed':
      case 'worktree.create.requested':
      case 'worktree.create.executed':
      case 'launch.executing_started':
      case 'launch.executed':
      case 'test.result':
      case 'typecheck.result':
      case 'ci.status':
      case 'ci.check_observed':
      case 'comment.posted':
      case 'comment.resolved':
      case 'diagnostic.executed':
      case 'pr.created':
      case 'pr.merged':
      case 'pr.commented':
      case 'pr.create.requested':
      case 'pr.create.executed':
      case 'pr.comment.requested':
      case 'pr.comment.executed':
      case 'issue.created':
      case 'issue.create.requested':
      case 'issue.create.executed':
      case 'onboard.requested':
      case 'onboard.executed':
      case 'checkpoint.enforced':
      case 'checkpoint.state_missing':
      case 'preflight.executed':
      case 'preflight.blocked':
      case 'provider.unknown-tier':
      case 'provider.parse-error':
      case 'dispatch.classified':
      case 'dispatch.preflight':
      case 'merge.requested':
      case 'merge.completed':
      case 'merge.retry_attempt':
      case 'merge.executing_started':
      case 'command.resolved':
      case 'hsm.deprecated_action_invoked':
      case 'spec.legacy_capabilities_array':
      case 'phase.contract_missing':
      case 'phase.blocked':
      case 'migration.legacy_jsonl_imported':
      case 'migration.completed':
      case 'migration.failed':
      case 'migration.workflow_type_unknown':
      case 'migration.correlation_backfill_progress':
      case 'branch.delete.requested':
      case 'branch.delete.executed':
      case 'workspace.resolved':
      case 'elicitation.requested':
      case 'elicitation.fulfilled':
      case 'elicitation.declined':
      case 'stash.detected':
      case 'invariant.authored':
      case 'invariant.amended':
      case 'catalog.registered':
      case 'mutation.executing_started':
      case 'mutation.executed':
      case 'prune.executing_started':
      case 'prune.executed':
      case 'export.requested':
      case 'export.executed':
        return view;

      case 'admission.evidence-recorded': {
        const proof = admissionProofOf(view);
        const evidenceHistory = [
          ...proof.evidenceHistory,
          event.data as AdmissionEvidenceRecorded,
        ];
        const selection = selectEvidence({
          evidence: evidenceHistory,
          contradictionEvents: proof.contradictionHistory,
        });
        return {
          ...view,
          admissionProof: {
            ...proof,
            evidenceHistory,
            contradictionHistory: proof.contradictionHistory,
            ...selection,
            ...foldPhaseAttempts(proof, { evidenceHistory }),
          },
        };
      }
      case 'admission.contradiction-recorded': {
        const proof = admissionProofOf(view);
        const contradictionHistory = [
          ...proof.contradictionHistory,
          event.data as AdmissionContradictionRecorded,
        ];
        const selection = selectEvidence({
          evidence: proof.evidenceHistory,
          contradictionEvents: contradictionHistory,
        });
        return {
          ...view,
          admissionProof: {
            ...proof,
            evidenceHistory: proof.evidenceHistory,
            contradictionHistory,
            ...selection,
          },
        };
      }
      case 'admission.requirement-resolved': {
        const proof = admissionProofOf(view);
        const requirementHistory = [...proof.requirementHistory, event.data];
        return {
          ...view,
          admissionProof: {
            ...proof,
            requirementHistory,
            ...foldPhaseAttempts(proof, { requirementHistory }),
          },
        };
      }
      case 'admission.transition-decided': {
        const proof = admissionProofOf(view);
        const decisionHistory = [...proof.decisionHistory, event.data];
        return {
          ...view,
          admissionProof: {
            ...proof,
            decisionHistory,
            ...foldPhaseAttempts(proof, { decisionHistory }),
          },
        };
      }
      case 'admission.waiver-recorded':
      case 'admission.reassessment-requested':
      case 'admission.reassessment-completed':
      case 'admission.shadow-attempt':
      case 'admission.disagreement-disposition':
      case 'admission.rollout-decision':
      case 'admission.enforcement-enabled':
      case 'admission.cutover-ready':
      case 'cancel.requested':
      case 'cancel.ownership-acquired':
      case 'cancel.compensation-requested':
      case 'cancel.compensation-completed':
      case 'cancel.compensation-failed':
      case 'cancel.compensation-retry-scheduled':
      case 'cancel.manual-intervention-required':
      case 'cancel.ready':
      case 'feedback.recorded':
      case 'projection.degraded':
      case 'projection.recovered':
      case 'workflow.handoff_summarized':
      case 'vcs.requested':
      case 'vcs.executed':
      case 'vcs.compensated':
      case 'promotion.executed':
      case 'emission.violated':
      case 'prune.diagnostics':
      case 'orchestrate.intent_executed':
      case 'workflow.prepared':
      case 'execution.settled':
      case 'deviation.proposed':
      case 'deviation.decided':
      case 'design.revised':
        return view;

      default: {
        const _exhaustive: never = type;
        throw new Error(`Unhandled workflow event type: ${JSON.stringify(_exhaustive)}`);
      }
    }
  },
};
