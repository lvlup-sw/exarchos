/**
 * Projection for the shepherd loop.
 * Shepherd is an iteration loop inside the `synthesize` phase, not a separate phase.
 * This view tracks loop progress (iteration count and PR health) with no phase transition.
 */
import type { ViewProjection } from './materializer.js';
import type { WorkflowEvent } from '../../events/schemas.js';

export const SHEPHERD_STATUS_VIEW = 'shepherd-status';

export interface PrStatus {
  readonly pr: number;
  readonly ci: 'passing' | 'failing' | 'pending' | 'unknown';
  readonly comments: {
    readonly total: number;
    readonly unresolved: number;
  };
  readonly unresolvedBySeverity: Record<string, number>;
}

export interface ShepherdStatusState {
  readonly overallStatus: 'healthy' | 'needs-fixes' | 'blocked' | 'escalate' | 'unknown';
  readonly prs: ReadonlyArray<PrStatus>;
  readonly iteration: number;
  readonly maxIterations: number;
  readonly startedAt?: string;
  readonly approvalRequestedAt?: string;
  readonly completedAt?: string;
  readonly outcome?: string | undefined;
  /** The reason and counts from the `shepherd.escalated` event, so `shepherd_status` and `ps` can show why the loop escalated. */
  readonly escalation?: {
    readonly reason: string;
    readonly iterationCount: number;
    readonly maxIterations: number;
    readonly escalatedAt: string;
  };
}

function findOrCreatePr(prs: ReadonlyArray<PrStatus>, prNumber: number): PrStatus {
  const existing = prs.find((p) => p.pr === prNumber);
  if (existing) return existing;

  return {
    pr: prNumber,
    ci: 'unknown',
    comments: { total: 0, unresolved: 0 },
    unresolvedBySeverity: {},
  };
}

function updatePr(
  prs: ReadonlyArray<PrStatus>,
  prNumber: number,
  updater: (pr: PrStatus) => PrStatus,
): PrStatus[] {
  const existing = prs.find((p) => p.pr === prNumber);
  const pr = existing ?? findOrCreatePr(prs, prNumber);
  const updated = updater(pr);

  if (existing) {
    return prs.map((p) => (p.pr === prNumber ? updated : p)) as PrStatus[];
  }
  return [...prs, updated] as PrStatus[];
}

/**
 * True when the iteration count reaches the bound, or when the view folded a `shepherd.escalated` event.
 * The event alone is enough, so the status escalates even without the iteration events.
 */
function isEscalated(state: ShepherdStatusState): boolean {
  return state.escalation !== undefined || state.iteration >= state.maxIterations;
}

function hasBlockedPr(prs: ReadonlyArray<PrStatus>): boolean {
  return prs.some((p) => (p.unresolvedBySeverity['critical'] ?? 0) > 0);
}

function hasFailingCi(prs: ReadonlyArray<PrStatus>): boolean {
  return prs.some((p) => p.ci === 'failing');
}

function isAllHealthy(prs: ReadonlyArray<PrStatus>): boolean {
  if (prs.length === 0) return false;
  return prs.every((p) => p.ci === 'passing') &&
    prs.every((p) => p.comments.unresolved === 0);
}

function computeOverallStatus(state: ShepherdStatusState): ShepherdStatusState['overallStatus'] {
  if (isEscalated(state)) return 'escalate';
  if (hasBlockedPr(state.prs)) return 'blocked';
  if (hasFailingCi(state.prs)) return 'needs-fixes';
  if (isAllHealthy(state.prs)) return 'healthy';
  return 'unknown';
}

function handleCiStatus(state: ShepherdStatusState, event: WorkflowEvent): ShepherdStatusState {
  const data = event.data as { pr?: number; status?: string } | undefined;
  if (!data || data.pr === undefined) return state;

  const prNumber = data.pr;
  const status = (data.status ?? 'unknown') as PrStatus['ci'];
  const updatedPrs = updatePr(state.prs, prNumber, (pr) => ({
    ...pr,
    ci: status,
  }));

  const next: ShepherdStatusState = { ...state, prs: updatedPrs };
  return { ...next, overallStatus: computeOverallStatus(next) };
}

function handleReviewFinding(state: ShepherdStatusState, event: WorkflowEvent): ShepherdStatusState {
  const data = event.data as { pr?: number; severity?: string } | undefined;
  if (!data || data.pr === undefined) return state;

  const prNumber = data.pr;
  const severity = data.severity ?? 'unknown';
  const updatedPrs = updatePr(state.prs, prNumber, (pr) => ({
    ...pr,
    comments: {
      ...pr.comments,
      unresolved: pr.comments.unresolved + 1,
    },
    unresolvedBySeverity: {
      ...pr.unresolvedBySeverity,
      [severity]: (pr.unresolvedBySeverity[severity] ?? 0) + 1,
    },
  }));

  const next: ShepherdStatusState = { ...state, prs: updatedPrs };
  return { ...next, overallStatus: computeOverallStatus(next) };
}

