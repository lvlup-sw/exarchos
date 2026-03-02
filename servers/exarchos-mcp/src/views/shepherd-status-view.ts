import type { ViewProjection } from './materializer.js';
import type { WorkflowEvent } from '../event-store/schemas.js';

// ─── View Name Constant ────────────────────────────────────────────────────
// Shepherd is NOT a separate HSM phase — it operates as an iteration loop
// within the `synthesize` phase. This view tracks loop progress (iteration
// counts, PR health) without requiring a phase transition.

export const SHEPHERD_STATUS_VIEW = 'shepherd-status';

// ─── View State Interfaces ─────────────────────────────────────────────────

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
}

// ─── Per-PR Update Helper ──────────────────────────────────────────────────

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

// ─── Overall Status Computation ────────────────────────────────────────────

function isEscalated(state: ShepherdStatusState): boolean {
  return state.iteration >= state.maxIterations;
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

// ─── Event Handlers ────────────────────────────────────────────────────────

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

function handleReviewEscalated(state: ShepherdStatusState, event: WorkflowEvent): ShepherdStatusState {
  const data = event.data as { pr?: number } | undefined;
  if (!data || data.pr === undefined) return state;

  const prNumber = data.pr;
  // Mark the PR as blocked by adding a synthetic critical finding
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

function handleShepherdIteration(state: ShepherdStatusState, event: WorkflowEvent): ShepherdStatusState {
  const data = event.data as { iteration?: number } | undefined;
  if (!data || data.iteration === undefined) return state;

  const next: ShepherdStatusState = { ...state, iteration: data.iteration };
  return { ...next, overallStatus: computeOverallStatus(next) };
}

// ─── Projection ────────────────────────────────────────────────────────────

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

      default:
        return view;
    }
  },
};

// ─── Handler Function ──────────────────────────────────────────────────────

import type { ToolResult } from '../format.js';
import type { ViewMaterializer } from './materializer.js';

export async function handleViewShepherdStatus(
  args: { workflowId?: string },
  stateDir: string,
  materializer: ViewMaterializer,
): Promise<ToolResult> {
  try {
    const { getOrCreateEventStore, queryDeltaEvents } = await import('./tools.js');
    const store = getOrCreateEventStore(stateDir);
    const streamId = args.workflowId ?? 'default';

    const events = await queryDeltaEvents(store, materializer, streamId, SHEPHERD_STATUS_VIEW);
    const view = materializer.materialize<ShepherdStatusState>(
      streamId,
      SHEPHERD_STATUS_VIEW,
      events,
    );

    return { success: true, data: view };
  } catch (err) {
    return {
      success: false,
      error: {
        code: 'VIEW_ERROR',
        message: err instanceof Error ? err.message : String(err),
      },
    };
  }
}
