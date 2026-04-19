// ─── Prepare Delegation Composite Action ─────────────────────────────────────
//
// Orchestrates pre-delegation readiness checks by querying the
// DelegationReadinessView projection, workflow state, and code quality view,
// returning a unified readiness assessment with quality hints for subagent
// prompt assembly.
// ────────────────────────────────────────────────────────────────────────────

import { execFileSync } from 'node:child_process';
import type { ToolResult } from '../format.js';
import type { ResolvedProjectConfig } from '../config/resolve.js';
import { DEFAULTS } from '../config/resolve.js';
import type { EventStore } from '../event-store/store.js';
import { orchestrateLogger } from '../logger.js';
import type { DispatchContext } from '../core/dispatch.js';
import {
  getOrCreateMaterializer,
  getOrCreateEventStore,
  queryDeltaEvents,
} from '../views/tools.js';
import {
  validateBranchAncestry,
  assertMainWorktree,
  getCurrentBranch,
  assertCurrentBranchNotProtected,
} from './dispatch-guard.js';
import type { AncestryResult } from './dispatch-guard.js';
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
import {
  shouldEnforceCheckpoint,
  CHECKPOINT_OPERATION_THRESHOLD,
} from '../workflow/checkpoint.js';
import type { CheckpointEnforcementConfig } from '../workflow/checkpoint.js';

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
  readonly recommendedModel: 'opus' | 'sonnet' | 'haiku';
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
 * Resolves the recommended model for a given agent type from the agent config.
 * Falls back to `defaultModel` when no per-agent override exists.
 */
