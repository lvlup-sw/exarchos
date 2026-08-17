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
// State-mutation primitives imported from the shared LEAF module, not from
// `state-store.ts` (DR-4, task 009). `state-store.ts` value-imports THIS
// projection's `apply` for `reconcileFromEvents`; importing these helpers from
// the leaf keeps that a one-way edge instead of a runtime import cycle.
import { isPlainObject, applyDotPath, StateStoreError } from '../../workflow/state-mutation.js';
import { ErrorCode } from '../../workflow/schemas.js';
import type { DesignDepth } from '../../workflow/plan-depth-policy.js';

// ─── View Name Constant ────────────────────────────────────────────────────

export const WORKFLOW_STATE_VIEW = 'workflow-state';

// ─── Initial Phase by Workflow Type ────────────────────────────────────────
// Derived from the HSM (`getInitialPhase`, the single source of truth) rather
// than a hand-synced copy (#1554). The previous manual `INITIAL_PHASE` table
// had silently drifted — it omitted `discovery: 'gathering'` — exactly the
// failure mode its own "keep in sync" comment warned about. `getInitialPhase`
// throws for unknown types, so the fold guards with `isBuiltInWorkflowType`
// and falls back to the seed phase for custom/unknown types (a projection must
// tolerate any historical event without crashing the replay).

// ─── WorkflowState View Shape ──────────────────────────────────────────────

export interface WorkflowStateView {
  version: string;
  featureId: string;
  workflowType: string;
  phase: string;
  /** Active phase-entry identity, sourced only from persisted lifecycle data. */
  phaseAttemptId?: string;
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
  /**
   * Audit/shadow-only proof visibility. Histories are append-only event data;
   * derived arrays are a deterministic selection and never affect phase state.
   */
  admissionProof: AdmissionProofView;
  /**
   * The feature's frozen planning depth (DR-3, epic #1581) — the per-feature
   * analog of per-task `riskTier`. Resolve-then-frozen by the PLAN
   * `phase.entered` event and folded here; the plan-structure gate resolver
   * reads it on every subsequent resolution. Sticky: a non-PLAN `phase.entered`
   * never clears it, and re-entering PLAN re-freezes the same value.
   * `undefined` until the first PLAN `phase.entered` is folded (pre-#1581 logs
   * and non-feature workflows never carry it — the resolver then defaults to
   * `'standard'`).
   */
  designDepth?: DesignDepth;
  /**
   * Terminal merge-orchestrator state (#1504/#1554). Folded from the
   * `merge.preflight` / `merge.executed` / `merge.recovered` (and legacy
   * `merge.rollback`) events, mirroring
   * the file-path `applyEventToState` (state-store.ts) so `resolveWorkflowState`
   * reconstructs the block instead of silently dropping it. `undefined` until
   * the first terminal merge event is folded (matches the file's
   * absence-until-merge). Each terminal event REPLACES the block so no stale
   * fields leak across phases.
   */
  mergeOrchestrator?: MergeOrchestratorView;
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
  /** Frozen POLA posture (trust tier) for the phase kind (DR-14). */
  posture: string;
  /**
   * The danger coordinate the obligation was resolved at, frozen with it
   * (DR-10 / T-15). Read back as the authority by later resolutions; absent on
   * pre-T-15 logs, where there is no frozen claim to read.
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
   * Append-only raw `admission.requirement-resolved` payloads (P01-04). Held
   * as `unknown` on purpose: the attempt fold PARSES them on every rebuild, so
   * a historical malformed fact is diagnosed rather than trusted.
   */
  requirementHistory: readonly unknown[];
  /** Append-only raw `admission.transition-decided` payloads (P01-04). */
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

// ─── Helpers ───────────────────────────────────────────────────────────────

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
 * State-file reconciliation can apply a newly appended proof event to a
 * pre-v2.12 projected state. Treat the absent additive block as its empty seed
 * rather than requiring mutable backfill or making replay depend on snapshot
 * age. Per-field defaulting covers the same problem one contract version later:
 * a state persisted before P01-04 carries the evidence slots but not the
 * phase-attempt slots, and a fold must not read `undefined` off it.
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
 * Recompute the per-attempt frozen fold (P01-04) from the append-only proof
 * histories. Every admission fold recomputes from history rather than mutating
 * a running summary, so a partial re-fold and a from-zero replay agree.
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

// ─── Projection ────────────────────────────────────────────────────────────

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

