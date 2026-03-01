// ─── Prepare Delegation Composite Action ─────────────────────────────────────
//
// Orchestrates pre-delegation readiness checks by querying the workflow state
// projection and code quality view, returning a unified readiness assessment
// with quality hints for subagent prompt assembly.
// ────────────────────────────────────────────────────────────────────────────

import type { ToolResult } from '../format.js';
import {
  getOrCreateMaterializer,
  getOrCreateEventStore,
  queryDeltaEvents,
} from '../views/tools.js';
import {
  workflowStateProjection,
  WORKFLOW_STATE_VIEW,
} from '../views/workflow-state-projection.js';
import type { WorkflowStateView } from '../views/workflow-state-projection.js';
import {
  codeQualityProjection,
  CODE_QUALITY_VIEW,
} from '../views/code-quality-view.js';
import type { CodeQualityViewState } from '../views/code-quality-view.js';
import { generateQualityHints } from '../quality/hints.js';
import type { QualityHint } from '../quality/hints.js';

// ─── Readiness State ────────────────────────────────────────────────────────

export interface DelegationReadinessState {
  readonly ready: boolean;
  readonly blockers: string[];
  readonly plan: { approved: boolean; taskCount: number };
  readonly quality: { queried: boolean; gatePassRate: number | null; regressions: string[] };
}

export interface PrepareDelegationResult {
  readonly ready: boolean;
  readonly readiness: DelegationReadinessState;
  readonly blockers?: string[];
  readonly qualityHints?: Array<{ category: string; severity: string; hint: string }>;
}

// ─── Readiness Assessment ───────────────────────────────────────────────────

function assessReadiness(
  workflowState: WorkflowStateView,
  qualityState: CodeQualityViewState | null,
  taskCount: number,
): DelegationReadinessState {
  const blockers: string[] = [];

  // Check plan approval
  const planReview = workflowState.planReview as { approved?: boolean } | undefined;
  const planApproved = planReview?.approved === true;
  if (!planApproved) {
    blockers.push('Plan has not been approved');
  }

  // Check plan artifact exists
  if (!workflowState.artifacts?.plan) {
    blockers.push('Plan artifact is missing');
  }

  // Check tasks exist
  if (taskCount === 0) {
    blockers.push('No tasks defined for delegation');
  }

  // Assess quality
  const overallPassRate = computeOverallGatePassRate(qualityState);
  const regressionNames = qualityState
    ? qualityState.regressions.map(r => `${r.skill}/${r.gate}`)
    : [];

  return {
    ready: blockers.length === 0,
    blockers,
    plan: {
      approved: planApproved,
      taskCount,
    },
    quality: {
      queried: qualityState !== null,
      gatePassRate: overallPassRate,
      regressions: regressionNames,
    },
  };
}

// ─── Quality Hint Assembly ──────────────────────────────────────────────────

function assembleQualityHints(
  qualityState: CodeQualityViewState | null,
): Array<{ category: string; severity: string; hint: string }> {
  if (!qualityState) return [];

  const hints: QualityHint[] = generateQualityHints(qualityState);
  return hints.map(h => ({
    category: h.category,
    severity: h.severity,
    hint: h.hint,
  }));
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function computeOverallGatePassRate(
  qualityState: CodeQualityViewState | null,
): number | null {
  if (!qualityState) return null;
  const gates = Object.values(qualityState.gates);
  if (gates.length === 0) return null;
  const total = gates.reduce((sum, g) => sum + g.passRate, 0);
  return total / gates.length;
}

// ─── Handler ────────────────────────────────────────────────────────────────

export async function handlePrepareDelegation(
  args: { featureId: string; tasks?: Array<{ id: string; title: string }> },
  stateDir: string,
): Promise<ToolResult> {
  // Validate input
  if (!args.featureId) {
    return {
      success: false,
      error: { code: 'INVALID_INPUT', message: 'featureId is required' },
    };
  }

  try {
    const materializer = getOrCreateMaterializer(stateDir);
    const store = getOrCreateEventStore(stateDir);
    const streamId = args.featureId;

    // Materialize workflow state
    const wsEvents = await queryDeltaEvents(store, materializer, streamId, WORKFLOW_STATE_VIEW);
    const workflowState = materializer.materialize<WorkflowStateView>(
      streamId,
      WORKFLOW_STATE_VIEW,
      wsEvents,
    );

    // Determine task count from args or workflow state
    const taskCount = args.tasks?.length ?? workflowState.tasks.length;

    // Materialize code quality (best effort -- may have no events)
    let qualityState: CodeQualityViewState | null = null;
    try {
      const cqEvents = await queryDeltaEvents(store, materializer, streamId, CODE_QUALITY_VIEW);
      qualityState = materializer.materialize<CodeQualityViewState>(
        streamId,
        CODE_QUALITY_VIEW,
        cqEvents,
      );
    } catch {
      // Quality view may not exist for this stream -- that's fine
    }

    // Assess readiness
    const readiness = assessReadiness(workflowState, qualityState, taskCount);

    // Build result
    if (!readiness.ready) {
      const result: PrepareDelegationResult = {
        ready: false,
        readiness,
        blockers: readiness.blockers,
      };
      return { success: true, data: result };
    }

    // Ready -- include quality hints
    const qualityHints = assembleQualityHints(qualityState);
    const result: PrepareDelegationResult = {
      ready: true,
      readiness,
      qualityHints,
    };
    return { success: true, data: result };
  } catch (err) {
    return {
      success: false,
      error: {
        code: 'PREPARE_DELEGATION_FAILED',
        message: err instanceof Error ? err.message : String(err),
      },
    };
  }
}
