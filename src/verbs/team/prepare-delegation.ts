/**
 * The `prepare_delegation` composite action. It checks readiness before a delegation wave.
 * It reads the delegation-readiness view, the workflow state, and the code-quality view.
 * It returns one readiness result, with quality hints and task classifications for the subagent prompts.
 */

import { execFileSync } from 'node:child_process';
import type { ToolResult } from '../../format.js';
import type { ResolvedProjectConfig } from '../../config/resolve.js';
import { DEFAULTS } from '../../config/resolve.js';
import { SequenceConflictError, type EventStore } from '../../events/store.js';
import { orchestrateLogger } from '../../logger.js';
import type { DispatchContext } from '../../dispatch/core/dispatch.js';
import { foldToTail } from '../../projections/fold-at-tail.js';
import { getOrCreateMaterializer } from '../../projections/views/tools.js';
import {
  validateBranchAncestry,
  assertMainWorktree,
  getCurrentBranch,
  assertCurrentBranchNotProtected,
  probeStashAndEmit,
} from './dispatch-guard.js';
import type { AncestryResult } from './dispatch-guard.js';
import { assertWorktreeBaseRefPinned } from './worktree-baseref.js';
import {
  WORKFLOW_STATE_VIEW,
} from '../../projections/views/workflow-state-projection.js';
import type { WorkflowStateView } from '../../projections/views/workflow-state-projection.js';
import {
  CODE_QUALITY_VIEW,
} from '../../projections/views/code-quality-view.js';
import type { CodeQualityViewState } from '../../projections/views/code-quality-view.js';
import {
  DELEGATION_READINESS_VIEW,
  computeScopedWorktrees,
  scopeReadinessToWave,
} from '../../projections/views/delegation-readiness-view.js';
import type { DelegationReadinessState } from '../../projections/views/delegation-readiness-view.js';
import { generateQualityHints } from '../../projections/quality/hints.js';
import type { QualityHint } from '../../projections/quality/hints.js';
import { emitGateEvent } from '../gates/gate-utils.js';
import { parseTaskStamps, stampForTask } from '../tasks/parse-task-stamps.js';
import { readFile } from 'node:fs/promises';
import { queryTelemetryState } from '../../projections/telemetry/telemetry-queries.js';
import type { TelemetryViewState } from '../../projections/telemetry/telemetry-projection.js';
import {
  shouldEnforceCheckpoint,
  CHECKPOINT_OPERATION_THRESHOLD,
} from '../../workflow/checkpoint.js';
import type { CheckpointEnforcementConfig } from '../../workflow/checkpoint.js';
import { globToRegExp } from '../../architecture/glob-to-regexp.js';
import type { GateName } from '../../workflow/verification-policy.js';
import { deriveWorkflowRiskTier } from '../../workflow/verification-policy.js';
import { resolveGateSet, ladderGateNames } from '../../workflow/phase-kind.js';
import type { PhaseKind } from '../../workflow/phase-kind.js';
import {
  mintCapabilitiesForKind,
  requireMutationCapabilities,
  type RuntimeHandshake,
} from '../../workflow/capabilities/resolver.js';
import type { Capability } from '../../runtime/agents/capabilities.js';
import {
  buildVerificationNote,
  reconstructImplementerPrompt,
  IMPLEMENTER_PROMPT_TEMPLATE,
} from '../../runtime/agents/definitions.js';
import { dispatchShapeFor, type DispatchShape } from '../../runtime/agents/dispatch-shape.js';
import type { AgentPosture } from '../../runtime/agents/types.js';

/**
 * The posture of the mutating agents that a delegated wave dispatches.
 * The emitted `posture` and `dispatch` both derive from this one value, so they cannot drift.
 */
const DELEGATION_POSTURE = 'task-isolated' satisfies AgentPosture;

/**
 * The launch shape that the orchestrator must use for a delegated wave: a named subagent with worktree isolation.
 * A name without a worktree gives a mailbox teammate that cannot run. A worktree without a name cannot be addressed for merge.
 */
const DELEGATION_DISPATCH: DispatchShape = dispatchShapeFor(DELEGATION_POSTURE);

export type { DelegationReadinessState } from '../../projections/views/delegation-readiness-view.js';

/** Input shape for a task passed to prepare_delegation. */
export interface TaskInput {
  readonly id: string;
  readonly title: string;
  readonly blockedBy?: readonly string[];
  readonly files?: readonly string[];
  readonly testLayer?: 'acceptance' | 'integration' | 'unit' | 'property';
  /** The risk tier from the planner. When present, it wins over the heuristic in {@link deriveRiskTier}. */
  readonly riskTier?: RiskTier;
  /** The boundary flag from the planner. When present, it wins over the heuristic in {@link deriveBoundaryTouching}. */
  readonly boundaryTouching?: boolean;
}

/** The ordered risk tier of the verification ladder. */
export type RiskTier = 'low' | 'medium' | 'high';

/**
 * The advisory classification of one task.
 * `effort` omits `max`, because the heuristic covers only the scaffolder and implementer tiers. Only a manual override sets `max`.
 */
