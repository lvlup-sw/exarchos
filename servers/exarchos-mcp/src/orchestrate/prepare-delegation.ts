// ─── Prepare Delegation Composite Action ─────────────────────────────────────
//
// Orchestrates pre-delegation readiness checks by querying the
// DelegationReadinessView projection, workflow state, and code quality view,
// returning a unified readiness assessment with quality hints for subagent
// prompt assembly.
// ────────────────────────────────────────────────────────────────────────────

import type { ToolResult } from '../format.js';
import {
  getOrCreateMaterializer,
  getOrCreateEventStore,
  queryDeltaEvents,
} from '../views/tools.js';
import {
  WORKFLOW_STATE_VIEW,
} from '../views/workflow-state-projection.js';
import type { WorkflowStateView } from '../views/workflow-state-projection.js';
import {
  CODE_QUALITY_VIEW,
} from '../views/code-quality-view.js';
import type { CodeQualityViewState } from '../views/code-quality-view.js';
import {
  DELEGATION_READINESS_VIEW,
} from '../views/delegation-readiness-view.js';
import type { DelegationReadinessState } from '../views/delegation-readiness-view.js';
import { generateQualityHints } from '../quality/hints.js';
import type { QualityHint } from '../quality/hints.js';
import { emitGateEvent } from './gate-utils.js';
import { queryTelemetryState } from '../telemetry/telemetry-queries.js';
import type { TelemetryViewState } from '../telemetry/telemetry-projection.js';

// ─── Result Interface ────────────────────────────────────────────────────────

export type { DelegationReadinessState } from '../views/delegation-readiness-view.js';

/** Input shape for a task passed to prepare_delegation. */
export interface TaskInput {
  readonly id: string;
  readonly title: string;
  readonly blockedBy?: readonly string[];
  readonly files?: readonly string[];
  readonly testLayer?: 'acceptance' | 'integration' | 'unit' | 'property';
}

/**
 * Advisory classification for a single task.
 * Note: effort omits 'max' intentionally — the heuristic classifier covers
 * scaffolder/implementer tiers only. 'max' effort (Opus-level deep reasoning)
 * is reserved for manual override, not automated classification.
 */
export interface TaskClassification {
  readonly taskId: string;
  readonly complexity: 'low' | 'medium' | 'high';
  readonly recommendedAgent: 'scaffolder' | 'implementer';
  readonly effort: 'low' | 'medium' | 'high';
  readonly reason: string;
}

export interface PrepareDelegationResult {
  readonly ready: boolean;
  readonly readiness: DelegationReadinessState;
  readonly blockers?: string[];
  readonly qualityHints?: Array<{ category: string; severity: string; hint: string }>;
  readonly isolation?: 'native';
  readonly taskClassifications?: readonly TaskClassification[];
}

// ─── Task Classification ────────────────────────────────────────────────────

/** Keywords in task titles that indicate low-complexity scaffolding work. */
const SCAFFOLDING_KEYWORDS = ['stub', 'boilerplate', 'type def', 'interface', 'scaffold'];

/**
 * Deterministic heuristic classification for a single task.
 * Advisory — agents can override these recommendations.
 *
 * Priority order:
 *   0. testLayer: "acceptance" → high/implementer (highest priority)
 *   1. Title contains scaffolding keywords → low/scaffolder
 *   2. blockedBy length >= 2 → high/implementer
 *   3. files length >= 3 → high/implementer
 *   4. Default → medium/implementer
 */
export function classifyTask(task: TaskInput): TaskClassification {
  // Check testLayer first (highest priority)
  if (task.testLayer === 'acceptance') {
    return {
      taskId: task.id,
      complexity: 'high',
      recommendedAgent: 'implementer',
      effort: 'high',
      reason: 'Acceptance test task — requires understanding feature intent holistically',
    };
  }

  const titleLower = task.title.toLowerCase();

  // Check scaffolding keywords
  const matchedKeyword = SCAFFOLDING_KEYWORDS.find(kw => titleLower.includes(kw));
  if (matchedKeyword) {
    return {
      taskId: task.id,
      complexity: 'low',
      recommendedAgent: 'scaffolder',
      effort: 'low',
      reason: `Title contains scaffolding keyword "${matchedKeyword}"`,
    };
  }

  // Check high-complexity signals
  if (task.blockedBy && task.blockedBy.length >= 2) {
    return {
      taskId: task.id,
      complexity: 'high',
      recommendedAgent: 'implementer',
      effort: 'high',
      reason: `Task has ${task.blockedBy.length} dependencies (>= 2 threshold)`,
    };
  }

  if (task.files && task.files.length >= 3) {
    return {
      taskId: task.id,
      complexity: 'high',
      recommendedAgent: 'implementer',
      effort: 'high',
      reason: `Task touches ${task.files.length} files (>= 3 threshold)`,
    };
  }

  // Default: medium complexity
  return {
    taskId: task.id,
    complexity: 'medium',
    recommendedAgent: 'implementer',
    effort: 'medium',
    reason: 'Standard task — no scaffolding keywords or high-complexity signals',
  };
}