/** Blocks the PR with one synthetic `critical` finding. */
function handleReviewEscalated(state: ShepherdStatusState, event: WorkflowEvent): ShepherdStatusState {
  const data = event.data as { pr?: number } | undefined;
  if (!data || data.pr === undefined) return state;

  const prNumber = data.pr;
  const updatedPrs = updatePr(state.prs, prNumber, (pr) => ({
    ...pr,
    unresolvedBySeverity: {
      ...pr.unresolvedBySeverity,
      critical: (pr.unresolvedBySeverity['critical'] ?? 0) + 1,
    },
  }));

  const next: ShepherdStatusState = { ...state, prs: updatedPrs };
  return { ...next, overallStatus: computeOverallStatus(next) };
}

function handleCommentPosted(state: ShepherdStatusState, event: WorkflowEvent): ShepherdStatusState {
  const data = event.data as { pr?: number } | undefined;
  if (!data || data.pr === undefined) return state;

  const prNumber = data.pr;
  const updatedPrs = updatePr(state.prs, prNumber, (pr) => ({
    ...pr,
    comments: {
      ...pr.comments,
      total: pr.comments.total + 1,
    },
  }));

  const next: ShepherdStatusState = { ...state, prs: updatedPrs };
  return { ...next, overallStatus: computeOverallStatus(next) };
}

function handleCommentResolved(state: ShepherdStatusState, event: WorkflowEvent): ShepherdStatusState {
  const data = event.data as { pr?: number } | undefined;
  if (!data || data.pr === undefined) return state;

  const prNumber = data.pr;
  const updatedPrs = updatePr(state.prs, prNumber, (pr) => ({
    ...pr,
    comments: {
      ...pr.comments,
      unresolved: Math.max(0, pr.comments.unresolved - 1),
    },
  }));

  const next: ShepherdStatusState = { ...state, prs: updatedPrs };
  return { ...next, overallStatus: computeOverallStatus(next) };
}

/**
 * Adds 1 for each `shepherd.iteration` event and ignores any `iteration` value in the payload.
 * `countShepherdIterations` uses the same rule, so `shepherd_status` and `ps` agree with the loop count.
 */
function handleShepherdIteration(state: ShepherdStatusState, event: WorkflowEvent): ShepherdStatusState {
  void event;
  const next: ShepherdStatusState = { ...state, iteration: state.iteration + 1 };
  return { ...next, overallStatus: computeOverallStatus(next) };
}

function handleShepherdStarted(state: ShepherdStatusState, event: WorkflowEvent): ShepherdStatusState {
  return { ...state, startedAt: event.timestamp };
}

function handleShepherdApprovalRequested(state: ShepherdStatusState, event: WorkflowEvent): ShepherdStatusState {
  return { ...state, approvalRequestedAt: event.timestamp };
}

function handleShepherdEscalated(state: ShepherdStatusState, event: WorkflowEvent): ShepherdStatusState {
  const data = event.data as
    | { reason?: string; iterationCount?: number; maxIterations?: number }
    | undefined;
  if (!data) return state;

  const next: ShepherdStatusState = {
    ...state,
    escalation: {
      reason: data.reason ?? '',
      iterationCount: data.iterationCount ?? state.iteration,
      maxIterations: data.maxIterations ?? state.maxIterations,
      escalatedAt: event.timestamp,
    },
  };
  return { ...next, overallStatus: computeOverallStatus(next) };
}

function handleShepherdCompleted(state: ShepherdStatusState, event: WorkflowEvent): ShepherdStatusState {
  const data = event.data as { outcome?: string } | undefined;
  return {
    ...state,
    completedAt: event.timestamp,
    outcome: data?.outcome,
  };
}

export const shepherdStatusProjection: ViewProjection<ShepherdStatusState> = {
  init: (): ShepherdStatusState => ({
    overallStatus: 'unknown',
    prs: [],
    iteration: 0,
    maxIterations: 5,
  }),

  apply: (view: ShepherdStatusState, event: WorkflowEvent): ShepherdStatusState => {
    switch (event.type) {
      case 'ci.status':
        return handleCiStatus(view, event);

      case 'review.finding':
        return handleReviewFinding(view, event);

      case 'review.escalated':
        return handleReviewEscalated(view, event);

      case 'comment.posted':
        return handleCommentPosted(view, event);

      case 'comment.resolved':
        return handleCommentResolved(view, event);

      case 'shepherd.iteration':
        return handleShepherdIteration(view, event);

      case 'shepherd.started':
        return handleShepherdStarted(view, event);

      case 'shepherd.approval_requested':
        return handleShepherdApprovalRequested(view, event);

      case 'shepherd.escalated':
        return handleShepherdEscalated(view, event);

      case 'shepherd.completed':
        return handleShepherdCompleted(view, event);

      default:
        return view;
    }
  },
};