export interface TaskClassification {
  readonly taskId: string;
  readonly complexity: 'low' | 'medium' | 'high';
  readonly recommendedAgent: 'scaffolder' | 'implementer';
  readonly recommendedModel: 'opus' | 'sonnet' | 'haiku';
  readonly effort: 'low' | 'medium' | 'high';
  readonly reason: string;
  /** The risk tier of the verification ladder, from the blast radius of the task, unless the planner stamped `riskTier`. */
  readonly riskTier: RiskTier;
  /** True when the task crosses an I/O or schema boundary. It is independent of {@link riskTier}. */
  readonly boundaryTouching: boolean;
  /** The ordered verification gates that the task must clear, from the policy table for its tier and boundary flag. */
  readonly verificationSequence: readonly GateName[];
  /**
   * The key of the tier profile of this task in `result.verificationNotes`, in the form `"<riskTier>|<boundaryTouching>"`.
   * The orchestrator splices that note into `result.implementerPromptTemplate` to rebuild the exact prompt of the task.
   * The note is the variant for the resolved tier, never a static medium default.
   */
  readonly verificationNoteKey: string;
  /**
   * The full implementer prompt for the tier, present only when the caller sets `detail: true` or `outputFormat: 'prompt-only'`.
   * The default response omits it, because the shared template and the note key rebuild it byte for byte.
   */
  readonly implementerPrompt?: string;
}

export interface PrepareDelegationResult {
  readonly ready: boolean;
  readonly readiness: DelegationReadinessState;
  /** The trust tier of the agents that this wave dispatches, so a reader can check {@link dispatch} against it. */
  readonly posture: typeof DELEGATION_POSTURE;
  /**
   * The launch shape that the orchestrator must use: a named subagent with worktree isolation.
   * The field is required, so the compiler makes each return path carry it.
   */
  readonly dispatch: DispatchShape;
  /**
   * The integration branch that each task of the wave forks from. The kill probe measures the task
   * diff from it, so the task-completion runbook binds it as `baseRef`. Without it, the gate blocks
   * and does not guess a base.
   */
  readonly baseBranch: string;
  readonly blockers?: string[];
  readonly qualityHints?: Array<{ category: string; severity: string; hint: string }>;
  readonly isolation?: 'native';
  readonly taskClassifications?: readonly TaskClassification[];
  /** The shared implementer-prompt template, once in each response. It is present when `taskClassifications` is present. */
  readonly implementerPromptTemplate?: string;
  /**
   * The distinct verification notes of the wave, keyed by `"<riskTier>|<boundaryTouching>"`.
   * The template with `verificationNotes[task.verificationNoteKey]` spliced in gives the full prompt of a task.
   */
  readonly verificationNotes?: Readonly<Record<string, string>>;
}

import { TASK_SCAFFOLDING_KEYWORDS as SCAFFOLDING_KEYWORDS } from '../tasks/scaffolding-keywords.js';

/**
 * File globs whose presence marks a task HIGH risk — schema/type/API/
 * shared-contract surfaces whose blast radius spans the codebase.
 */
export const HIGH_RISK_GLOBS: readonly string[] = [
  '**/*schema*',
  '**/types/**',
  '**/*.d.ts',
  '**/api/**',
  '**/contracts/**',
  /**
   * Schema and contract artifacts are high risk even when a low-risk YAML glob also matches them, because the high rules run first.
   * They also mark a task boundary-touching through {@link BOUNDARY_GLOBS}.
   */
  '**/*.proto',
  '**/openapi.*',
  '**/*.graphql',
];

/**
 * File globs that, when ALL of a task's files match, mark it LOW risk —
 * documentation / configuration / rename-only surfaces.
 */
export const LOW_RISK_GLOBS: readonly string[] = [
  '**/*.md',
  '**/*.json',
  '**/*.yml',
  '**/*.yaml',
  'docs/**',
];

/**
 * File globs that mark a task BOUNDARY-TOUCHING — I/O adapters, clients,
 * transport, and schema artifacts that define a cross-process contract.
 */
export const BOUNDARY_GLOBS: readonly string[] = [
  '**/adapters/**',
  '**/clients/**',
  '**/io/**',
  '**/http/**',
  '**/*.proto',
  '**/openapi.*',
  '**/*.graphql',
];

/**
 * The size bound of the compiled-glob cache. It protects against a caller of the exported API that passes arbitrary patterns.
 * On overflow the cache clears, because recompilation is cheap.
 */
const GLOB_MATCHER_CACHE_MAX = 256;
const globMatcherCache = new Map<string, RegExp>();

function compileGlob(pattern: string): RegExp {
  const cached = globMatcherCache.get(pattern);
  if (cached) return cached;
  const compiled = globToRegExp(pattern);
  if (globMatcherCache.size >= GLOB_MATCHER_CACHE_MAX) globMatcherCache.clear();
  globMatcherCache.set(pattern, compiled);
  return compiled;
}

function fileMatchesAny(file: string, globs: readonly string[]): boolean {
  return globs.some((g) => compileGlob(g).test(file));
}

/**
 * Derives the risk tier of a task for the verification ladder. The first match wins:
 * 1. The planner stamp `task.riskTier`.
 * 2. High: a file matches {@link HIGH_RISK_GLOBS}, or `testLayer` is `acceptance`, or the task has 2 or more blockers or 3 or more files.
 * 3. Low: the task has files, and each file matches {@link LOW_RISK_GLOBS}.
 * 4. Medium in each other case.
 */