// ─── Worktree Blocker Patterns ──────────────────────────────────────────────

const WORKTREE_BLOCKER_PATTERNS = [
  'worktrees pending',
  'worktrees failed',
  'no worktrees expected',
];

function isWorktreeBlocker(blocker: string): boolean {
  return WORKTREE_BLOCKER_PATTERNS.some(p => blocker.includes(p));
}

// ─── Quality Hint Assembly ──────────────────────────────────────────────────

function assembleQualityHints(
  qualityState: CodeQualityViewState | null,
  telemetryState?: TelemetryViewState | null,
): Array<{ category: string; severity: string; hint: string }> {
  if (!qualityState) return [];

  const hints: QualityHint[] = generateQualityHints(
    qualityState,
    undefined,
    undefined,
    telemetryState ?? undefined,
  );
  return hints.map(h => ({
    category: h.category,
    severity: h.severity,
    hint: h.hint,
  }));
}

// ─── Handler ────────────────────────────────────────────────────────────────

export async function handlePrepareDelegation(
  args: { featureId: string; tasks?: TaskInput[]; nativeIsolation?: boolean },
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

    // Materialize delegation readiness from event stream
    const drEvents = await queryDeltaEvents(store, materializer, streamId, DELEGATION_READINESS_VIEW);
    const readiness = materializer.materialize<DelegationReadinessState>(
      streamId,
      DELEGATION_READINESS_VIEW,
      drEvents,
    );

    // Materialize workflow state (needed for plan artifact check and task count)
    const wsEvents = await queryDeltaEvents(store, materializer, streamId, WORKFLOW_STATE_VIEW);
    const workflowState = materializer.materialize<WorkflowStateView>(
      streamId,
      WORKFLOW_STATE_VIEW,
      wsEvents,
    );

    // Supplementary check: plan artifact existence (not tracked by the readiness view)
    const hasPlanArtifact = Boolean(workflowState.artifacts?.plan);
    const additionalBlockers: string[] = [];
    if (!hasPlanArtifact) {
      additionalBlockers.push('Plan artifact is missing');
    }

    // Merge readiness from view with supplementary checks
    const allBlockers = [...readiness.blockers, ...additionalBlockers];

    // When nativeIsolation is true, filter out worktree-related blockers
    // (Claude Code handles worktree isolation natively via `isolation: "worktree"`)
    const effectiveBlockers = args.nativeIsolation
      ? allBlockers.filter(b => !isWorktreeBlocker(b))
      : allBlockers;

    const effectiveReady = effectiveBlockers.length === 0;

    const effectiveReadiness: DelegationReadinessState = {
      ...readiness,
      ready: effectiveReady,
      blockers: effectiveBlockers,
    };

    // Build result
    if (!effectiveReady) {
      const result: PrepareDelegationResult = {
        ready: false,
        readiness: effectiveReadiness,
        blockers: effectiveBlockers,
        ...(args.nativeIsolation ? { isolation: 'native' as const } : {}),
      };
      return { success: true, data: result };
    }

    // Query telemetry state for hint generation (graceful degradation)
    const telemetryState = await queryTelemetryState(store, stateDir);

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

    // Ready -- include quality hints (with telemetry integration)
    const qualityHints = assembleQualityHints(qualityState, telemetryState);

    // Determine task count from args or readiness view
    const taskCount = args.tasks?.length ?? readiness.plan.taskCount;

    // Emit plan-coverage gate event (best-effort: emission failure must not break readiness)
    try {
      await emitGateEvent(store, streamId, 'plan-coverage', 'planning', true, {
        dimension: 'D1',
        phase: 'delegate',
        taskCount,
        gatePassRate: readiness.quality.gatePassRate,
      });
    } catch { /* fire-and-forget */ }

    // Compute task classifications when tasks are provided (advisory)
    const taskClassifications = args.tasks
      ? args.tasks.map(classifyTask)
      : undefined;

    const result: PrepareDelegationResult = {
      ready: true,
      readiness: effectiveReadiness,
      qualityHints,
      ...(args.nativeIsolation ? { isolation: 'native' as const } : {}),
      ...(taskClassifications ? { taskClassifications } : {}),
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