  apply: (view: WorkflowStateView, event: WorkflowEvent): WorkflowStateView => {
    // Custom (runtime-registered) event types are not in the closed `EventTypes`
    // union and never mutate workflow-state — return identity, exactly as the
    // pre-#1554 catch-all `default` did. Narrowing to the closed union below is
    // what lets the exhaustive `switch` + the `never`-assignment default PROVE
    // (at `npm run typecheck`) that every BUILT-IN event type is accounted for:
    // adding an `EventTypes` entry without a case here is a compile error
    // (#1554 guard (a) — compile-time exhaustiveness).
    if (!isBuiltInEventType(event.type)) return view;
    const type: EventType = event.type as EventType;
    switch (type) {
      // ── Workflow Lifecycle ──────────────────────────────────────────────

      case 'workflow.started': {
        const data = event.data as {
          featureId?: string;
          workflowType?: string;
          synthesisPolicy?: 'always' | 'never' | 'on-request';
          phaseAttemptId?: string;
        } | undefined;
        if (!data) return view;

        const workflowType = data.workflowType ?? view.workflowType;
        // Built-in types resolve their initial phase from the HSM (SoT);
        // unknown/custom types keep the seed phase rather than throw on replay.
        const phase = isBuiltInWorkflowType(workflowType)
          ? getInitialPhase(workflowType)
          : view.phase;

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
          ...(data.phaseAttemptId !== undefined
            ? { phaseAttemptId: data.phaseAttemptId }
            : {}),
          // `createdAt` is set once, by the FIRST fold of `workflow.started`. On
          // a full fold from the initial view (resolveWorkflowState) `view.createdAt`
          // is the empty-string sentinel from `init()`, so the event timestamp
          // wins — canonical behavior. On a partial re-fold (reconcileFromEvents
          // replaying from sequence 0 when a state lacks `_eventSequence`), an
          // already-stamped `createdAt` is preserved rather than clobbered, keeping
          // the fold idempotent. `||` (not `??`) so the `''` sentinel — not just
          // undefined — falls back. The event log stays the source of truth either
          // way (INV-1): the value is the `workflow.started` timestamp from the
          // first application.
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
          posture?: string;
          designDepth?: DesignDepth;
          riskTier?: string;
          boundaryTouching?: boolean;
        } | undefined;
        if (!data?.phase || !data.kind) return view;

        return {
          ...view,
          updatedAt: event.timestamp,
          // Freeze the per-feature `designDepth` carried by the PLAN
          // `phase.entered` (DR-3). Sticky: a non-PLAN `phase.entered` omits the
          // field and must NOT clear the frozen value — spread only when present.
          ...(data.designDepth ? { designDepth: data.designDepth } : {}),
          phaseObligation: {
            phase: data.phase,
            kind: data.kind,
            resolver: data.resolver ?? null,
            resolvedGates: data.resolvedGates ?? [],
            policySource: data.policySource ?? 'builtin',
            mode: data.mode ?? 'enforce',
            posture: data.posture ?? 'read-only',
            // DR-10 (T-15): the frozen danger coordinate, folded back verbatim
            // so later resolutions read the authority instead of re-deriving it
            // from current state. Absent on pre-T-15 logs — omitted rather than
            // defaulted, since a fabricated coordinate is the defect itself.
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

      // ── Plan-review revise count (DR-1) ────────────────────────────────
      // Fold each `workflow.plan-revision` occurrence into the NESTED
      // `planReview.revisionCount` — the exact field the `revisionsExhausted`
      // guard (workflow/guards.ts) reads — so the plan↔plan-review revise loop
      // is bounded by an event-sourced count, not advisory prose. A pure
      // left-fold (+1 per event): replaying the log from `init()` reconstructs
      // the identical count, and other `planReview` fields set via
      // `state.patched` (e.g. `approved` / `gapsFound`) are preserved by the
      // spread rather than clobbered.
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

      // ── Plan-review dispatch count (WLM-6 DR-2) ─────────────────────────
      // The standard `plan-review → plan` revise loop is now counted at its
      // unskippable `prepare_review scope:plan` provisioning seam, not the
      // (skippable) HSM edge. Each dispatch carries a 0-based `ordinal`; folding
      // the MAX ordinal into the SAME `planReview.revisionCount` the
      // `revisionsExhausted` guard reads means the ordinal-0 initial review is
      // revision 0 (no counter increment) and each re-dispatch is +1. `max`
      // (not `+1`) is what makes the initial free AND keeps the guard's
      // `revisionCount >= cap` semantics correct: the count equals the number of
      // RE-DISPATCHES (revisions), never the total provisionings. Replay-stable
      // and idempotent under a same-ordinal crash-retry (the storage-layer
      // idempotency key collapses the duplicate, and `max` is duplicate-proof
      // even if one slipped through). Other `planReview` fields (`approved`,
      // `gapsFound`) set via `state.patched` are preserved by the spread.
      // A given workflow is either a feature (this event) or an overhaul (the
      // `workflow.plan-revision` fold above) — never both — so the two folds
      // never contend for `revisionCount` on one stream.
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

      // ── Mutation-adequacy dimension (DR-2a) ─────────────────────────────
      // Fold the mutation gate's `gate.executed` (layer 'review') into
      // `reviews['mutation-adequacy']` so the required dimension is satisfied by
      // the ACTUAL gate run — the recorded fact, not an agent hand-write (INV-1).
      // This closes the DR-2 dead-lock: `state.riskTier='high'` makes
      // `allReviewsPassed` require the dimension's presence; without this fold
      // nothing ever populated it. A no-toolchain run emits a skip-passing
      // `gate.executed` (mutation-adequacy.ts), so the dimension is recorded as
      // skip-pass rather than silently absent. The dimension is advisory by
      // default (status 'pass'); the raw score/verdict rides
      // `mutationScore`/`passed` for the DR-3 score-enforcement check in
      // `allReviewsPassed`. Non-mutation `gate.executed` events stay no-ops.
      case 'gate.executed': {
        const data = event.data as
          | {
              gateName?: string;
              layer?: string;
              passed?: boolean;
              details?: Record<string, unknown>;
            }
          | undefined;
        // 'mutation-adequacy' is the review-contract dimension name (SoT:
        // workflow/review-contract.ts); the gate.executed carries it verbatim.
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
              // DR-6 (additive): carry the NoCoverage count so `allReviewsPassed`
              // Check 4's SECOND, orthogonal axis can read it off the folded
              // dimension. A legacy `gate.executed` WITHOUT `noCoverage` in its
              // details omits the field entirely — folding byte-identical to
              // before (INV-1: pure left-fold, identical legacy replay).
              ...(typeof rawNoCoverage === 'number' ? { noCoverage: rawNoCoverage } : {}),
              ...(details.skipped === true ? { skipped: true } : {}),
              // Carry the degrade marker (RVC-R1): a `degraded` run (toolchain
              // present but the runner failed/unparseable) shares `skipped:true`
              // with the no-toolchain skip-pass, but `allReviewsPassed` Check 4
              // must fail it CLOSED under block enforcement — it produced no
              // verifiable score. The no-toolchain skip-pass omits `degraded`.
              ...(details.degraded === true ? { degraded: true } : {}),
            },
          },
        };
      }

      // ── Merge Orchestrator (#1504/#1554 — close the projection gap) ─────
      // Mirrors the file-path applyEventToState (state-store.ts:804-853): each
      // terminal merge event REPLACES `mergeOrchestrator` (no spread) so the
      // block is self-consistent — no stale fields from a prior phase. Without
      // these, resolveWorkflowState silently dropped the whole block (the
      // #1504 audit's headline gap).

      case 'merge.preflight': {
        const data = event.data as Record<string, unknown> | undefined;
        if (!data) return view;
        // Only a FAILED preflight produces a terminal `aborted` block. A passing
        // preflight is observation — the executor's merge.executed/rollback
        // produces the next terminal write.
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
        // #1306 successor to merge.rollback — same logical fold, reading the
        // renamed event fields (recoveryPointSha / recoveryErrorDetail) onto the
        // existing view fields. Since DR-2 (task 006) this is the sole emitted
        // recovery terminal; the merge.rollback case above is retained only to
        // fold legacy logs, and folding both is idempotent (same view).
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

      // ── State Patch (generic field updates) ────────────────────────────

      case 'state.patched': {
        const data = event.data as { patch?: unknown } | undefined;
        // Return the SAME reference for a missing/non-object/empty patch so the
        // projection honors its no-op-returns-identity contract. An empty `{}`
        // patch would otherwise `structuredClone` into a fresh reference, which
        // reconcileFromEvents' `next !== folded` check miscounts as applied —
        // spuriously flipping `reconciled: true` and forcing a no-op write-back.
        if (!data?.patch || !isPlainObject(data.patch) || Object.keys(data.patch).length === 0) {
          return view;
        }

        // The patch keys MAY be dot-paths — handleSet emits `patch:
        // input.updates` verbatim (tools.ts), where `updates` uses dot-path
        // notation like `oneshot.synthesisPolicy` or `tasks[0].nativeTaskId`.
        // Apply each one directly onto a deep clone of the view with the SAME
        // `applyDotPath` the on-disk write uses, so the fold is byte-identical
        // to the file (fold ≡ write, #1504/#1554).
        //
        // The earlier expand-into-a-fresh-object + `deepMerge(view, expanded)`
        // approach was correct for nested OBJECTS (Addendum 2 fix) but wrong
        // for ARRAY-INDEX paths: expanding `tasks[0].nativeTaskId` yields a
        // sparse `{tasks:[{nativeTaskId}]}`, and `deepMerge` REPLACES arrays
        // wholesale, so an index patch clobbered every sibling task down to the
        // one sparse entry (#1504 audit Addendum 3). Applying onto the clone
        // navigates the existing array and mutates in place — preserving
        // siblings — exactly as the live write does. Whole-array replacement
        // (`{tasks: [...]}`) still replaces (applyDotPath's array leaf), and
        // nested-object merge is preserved (applyDotPath's plain-object leaf).
        //
        // Reserved-field paths are rejected at write time; on replay just skip
        // them rather than throw.
        const next = structuredClone(view) as unknown as Record<string, unknown>;
        for (const [dotPath, value] of Object.entries(data.patch as Record<string, unknown>)) {
          try {
            applyDotPath(next, dotPath, value);
          } catch (err) {
            // Reserved-field paths are rejected at write time, so they cannot be
            // committed to the log — skip them on replay. Any OTHER applyDotPath
            // failure means the patch event is malformed/corrupt; swallowing it
            // would silently drop a mutation and mask projection divergence
            // (INV-1). Re-throw so the fold surfaces the inconsistency.
            if (err instanceof StateStoreError && err.code === ErrorCode.RESERVED_FIELD) {
              continue;
            }
            throw err;
          }
        }

        return next as unknown as WorkflowStateView;
      }

      // ── Observability-only: tracked in `_events` (no state mutation) ────
      // These four append a breadcrumb to `_events` but do not otherwise mutate
      // the view. Behavior preserved verbatim from the pre-#1554 fold.

      case 'team.spawned':
      case 'team.disbanded':
      case 'synthesize.requested':
      case 'workflow.pruned':
        return {
          ...view,
          _events: [...(view._events ?? []), { type: event.type, timestamp: event.timestamp, data: event.data }],
        };

      // ── Observability-only: pure no-op (return identity) ───────────────
      // The EXPLICIT no-op set (#1554 guard (a)). Every built-in event type
      // that legitimately does not mutate workflow-state is listed here by
      // name rather than swallowed by a catch-all `default`. A new `EventTypes`
      // entry that belongs here must be added explicitly; one that should
      // mutate state but is left out becomes a `never`-assignment compile error
      // at the `default` below. Preserves the pre-#1554 behavior exactly (all of
      // these previously fell through `default: return view`).

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
      // WLM foundation — worktree lifecycle (lease/ownership half). These are
      // worktree-pool observations (adopt/reserve/release/orphan); they carry no
      // workflow_state-affecting fields, so the projection folds to identity.
      case 'worktree.adopted':
      case 'worktree.reserved':
      case 'worktree.released':
      case 'worktree.orphan_detected':
      // WLM operational-core — serialized-merge lease pair (DR-4 / DR-7). These
      // ride the singleton `worktrees` stream and are folded by the worktrees@v1
      // projection, not by workflow-state; they carry no workflow_state-affecting
      // fields, so this projection folds to identity like the lifecycle family.
      case 'worktree.merge_requested':
      case 'worktree.merge_executed':
      // harness-launcher (DR-2) — the launcher's top-level worktree create pair
      // and the child-process liveness pair. These ride the worktrees/launch
      // streams and carry no workflow_state-affecting fields, so this projection
      // folds them to identity like the merge-lease and lifecycle families.
      case 'worktree.create.requested':
      case 'worktree.create.executed':
      case 'launch.executing_started':
      case 'launch.executed':
      case 'test.result':
      case 'typecheck.result':
      case 'ci.status':
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
      // #1308 — audit-only retry record; it does not transition the
      // mergeOrchestrator phase (the retry sits between attempts), so the
      // projection treats it as an observation and folds to identity.
      case 'merge.retry_attempt':
      // #1309 — audit-only liveness marker emitted before the first vcsMerge;
      // it does not transition the mergeOrchestrator phase (the terminal
      // merge.executed / merge.recovered events drive the phase), so the
      // projection treats it as an observation and folds to identity.
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
      // WLM slice 3 (DR-3 / INV-10) — the prune-run liveness pair rides the
      // singleton `worktrees` stream, never a feature stream, so it has no
      // effect on any workflow's projected state (folded by `worktrees@v1`).
      case 'prune.executing_started':
      case 'prune.executed':
      // DR-6 (lifecycle-verbs task 012) — the two-event `export` contract is an
      // audit trail (INV-13) of a zip-bundle write; it carries no
      // workflow_state-affecting fields, so it leaves the projection unchanged.
      case 'export.requested':
      case 'export.executed':
        return view;

      // Phase-gate v2.12 proof substrate: audit/shadow visibility only. These
      // folds do not alter phase, guards, policy evaluation, or enforcement.
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
      // P01-04 — frozen requirement sets and decision state. Both payloads are
      // retained raw and re-parsed by the attempt fold, so replay reconstructs
      // the frozen set the writer resolved rather than anything current policy
      // would resolve today.
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
      // #1739 — lands on the reserved `exarchos-admission` infrastructure
      // stream (store-wide cutover posture), never a feature stream, so it has
      // no effect on any workflow's projected state.
      case 'admission.cutover-ready':
      // Cancellation process-manager facts are audit/recovery inputs. The
      // existing workflow.cancel event remains the v2.12 phase transition.
      case 'cancel.requested':
      case 'cancel.ownership-acquired':
      case 'cancel.compensation-requested':
      case 'cancel.compensation-completed':
      case 'cancel.compensation-failed':
      case 'cancel.compensation-retry-scheduled':
      case 'cancel.manual-intervention-required':
      case 'cancel.ready':
      // #1319 — lands on the shared `meta/feedback` stream, never a feature
      // stream, so it has no effect on any workflow's projected state.
      case 'feedback.recorded':
      // DR-4 (wiring-closure T-06) — the durable projection-health pair lands
      // on the shared `meta/projection-health` stream, never a feature stream.
      // It REPORTS ON folds; folding it into one would make the fold's own
      // health part of the state being assessed.
      case 'projection.degraded':
      case 'projection.recovered':
      // #1242 — folds into the rehydration projection's handoff slot only; it
      // carries no workflow_state-affecting fields.
      case 'workflow.handoff_summarized':
      // The VCS mutation ledger rides its own dedicated `vcs-mutations` stream,
      // never a feature stream. Its only reader is the mutation owner's own
      // fold, which re-reads the ledger to recover the fencing epoch and the
      // idempotency replay cache before acting — deliberately NOT a consumer of
      // projected workflow state, and folding it here would put an effect
      // record into a view no caller asks for it from.
      case 'vcs.requested':
      case 'vcs.executed':
      case 'vcs.compensated':
      // The atomic tree-promotion record describes a directory on disk — where a
      // staged tree landed and what digest now lives there. No field of it is a
      // fact about a workflow, so there is nothing here for it to fold into.
      case 'promotion.executed':
        return view;

      // ── Exhaustiveness guard (#1554 guard (a)) ─────────────────────────
      // `type` is the closed `EventType` union; every member is handled above,
      // so this assignment narrows to `never`. Add an `EventTypes` entry
      // without a case → `type` is no longer `never` → COMPILE error here. The
      // throw is unreachable for built-in types (and custom types returned
      // early), so it never fires at runtime; it mirrors `assertNever`
      // (workflow/phase-kind.ts) but with a workflow-event-correct message and
      // no coupling to the gate-resolver module graph.
      default: {
        const _exhaustive: never = type;
        throw new Error(`Unhandled workflow event type: ${JSON.stringify(_exhaustive)}`);
      }
    }
  },
};