export function deriveRiskTier(task: TaskInput): RiskTier {
  if (task.riskTier !== undefined) return task.riskTier;

  const files = task.files ?? [];

  if (files.some((f) => fileMatchesAny(f, HIGH_RISK_GLOBS))) return 'high';
  if (task.testLayer === 'acceptance') return 'high';
  if ((task.blockedBy?.length ?? 0) >= 2) return 'high';
  if (files.length >= 3) return 'high';

  if (files.length > 0 && files.every((f) => fileMatchesAny(f, LOW_RISK_GLOBS))) {
    return 'low';
  }

  return 'medium';
}

/**
 * Derives whether a task crosses an I/O or schema boundary. The first match wins:
 * 1. The planner stamp `task.boundaryTouching`.
 * 2. `testLayer` is `integration` or `acceptance`.
 * 3. A file matches {@link BOUNDARY_GLOBS}.
 *
 * The result is independent of {@link deriveRiskTier}.
 */
export function deriveBoundaryTouching(task: TaskInput): boolean {
  if (task.boundaryTouching !== undefined) return task.boundaryTouching;

  if (task.testLayer === 'integration' || task.testLayer === 'acceptance') {
    return true;
  }

  const files = task.files ?? [];
  return files.some((f) => fileMatchesAny(f, BOUNDARY_GLOBS));
}

/**
 * Resolves the model for an agent type from the agent config, with `defaultModel` as the fallback.
 * It does not set the dispatched model. {@link resolveModelForTask} sets that model from the tier.
 */
function resolveModel(
  agent: 'scaffolder' | 'implementer',
  agentConfig: ResolvedProjectConfig['agents'],
): 'opus' | 'sonnet' | 'haiku' {
  return agentConfig.models[agent] ?? agentConfig.defaultModel;
}

/**
 * Resolves the dispatch model of a task from its `riskTier` through `agents.tierModels`.
 * The tier wins over the agent split, so a high-tier scaffolding task keeps `agent=scaffolder` but gets the high-tier model.
 * The function does not read `agent`. Config resolution fills `tierModels` for each tier, so the lookup is total.
 */
function resolveModelForTask(
  agent: 'scaffolder' | 'implementer',
  riskTier: RiskTier,
  agentConfig: ResolvedProjectConfig['agents'],
): 'opus' | 'sonnet' | 'haiku' {
  void agent;
  return agentConfig.tierModels[riskTier];
}
/**
 * The agent, complexity, and effort part of a classification. {@link classifyTask} adds the verification-ladder fields.
 */
type CoreClassification = Omit<
  TaskClassification,
  | 'riskTier'
  | 'boundaryTouching'
  | 'verificationSequence'
  | 'verificationNoteKey'
  | 'implementerPrompt'
>;

/**
 * The agent, complexity, and effort heuristic. The first match wins:
 * 1. `testLayer` is `acceptance`: high, implementer.
 * 2. `testLayer` is `integration`: medium, implementer.
 * 3. The title holds a scaffolding keyword: low, scaffolder.
 * 4. The task has 2 or more blockers, or 3 or more files: high, implementer.
 * 5. Medium, implementer in each other case.
 *
 * The `recommendedModel` here is a placeholder. {@link classifyTask} replaces it with the tier-keyed model, so it is not the dispatched model.
 */