function resolveModel(
  agent: 'scaffolder' | 'implementer',
  agentConfig: ResolvedProjectConfig['agents'],
): 'opus' | 'sonnet' | 'haiku' {
  return agentConfig.models[agent] ?? agentConfig.defaultModel;
}

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
export function classifyTask(
  task: TaskInput,
  agentConfig: ResolvedProjectConfig['agents'] = DEFAULTS.agents,
): TaskClassification {
  // Check testLayer first (highest priority)
  if (task.testLayer === 'acceptance') {
    const recommendedAgent = 'implementer' as const;
    return {
      taskId: task.id,
      complexity: 'high',
      recommendedAgent,
      recommendedModel: resolveModel(recommendedAgent, agentConfig),
      effort: 'high',
      reason: 'Acceptance test task — requires understanding feature intent holistically',
    };
  }

  if (task.testLayer === 'integration') {
    const recommendedAgent = 'implementer' as const;
    return {
      taskId: task.id,
      complexity: 'medium',
      recommendedAgent,
      recommendedModel: resolveModel(recommendedAgent, agentConfig),
      effort: 'medium',
      reason: 'Integration layer task — preserve implementer lane',
    };
  }

  const titleLower = task.title.toLowerCase();

  // Check scaffolding keywords
  const matchedKeyword = SCAFFOLDING_KEYWORDS.find(kw => titleLower.includes(kw));
  if (matchedKeyword) {
    const recommendedAgent = 'scaffolder' as const;
    return {
      taskId: task.id,
      complexity: 'low',
      recommendedAgent,
      recommendedModel: resolveModel(recommendedAgent, agentConfig),
      effort: 'low',
      reason: `Title contains scaffolding keyword "${matchedKeyword}"`,
    };
  }

  // Check high-complexity signals
  if (task.blockedBy && task.blockedBy.length >= 2) {
    const recommendedAgent = 'implementer' as const;
    return {
      taskId: task.id,
      complexity: 'high',
      recommendedAgent,
      recommendedModel: resolveModel(recommendedAgent, agentConfig),
      effort: 'high',
      reason: `Task has ${task.blockedBy.length} dependencies (>= 2 threshold)`,
    };
  }

  if (task.files && task.files.length >= 3) {
    const recommendedAgent = 'implementer' as const;
    return {
      taskId: task.id,
      complexity: 'high',
      recommendedAgent,
      recommendedModel: resolveModel(recommendedAgent, agentConfig),
      effort: 'high',
      reason: `Task touches ${task.files.length} files (>= 3 threshold)`,
    };
  }

  // Default: medium complexity
  const recommendedAgent = 'implementer' as const;
  return {
    taskId: task.id,
    complexity: 'medium',
    recommendedAgent,
    recommendedModel: resolveModel(recommendedAgent, agentConfig),
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

// Audit-trail events must persist before the handler returns so callers
// that query the stream immediately after dispatch observe them
// (read-your-writes). Failures are logged, never propagated — emission is
// best-effort; the dispatch response itself is what the caller acts on.
async function emitAuditEvent(
  store: EventStore,
  streamId: string,
  event: Parameters<EventStore['append']>[1],
): Promise<void> {
  try {
    await store.append(streamId, event);
  } catch (err) {
    orchestrateLogger.warn(
      {
        streamId,
        eventType: event.type,
        err: err instanceof Error ? err.message : String(err),
      },
      'audit event emission failed',
    );
  }
}

// ─── Git Exec Helper ───────────────────────────────────────────────────────

function createGitExec(): (args: readonly string[]) => string {
  return (args: readonly string[]): string => {
    return execFileSync('git', [...args], {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  };
}

// ─── Handler ────────────────────────────────────────────────────────────────

export async function handlePrepareDelegation(
  args: { featureId: string; tasks?: TaskInput[]; nativeIsolation?: boolean },
  stateDir: string,
  ctx?: DispatchContext,
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

    // ─── DR-1: Branch Ancestry Preflight ────────────────────────────────
    // Materialize workflow state early to get integrationBranch
    const wsEvents = await queryDeltaEvents(store, materializer, streamId, WORKFLOW_STATE_VIEW);
    const workflowState = materializer.materialize<WorkflowStateView>(
      streamId,
      WORKFLOW_STATE_VIEW,
      wsEvents,
    );

    const gitExec = createGitExec();
    const currentBranch = getCurrentBranch(gitExec);

    // #1129 C: refuse dispatch from a protected base branch (main/master).
    // Runs before ancestry because 'integrationBranch descends from main'
    // trivially passes when HEAD is on main — that case must be caught
    // at HEAD inspection, not ancestry.
    const protectionResult = assertCurrentBranchNotProtected(currentBranch);
    if (protectionResult.blocked) {
      await emitAuditEvent(store, streamId, {
        type: 'preflight.blocked',
        data: {
          reason: protectionResult.reason,
          details: {
            currentBranch: protectionResult.currentBranch,
          },
        },
      });

      return {
        success: true,
        data: {
          blocked: true,
          reason: protectionResult.reason,
          currentBranch: protectionResult.currentBranch,
        },
      };
    }

    // #1129 D: derive integration branch from workflow state, falling
    // back to the current checked-out branch — never to featureId, which
    // is a different namespace and produces misleading git-errors.
    const integrationBranch =
      workflowState.synthesis?.integrationBranch ?? currentBranch ?? args.featureId;
    const ancestryResult = await validateBranchAncestry(
      integrationBranch,
      ['main'],
      gitExec,
    );

    if (ancestryResult.blocked) {
      await emitAuditEvent(store, streamId, {
        type: 'preflight.blocked',
        data: {
          reason: ancestryResult.reason,
          details: {
            ...(ancestryResult.missing ? { missing: ancestryResult.missing } : {}),
            ...(ancestryResult.error ? { error: ancestryResult.error } : {}),
          },
        },
      });

      return {
        success: true,
        data: {
          blocked: true,
          reason: ancestryResult.reason,
          ...(ancestryResult.missing ? { missing: ancestryResult.missing } : {}),
          ...(ancestryResult.error ? { error: ancestryResult.error } : {}),
        },
      };
    }

    // ─── DR-2: Worktree Location Assertion ──────────────────────────────
    // Skip worktree check when nativeIsolation is true (Claude Code manages isolation)
    if (!args.nativeIsolation) {
      const worktreeResult = assertMainWorktree();
      if (!worktreeResult.isMain) {
        await emitAuditEvent(store, streamId, {
          type: 'preflight.blocked',
          data: {
            reason: 'worktree-location',
            details: {
              actual: worktreeResult.actual,
              expected: worktreeResult.expected,
            },
          },
        });

        return {
          success: true,
          data: {
            blocked: true,
            reason: 'worktree-location',
            actual: worktreeResult.actual,
            expected: worktreeResult.expected,
          },
        };
      }
    }

    const checksRun = args.nativeIsolation ? ['ancestry'] : ['ancestry', 'worktree'];
    await emitAuditEvent(store, streamId, {
      type: 'preflight.executed',
      data: {
        checks: checksRun,
        passed: true,
        integrationBranch,
      },
    });

    // ─── DR-5: Checkpoint Gate ──────────────────────────────────────────
    const checkpointConfig: CheckpointEnforcementConfig = ctx?.projectConfig?.checkpoint ?? {
      operationThreshold: CHECKPOINT_OPERATION_THRESHOLD,
      enforceOnPhaseTransition: true,
      enforceOnWaveDispatch: true,
    };

    const gateResult = shouldEnforceCheckpoint(
      workflowState._checkpoint,
      checkpointConfig,
      'wave-dispatch',
    );

    const checkpointWarnings: string[] = [];

    if (gateResult.gated) {
      await emitAuditEvent(store, streamId, {
        type: 'checkpoint.enforced',
        data: {
          operationsSince: gateResult.operationsSince,
          threshold: gateResult.threshold,
          blockedAction: 'wave-dispatch',
        },
      });

      return {
        success: true,
        data: {
          gated: true,
          gate: gateResult.gate,
          operationsSince: gateResult.operationsSince,
          threshold: gateResult.threshold,
        },
      };
    }

    if (gateResult.warning) {
      checkpointWarnings.push(`checkpoint: ${gateResult.warning}`);
    }

    // Materialize delegation readiness from event stream
    const drEvents = await queryDeltaEvents(store, materializer, streamId, DELEGATION_READINESS_VIEW);
    const readiness = materializer.materialize<DelegationReadinessState>(
      streamId,
      DELEGATION_READINESS_VIEW,
      drEvents,
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
      return {
        success: true,
        data: result,
        ...(checkpointWarnings.length > 0 ? { warnings: checkpointWarnings } : {}),
      };
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
    const agentConfig = ctx?.projectConfig?.agents ?? DEFAULTS.agents;
    const taskClassifications = args.tasks
      ? args.tasks.map(t => classifyTask(t, agentConfig))
      : undefined;

    const result: PrepareDelegationResult = {
      ready: true,
      readiness: effectiveReadiness,
      qualityHints,
      ...(args.nativeIsolation ? { isolation: 'native' as const } : {}),
      ...(taskClassifications ? { taskClassifications } : {}),
    };
    return {
      success: true,
      data: result,
      ...(checkpointWarnings.length > 0 ? { warnings: checkpointWarnings } : {}),
    };
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