function classifyTaskCore(
  task: TaskInput,
  agentConfig: ResolvedProjectConfig['agents'],
): CoreClassification {
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

/**
 * The key of a tier profile in the shared notes map.
 * Tasks with the same `(riskTier, boundaryTouching)` share one note, so the key has six possible values.
 */
export function verificationNoteKey(riskTier: RiskTier, boundaryTouching: boolean): string {
  return `${riskTier}|${boundaryTouching}`;
}

/** Options for the classification of one task. */
export interface ClassifyTaskOptions {
  /** When true, the result also holds the full implementer prompt for the tier in `implementerPrompt`. The default is off. */
  readonly includeImplementerPrompt?: boolean;
}

/**
 * Classifies one task with a deterministic, advisory heuristic.
 * The result adds `riskTier`, `boundaryTouching`, and `verificationSequence` to the {@link classifyTaskCore} fields.
 * The sequence comes from {@link resolveGateSet} for the `IMPLEMENT` kind, so each `IMPLEMENT` phase resolves the same ladder.
 * That resolver applies the verification overrides of `.exarchos.yml`, and it uses the built-in table when `config` is absent.
 *
 * The tier-keyed model replaces the model of the agent split, so the model mix follows the tier distribution.
 * The note text goes to the shared `verificationNotes` map, and only the key goes on each task.
 * `riskTier` is a separate axis from `effort`: a low-effort scaffolding task can be high risk when it edits a schema.
 */
export function classifyTask(
  task: TaskInput,
  agentConfig: ResolvedProjectConfig['agents'] = DEFAULTS.agents,
  config?: ResolvedProjectConfig,
  opts?: ClassifyTaskOptions,
): TaskClassification {
  const core = classifyTaskCore(task, agentConfig);
  const riskTier = deriveRiskTier(task);
  const boundaryTouching = deriveBoundaryTouching(task);
  return {
    ...core,
    recommendedModel: resolveModelForTask(core.recommendedAgent, riskTier, agentConfig),
    riskTier,
    boundaryTouching,
    verificationSequence: ladderGateNames(
      resolveGateSet('IMPLEMENT', { riskTier, boundaryTouching, config }),
    ),
    verificationNoteKey: verificationNoteKey(riskTier, boundaryTouching),
    ...(opts?.includeImplementerPrompt
      ? {
          implementerPrompt: reconstructImplementerPrompt({
            verificationNote: buildVerificationNote({ riskTier, boundaryTouching }),
          }),
        }
      : {}),
  };
}

/**
 * The phase kind of the wave-dispatch boundary.
 * `satisfies` keeps the literal type, so `requireMutationCapabilities` rejects the bundle at compile time if this kind becomes read-only.
 */
const DISPATCH_PHASE_KIND = 'IMPLEMENT' satisfies PhaseKind;

/**
 * Asserts that the dispatch phase kind grants mutation before a wave of mutating agents dispatches.
 * At compile time, `requireMutationCapabilities` rejects a read-only bundle.
 * At runtime, a handshake that revokes `fs:write` gives a bundle without that token, and the function throws.
 * The wave-dispatch caller turns the throw into a `phase.blocked` diagnostic.
 */
export function assertDispatchMutationCapabilities(
  handshake: RuntimeHandshake = {},
): ReadonlySet<Capability> {
  const caps = requireMutationCapabilities(
    mintCapabilitiesForKind(DISPATCH_PHASE_KIND, handshake),
  );
  if (!caps.has('fs:write')) {
    throw new Error(
      `dispatch capability check failed: ${DISPATCH_PHASE_KIND} posture resolved without fs:write — the runtime handshake revoked the worktree-mutation token`,
    );
  }
  return caps;
}

/** Stable error code for a fail-closed gate-set boundary block. */
export const PHASE_BLOCKED_CODE = 'PHASE_BLOCKED';

/**
 * The diagnostic payload of a fail-closed gate-set boundary block. Field shape
 * matches the `phase.blocked` event schema (`events/schemas.ts`):
 * `{ phase, kind, reason, error: { code, message } }`.
 */
export interface PhaseBlockedInfo {
  readonly phase: string;
  readonly kind: PhaseKind;
  readonly reason: string;
  readonly error: { readonly code: string; readonly message: string };
}

/** The result of the fail-closed classification: the classifications, or a block with no task stamped. */
export type ClassifyTasksResult =
  | { readonly ok: true; readonly classifications: TaskClassification[] }
  | { readonly ok: false; readonly blocked: PhaseBlockedInfo };

/**
 * Classifies a whole wave at the gate-set boundary and fails closed, with no I/O.
 * A throw from {@link resolveGateSet} or from {@link assertDispatchMutationCapabilities} blocks the whole wave, and no task is stamped.
 * The result then holds a {@link PhaseBlockedInfo} that the caller records as a `phase.blocked` event.
 *
 * @param tasks the tasks of the wave
 * @param agentConfig resolved agent config, for model routing
 * @param config resolved project config. When it is absent, the built-in table applies, and the function does not block.
 * @param phase the lifecycle phase of the dispatch, for the diagnostic
 */
export function classifyTasksFailClosed(
  tasks: readonly TaskInput[],
  agentConfig: ResolvedProjectConfig['agents'] = DEFAULTS.agents,
  config?: ResolvedProjectConfig,
  phase = 'delegate',
  opts?: ClassifyTaskOptions,
): ClassifyTasksResult {
  try {
    assertDispatchMutationCapabilities();
    return {
      ok: true,
      classifications: tasks.map(t => classifyTask(t, agentConfig, config, opts)),
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      blocked: {
        phase,
        kind: DISPATCH_PHASE_KIND,
        reason: `dispatch blocked: ${DISPATCH_PHASE_KIND} gate-set resolution failed — ${message}`,
        error: { code: PHASE_BLOCKED_CODE, message },
      },
    };
  }
}

/**
 * Merges the parsed plan stamps onto the task inputs of the caller, with no I/O.
 * A field already on the entry wins over the stamp, and the stamp wins over the heuristic. A stamp fills only a missing field.
 * When the `riskTier` comes from the stamp and differs from the heuristic tier, the function adds an advisory. The advisory never blocks.
 * The heuristic uses the original task, because the stamp context can hide a real difference.
 */
export function applyPlanStamps(
  tasks: readonly TaskInput[],
  stamps: ReturnType<typeof parseTaskStamps>,
): { readonly tasks: TaskInput[]; readonly advisories: string[] } {
  const advisories: string[] = [];
  const merged = tasks.map((t) => {
    const stamp = stampForTask(stamps, t.id);
    if (!stamp) return t;
    const hasFiles = t.files !== undefined && t.files.length > 0;
    const hasDeps = t.blockedBy !== undefined && t.blockedBy.length > 0;
    const resolved: TaskInput = {
      ...t,
      ...(t.riskTier === undefined && stamp.riskTier !== undefined
        ? { riskTier: stamp.riskTier }
        : {}),
      ...(t.boundaryTouching === undefined && stamp.boundaryTouching !== undefined
        ? { boundaryTouching: stamp.boundaryTouching }
        : {}),
      ...(t.testLayer === undefined && stamp.testLayer !== undefined
        ? { testLayer: stamp.testLayer }
        : {}),
      ...(!hasFiles && stamp.files.length > 0 ? { files: stamp.files } : {}),
      ...(!hasDeps && stamp.blockedBy.length > 0 ? { blockedBy: stamp.blockedBy } : {}),
    };
    const riskTierFromStamp = t.riskTier === undefined && stamp.riskTier !== undefined;
    if (riskTierFromStamp) {
      const heuristicTier = deriveRiskTier(t);
      if (heuristicTier !== stamp.riskTier) {
        advisories.push(
          `task ${t.id}: plan stamp riskTier="${stamp.riskTier}" overrode heuristic "${heuristicTier}"`,
        );
      }
    }
    return resolved;
  });
  return { tasks: merged, advisories };
}

const WORKTREE_BLOCKER_PATTERNS = [
  'worktrees pending',
  'worktrees failed',
  'no worktrees expected',
];

function isWorktreeBlocker(blocker: string): boolean {
  return WORKTREE_BLOCKER_PATTERNS.some(p => blocker.includes(p));
}

/**
 * A desync diagnostic for when `plan.taskCount` of the projection differs from the length of `workflowState.tasks`.
 * The caller shows it in the blocker list but computes `ready` without it.
 * It is empty when `plan.taskCount` is 0, because a new workflow has no `task.assigned` events yet.
 */
function computeDesyncBlockers(
  workflowState: WorkflowStateView,
  readiness: DelegationReadinessState,
): readonly string[] {
  const stateTasks = Array.isArray(workflowState.tasks) ? workflowState.tasks.length : 0;
  const planCount = readiness.plan.taskCount;

  if (planCount === 0) return [];
  if (stateTasks === planCount) return [];

  return [
    `state-vs-plan desync: workflow.tasks has ${stateTasks} entries but plan.taskCount is ${planCount} (likely stale state after plan-review revision)`,
  ];
}

export { computeScopedWorktrees, scopeReadinessToWave };
export type { ScopedWorktreesResult } from '../../projections/views/delegation-readiness-view.js';


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

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** How many reads the announcement makes before it gives the tail up to the writers moving it. */
const ANNOUNCE_ATTEMPTS = 3;

/** A planned task as the workflow state lists it: an id and a title, nothing assumed. */
function plannedTask(entry: unknown): { readonly id: string; readonly title: string } | undefined {
  if (!isPlainRecord(entry)) return undefined;
  const { id, title } = entry;
  return typeof id === 'string' && typeof title === 'string' ? { id, title } : undefined;
}

/**
 * Appends one `task.assigned` for each task that the stream has not announced, before the readiness fold counts them.
 * The function skips an announced task, because the projection reads a second announcement as a return to `assigned`.
 * Each append has a per-task idempotency key and a guard on the tail that the read saw.
 * When another writer appends in the gap, the guard refuses and the function reads again. It makes up to `ANNOUNCE_ATTEMPTS` attempts in total.
 */
async function announceTasks(
  store: EventStore,
  streamId: string,
  tasks: readonly { readonly id: string; readonly title: string }[],
): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    const heard = new Set<string>();
    let tail = 0;
    for (const event of await store.query(streamId)) {
      tail = Math.max(tail, event.sequence);
      if (event.type !== 'task.assigned') continue;
      const taskId = isPlainRecord(event.data) ? event.data.taskId : undefined;
      if (typeof taskId === 'string') heard.add(taskId);
    }
    try {
      for (const task of tasks) {
        if (heard.has(task.id)) continue;
        heard.add(task.id);
        await store.append(
          streamId,
          { type: 'task.assigned', data: { taskId: task.id, title: task.title } },
          { idempotencyKey: `${streamId}:task.assigned:${task.id}`, expectedSequence: tail },
        );
        tail += 1;
      }
      return;
    } catch (err) {
      if (!(err instanceof SequenceConflictError) || attempt >= ANNOUNCE_ATTEMPTS) throw err;
    }
  }
}

/**
 * Runs {@link announceTasks} and logs a failure without propagating it.
 * A task that the function did not announce shows as a blocker in the readiness fold.
 */
async function announceTasksBestEffort(
  store: EventStore,
  streamId: string,
  tasks: readonly { readonly id: string; readonly title: string }[],
): Promise<void> {
  try {
    await announceTasks(store, streamId, tasks);
  } catch (err) {
    orchestrateLogger.warn(
      { streamId, tasks: tasks.map((task) => task.id), err: err instanceof Error ? err.message : String(err) },
      'task announcement failed',
    );
  }
}

/**
 * Appends an audit event and waits for it, so a caller that queries the stream after dispatch sees the event.
 * A failure is logged and not propagated, because the caller acts on the dispatch response.
 */
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

/**
 * Writes the workflow `riskTier` to `state.riskTier` through a best-effort `state.patched` event.
 * The required-reviews contract of `/review` reads that field, so a high tier adds the `mutation-adequacy` review.
 * The event has no idempotency key on the tier value, because such a key drops a tier that rises again after a fall.
 * The fold is last-write-wins, so a repeated patch with the same value has no effect.
 */
export async function persistWorkflowRiskTier(
  store: EventStore,
  streamId: string,
  riskTier: RiskTier,
): Promise<void> {
  await emitAuditEvent(store, streamId, {
    type: 'state.patched',
    data: { featureId: streamId, fields: ['riskTier'], patch: { riskTier } },
  });
}

function createGitExec(): (args: readonly string[]) => string {
  return (args: readonly string[]): string => {
    return execFileSync('git', [...args], {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  };
}

/**
 * The warning for native isolation when the host must create worktrees but none is ready at prepare time.
 * Dispatch can then put agents in the shared checkout. The host owns isolation, so this is a warning and not a blocker.
 */
function sharedCheckoutHazardWarning(expected: number): string {
  return (
    `native isolation requested; ${expected} worktree(s) expected but 0 confirmed ready — ` +
    `verify the host materializes worktrees or dispatch may land in the shared checkout`
  );
}

/**
 * Checks delegation readiness for a wave. It returns the readiness result, the dispatch shape, and the task classifications.
 * The handler checks each task field, because a non-MCP caller passes `tasks` through an unchecked cast. A malformed task otherwise reports as a false `phase.blocked`.
 *
 * Under native isolation, the protected-branch and worktree-location guards do not run, and the base-ref guard runs.
 * The server reads HEAD from its own launch checkout, so the protected-branch guard gives a false positive when the orchestrator works from a worktree.
 * The protected-branch guard runs before the ancestry guard, because ancestry always passes when HEAD is on `main`.
 * Each dispatch that reaches the guards records one `dispatch.preflight` event. A guard that did not run records `passed: true`, but `baseRef` is absent without native isolation.
 *
 * The handler announces the planned tasks before the readiness fold counts them. The desync diagnostic and the shared-checkout warning do not change `ready`.
 * A failed classification records `phase.blocked` and returns an error.
 */
export async function handlePrepareDelegation(
  args: {
    featureId: string;
    tasks?: TaskInput[];
    /**
     * The path to the decomposition markdown. When present, the planner stamps of each task go onto the matching `tasks[]` entry.
     * An unreadable plan gives a warning, and the heuristic tiers apply.
     */
    planPath?: string;
    nativeIsolation?: boolean;
    /**
     * The workflow risk-tier override. It wins over the highest task tier and goes to `state.riskTier` as it is.
     * So the handler rejects a value outside the vocabulary.
     */
    riskTier?: RiskTier;
    /** When true, each `taskClassifications[]` entry also holds the full implementer prompt for its tier. The default is off. */
    detail?: boolean;
    /** `'prompt-only'` has the same effect as `detail: true`. The handler also accepts `'full'`, the schema default, which has no effect. */
    outputFormat?: 'prompt-only';
  },
  stateDir: string,
  ctx?: DispatchContext,
): Promise<ToolResult> {
  if (!args.featureId) {
    return {
      success: false,
      error: { code: 'INVALID_INPUT', message: 'featureId is required' },
    };
  }

  const tasksInput: unknown = args.tasks;
  const isOptionalStringArray = (v: unknown): boolean =>
    v === undefined || (Array.isArray(v) && v.every((x) => typeof x === 'string'));
  const isOptionalOneOf = (v: unknown, allowed: readonly string[]): boolean =>
    v === undefined || (typeof v === 'string' && allowed.includes(v));
  const isOptionalBoolean = (v: unknown): boolean => v === undefined || typeof v === 'boolean';
  if (
    tasksInput !== undefined &&
    (!Array.isArray(tasksInput) ||
      tasksInput.some((task) => {
        if (task === null || typeof task !== 'object') return true;
        const t = task as {
          id?: unknown;
          title?: unknown;
          files?: unknown;
          blockedBy?: unknown;
          testLayer?: unknown;
          riskTier?: unknown;
          boundaryTouching?: unknown;
        };
        return (
          typeof t.id !== 'string' ||
          typeof t.title !== 'string' ||
          !isOptionalStringArray(t.files) ||
          !isOptionalStringArray(t.blockedBy) ||
          !isOptionalOneOf(t.testLayer, ['acceptance', 'integration', 'unit', 'property']) ||
          !isOptionalOneOf(t.riskTier, ['low', 'medium', 'high']) ||
          !isOptionalBoolean(t.boundaryTouching)
        );
      }))
  ) {
    return {
      success: false,
      error: {
        code: 'INVALID_INPUT',
        message:
          'tasks must be an array of objects each with a string id and title; optional fields must be well-typed (files/blockedBy: string[]; testLayer: acceptance|integration|unit|property; riskTier: low|medium|high; boundaryTouching: boolean)',
      },
    };
  }

  if (!isOptionalOneOf(args.riskTier, ['low', 'medium', 'high'])) {
    return {
      success: false,
      error: {
        code: 'INVALID_INPUT',
        message: 'riskTier must be one of low|medium|high',
      },
    };
  }

  if (!isOptionalBoolean(args.detail)) {
    return {
      success: false,
      error: { code: 'INVALID_INPUT', message: 'detail must be a boolean' },
    };
  }
  if (!isOptionalOneOf(args.outputFormat, ['full', 'prompt-only'])) {
    return {
      success: false,
      error: {
        code: 'INVALID_INPUT',
        message: "outputFormat must be 'full' or 'prompt-only' when provided",
      },
    };
  }

  try {
    const materializer = getOrCreateMaterializer(stateDir);
    if (!ctx?.eventStore) {
      throw new Error('handlePrepareDelegation: ctx.eventStore required');
    }
    const store = ctx.eventStore;
    const streamId = args.featureId;

    const { view: workflowState } = await foldToTail<WorkflowStateView>(
      store,
      materializer,
      streamId,
      WORKFLOW_STATE_VIEW,
    );

    const gitExec = createGitExec();
    const currentBranch = getCurrentBranch(gitExec);

    const preflightStart = Date.now();
    const guardOutcomes: {
      ancestry: { passed: boolean };
      worktree: { passed: boolean };
      protectedBranch: { passed: boolean };
      mainWorktree: { passed: boolean };
      baseRef: { passed: boolean };
    } = {
      ancestry: { passed: true },
      worktree: { passed: true },
      protectedBranch: { passed: true },
      mainWorktree: { passed: true },
      baseRef: { passed: true },
    };

    const emitDispatchPreflight = async (): Promise<void> => {
      const passed =
        guardOutcomes.ancestry.passed &&
        guardOutcomes.worktree.passed &&
        guardOutcomes.protectedBranch.passed &&
        guardOutcomes.mainWorktree.passed &&
        guardOutcomes.baseRef.passed;
      await emitAuditEvent(store, streamId, {
        type: 'dispatch.preflight',
        data: {
          guards: {
            ancestry: { passed: guardOutcomes.ancestry.passed },
            worktree: { passed: guardOutcomes.worktree.passed },
            protectedBranch: { passed: guardOutcomes.protectedBranch.passed },
            mainWorktree: { passed: guardOutcomes.mainWorktree.passed },
            ...(args.nativeIsolation
              ? { baseRef: { passed: guardOutcomes.baseRef.passed } }
              : {}),
          },
          passed,
          durationMs: Date.now() - preflightStart,
        },
      });
    };

    if (!args.nativeIsolation) {
      const protectionResult = assertCurrentBranchNotProtected(currentBranch);
      if (protectionResult.blocked) {
        guardOutcomes.protectedBranch.passed = false;
        await emitAuditEvent(store, streamId, {
          type: 'preflight.blocked',
          data: {
            reason: protectionResult.reason,
            details: {
              currentBranch: protectionResult.currentBranch,
            },
          },
        });
        await emitDispatchPreflight();

        return {
          success: true,
          data: {
            blocked: true,
            reason: protectionResult.reason,
            currentBranch: protectionResult.currentBranch,
            ...(protectionResult.hint ? { hint: protectionResult.hint } : {}),
          },
        };
      }
    }

    const integrationBranch =
      workflowState.synthesis?.integrationBranch ?? currentBranch ?? args.featureId;
    const ancestryResult = await validateBranchAncestry(
      integrationBranch,
      ['main'],
      gitExec,
    );
    guardOutcomes.ancestry.passed = ancestryResult.passed;

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
      await emitDispatchPreflight();

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

    if (!args.nativeIsolation) {
      const worktreeResult = assertMainWorktree();
      guardOutcomes.worktree.passed = worktreeResult.isMain;
      guardOutcomes.mainWorktree.passed = worktreeResult.isMain;
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
        await emitDispatchPreflight();

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
    } else {
      const baseRefResult = assertWorktreeBaseRefPinned();
      guardOutcomes.baseRef.passed = baseRefResult.pinned;
      if (!baseRefResult.pinned) {
        await emitAuditEvent(store, streamId, {
          type: 'preflight.blocked',
          data: {
            reason: baseRefResult.reason,
            details: {
              effective: baseRefResult.effective,
              checked: baseRefResult.checked,
              remediation: baseRefResult.remediation,
            },
          },
        });
        await emitDispatchPreflight();

        return {
          success: true,
          data: {
            blocked: true,
            reason: baseRefResult.reason,
            effective: baseRefResult.effective,
            remediation: baseRefResult.remediation,
            hint: baseRefResult.hint,
          },
        };
      }
    }

    const checksRun = args.nativeIsolation
      ? ['ancestry', 'baseRef']
      : ['protectedBranch', 'ancestry', 'worktree'];
    await emitAuditEvent(store, streamId, {
      type: 'preflight.executed',
      data: {
        checks: checksRun,
        passed: true,
        integrationBranch,
      },
    });

    await emitDispatchPreflight();

    await probeStashAndEmit({
      store,
      streamId,
      worktreePath: process.cwd(),
      gitExec,
    });

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

    const warnings: string[] = [];

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
      warnings.push(`checkpoint: ${gateResult.warning}`);
    }

    const planned = (Array.isArray(workflowState.tasks) ? workflowState.tasks : [])
      .map(plannedTask)
      .filter((task): task is { readonly id: string; readonly title: string } => task !== undefined);
    await announceTasksBestEffort(store, streamId, [
      ...planned,
      ...(args.tasks ?? []).map((task) => ({ id: task.id, title: task.title })),
    ]);

    const { view: readiness } = await foldToTail<DelegationReadinessState>(
      store,
      materializer,
      streamId,
      DELEGATION_READINESS_VIEW,
    );

    const scoped = computeScopedWorktrees(readiness, args.tasks);

    const baseBlockers = args.nativeIsolation
      ? scoped.blockers.filter(b => !isWorktreeBlocker(b))
      : scoped.blockers;

    const effectiveReady = baseBlockers.length === 0;

    const desyncBlockers = computeDesyncBlockers(workflowState, readiness);

    const effectiveBlockers = [...baseBlockers, ...desyncBlockers];

    const effectiveReadiness: DelegationReadinessState = {
      ...readiness,
      ready: effectiveReady,
      blockers: effectiveBlockers,
      worktrees: {
        ...readiness.worktrees,
        expected: scoped.expected,
        ready: scoped.ready,
      },
    };

    if (
      args.nativeIsolation &&
      effectiveReadiness.worktrees.expected > 0 &&
      effectiveReadiness.worktrees.ready === 0
    ) {
      warnings.push(sharedCheckoutHazardWarning(effectiveReadiness.worktrees.expected));
    }

    if (!effectiveReady) {
      const result: PrepareDelegationResult = {
        ready: false,
        readiness: effectiveReadiness,
        posture: DELEGATION_POSTURE,
        dispatch: DELEGATION_DISPATCH,
        baseBranch: integrationBranch,
        blockers: effectiveBlockers,
        ...(args.nativeIsolation ? { isolation: 'native' as const } : {}),
      };
      return {
        success: true,
        data: result,
        ...(warnings.length > 0 ? { warnings } : {}),
      };
    }

    const telemetryState = await queryTelemetryState(store, stateDir);

    let qualityState: CodeQualityViewState | null = null;
    try {
      qualityState = (await foldToTail<CodeQualityViewState>(
        store,
        materializer,
        streamId,
        CODE_QUALITY_VIEW,
      )).view;
    } catch {
    }

    const qualityHints = assembleQualityHints(qualityState, telemetryState);

    const taskCount = args.tasks?.length ?? readiness.plan.taskCount;

    try {
      await emitGateEvent(store, streamId, 'plan-coverage', 'planning', true, {
        dimension: 'D1',
        phase: 'delegate',
        taskCount,
        gatePassRate: readiness.quality.gatePassRate,
      });
    } catch {}

    const agentConfig = ctx?.projectConfig?.agents ?? DEFAULTS.agents;
    const projectConfig = ctx?.projectConfig;

    let effectiveTasks = args.tasks;
    if (args.tasks && args.planPath) {
      try {
        const planMarkdown = await readFile(args.planPath, 'utf-8');
        const lifted = applyPlanStamps(args.tasks, parseTaskStamps(planMarkdown));
        effectiveTasks = lifted.tasks;
        for (const advisory of lifted.advisories) warnings.push(`stamp: ${advisory}`);
      } catch (err) {
        warnings.push(
          `planPath unreadable (${args.planPath}) — proceeding with heuristic tiers: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    const includeImplementerPrompt =
      args.detail === true || args.outputFormat === 'prompt-only';

    let taskClassifications: TaskClassification[] | undefined;
    if (effectiveTasks) {
      const classified = classifyTasksFailClosed(
        effectiveTasks,
        agentConfig,
        projectConfig,
        workflowState.phase ?? 'delegate',
        { includeImplementerPrompt },
      );
      if (!classified.ok) {
        const { blocked } = classified;
        await emitAuditEvent(store, streamId, {
          type: 'phase.blocked',
          data: {
            phase: blocked.phase,
            kind: blocked.kind,
            reason: blocked.reason,
            error: { code: blocked.error.code, message: blocked.error.message },
          },
        });
        return {
          success: false,
          error: { code: PHASE_BLOCKED_CODE, message: blocked.reason },
        };
      }
      taskClassifications = classified.classifications;
    }

    const workflowRiskTier =
      args.riskTier ??
      (taskClassifications ? deriveWorkflowRiskTier(taskClassifications) : undefined);
    if (workflowRiskTier !== undefined) {
      await persistWorkflowRiskTier(store, streamId, workflowRiskTier);
    }

    let verificationNotes: Record<string, string> | undefined;
    if (taskClassifications) {
      verificationNotes = {};
      for (const c of taskClassifications) {
        if (verificationNotes[c.verificationNoteKey] === undefined) {
          verificationNotes[c.verificationNoteKey] = buildVerificationNote({
            riskTier: c.riskTier,
            boundaryTouching: c.boundaryTouching,
          });
        }
      }
    }

    const result: PrepareDelegationResult = {
      ready: true,
      readiness: effectiveReadiness,
      posture: DELEGATION_POSTURE,
      dispatch: DELEGATION_DISPATCH,
      baseBranch: integrationBranch,
      qualityHints,
      ...(args.nativeIsolation ? { isolation: 'native' as const } : {}),
      ...(taskClassifications ? { taskClassifications } : {}),
      ...(taskClassifications
        ? { implementerPromptTemplate: IMPLEMENTER_PROMPT_TEMPLATE }
        : {}),
      ...(verificationNotes ? { verificationNotes } : {}),
    };
    return {
      success: true,
      data: result,
      ...(warnings.length > 0 ? { warnings } : {}),
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
