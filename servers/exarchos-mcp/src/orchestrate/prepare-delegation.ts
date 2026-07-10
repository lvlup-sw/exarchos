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
  queryDeltaEvents,
} from '../views/tools.js';
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
import { canonicaliseTaskId } from './task-decomposition.js';
import { parseTaskStamps, stampForTask } from './parse-task-stamps.js';
import { readFile } from 'node:fs/promises';
import { queryTelemetryState } from '../telemetry/telemetry-queries.js';
import type { TelemetryViewState } from '../telemetry/telemetry-projection.js';
import {
  shouldEnforceCheckpoint,
  CHECKPOINT_OPERATION_THRESHOLD,
} from '../workflow/checkpoint.js';
import type { CheckpointEnforcementConfig } from '../workflow/checkpoint.js';
import { globToRegExp } from '../architecture/glob-to-regexp.js';
import type { GateName } from '../workflow/verification-policy.js';
import { deriveWorkflowRiskTier } from '../workflow/verification-policy.js';
import { resolveGateSet, ladderGateNames } from '../workflow/phase-kind.js';
import type { PhaseKind } from '../workflow/phase-kind.js';
import {
  mintCapabilitiesForKind,
  requireMutationCapabilities,
  type RuntimeHandshake,
} from '../capabilities/resolver.js';
import type { Capability } from '../agents/capabilities.js';
import { renderImplementerPrompt } from '../agents/definitions.js';

// ─── Result Interface ────────────────────────────────────────────────────────

export type { DelegationReadinessState } from '../views/delegation-readiness-view.js';

/** Input shape for a task passed to prepare_delegation. */
export interface TaskInput {
  readonly id: string;
  readonly title: string;
  readonly blockedBy?: readonly string[];
  readonly files?: readonly string[];
  readonly testLayer?: 'acceptance' | 'integration' | 'unit' | 'property';
  /**
   * vls1-b1 (task 004): optional planner-supplied risk tier. When present it
   * WINS over heuristic derivation — the planner has context the heuristic
   * cannot infer. See {@link deriveRiskTier}.
   */
  readonly riskTier?: RiskTier;
  /**
   * vls1-b1 (task 005): optional planner-supplied boundary flag. When present
   * it WINS over heuristic derivation. See {@link deriveBoundaryTouching}.
   */
  readonly boundaryTouching?: boolean;
}

/**
 * Advisory classification for a single task.
 * Note: effort omits 'max' intentionally — the heuristic classifier covers
 * scaffolder/implementer tiers only. 'max' effort (Opus-level deep reasoning)
 * is reserved for manual override, not automated classification.
 */
/** vls1-b1: ordered risk tier for the verification ladder. */
export type RiskTier = 'low' | 'medium' | 'high';

export interface TaskClassification {
  readonly taskId: string;
  readonly complexity: 'low' | 'medium' | 'high';
  readonly recommendedAgent: 'scaffolder' | 'implementer';
  readonly recommendedModel: 'opus' | 'sonnet' | 'haiku';
  readonly effort: 'low' | 'medium' | 'high';
  readonly reason: string;
  /**
   * vls1-b1 (task 003/004): verification-ladder risk tier. Derived from the
   * task's blast radius (files, dependencies, test layer, high-risk globs),
   * unless the planner supplied an explicit `riskTier` on the task.
   */
  readonly riskTier: RiskTier;
  /**
   * vls1-b1 (task 005): true when the task crosses an I/O or schema boundary.
   * Independent of {@link riskTier} — a low-blast task can still be
   * boundary-touching.
   */
  readonly boundaryTouching: boolean;
  /**
   * vls1-b1 (task 006/007): the ordered verification gate sequence the task
   * must clear, resolved from the policy table by (riskTier, boundaryTouching).
   */
  readonly verificationSequence: readonly GateName[];
  /**
   * #1586 (root cause): the tier-selected implementer system prompt the
   * orchestrator dispatches for this task — `renderImplementerPrompt` keyed on
   * the resolved `riskTier`/`boundaryTouching`. Before this field the tier-aware
   * renderer had ZERO production callers and every dispatch shipped the static
   * medium-RGR `agents/implementer.md` default regardless of tier. The
   * orchestrator fills the `{{taskDescription}}`/`{{requirements}}`/
   * `{{filePaths}}` placeholders at dispatch; the verification note is already
   * tier-resolved here (INV-2: rendered in the shared dispatch core, identical
   * for CLI and MCP).
   */
  readonly implementerPrompt: string;
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

import { TASK_SCAFFOLDING_KEYWORDS as SCAFFOLDING_KEYWORDS } from './scaffolding-keywords.js';

// ─── Risk-Tier & Boundary Derivation (vls1-b1, tasks 003–005) ───────────────
//
// Pure, config-free heuristics that classify a task's verification needs:
//   - `deriveRiskTier`        — blast-radius tier (low | medium | high)
//   - `deriveBoundaryTouching`— whether the task crosses an I/O / schema seam
//
// Both honor an explicit planner-supplied override on the TaskInput. The glob
// sets below are the single source of truth for which file surfaces count as
// high-risk, low-risk, or boundary-touching. Matching uses the shared anchored
// `globToRegExp` compiler (no new glob dialect introduced).

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
  // Schema/contract ARTIFACTS are shared-contract surfaces (the documented
  // blast-radius gap) — they must reach the HIGH lane even though e.g.
  // `openapi.yaml` would otherwise match the `**/*.yaml` LOW glob (high rules
  // are evaluated before low). They also set boundaryTouching via
  // BOUNDARY_GLOBS — the axes stay orthogonal. PR #1535 CR-4.
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
 * Memoised compiled matchers keyed by glob source string. In production the
 * keys come only from the exported const tables above (~15 entries); the size
 * bound is a backstop for exported-API callers supplying arbitrary patterns —
 * on overflow the cache clears and rebuilds (recompilation is cheap; unbounded
 * growth is not).
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
 * Derive a task's verification-ladder risk tier.
 *
 * Precedence (first match wins):
 *   1. explicit planner `task.riskTier`  — always wins
 *   2. HIGH rules — ANY file matches {@link HIGH_RISK_GLOBS}, OR
 *      testLayer === 'acceptance', OR blockedBy.length >= 2, OR
 *      files.length >= 3
 *   3. LOW rules — there is at least one file AND EVERY file matches
 *      {@link LOW_RISK_GLOBS} (docs/config/rename-only)
 *   4. default — medium
 *
 * Ambiguity (mixed low + unknown files) falls through to medium.
 * Pure: no I/O, no config reads.
 */
export function deriveRiskTier(task: TaskInput): RiskTier {
  if (task.riskTier !== undefined) return task.riskTier;

  const files = task.files ?? [];

  // ── HIGH rules ──
  if (files.some((f) => fileMatchesAny(f, HIGH_RISK_GLOBS))) return 'high';
  if (task.testLayer === 'acceptance') return 'high';
  if ((task.blockedBy?.length ?? 0) >= 2) return 'high';
  if (files.length >= 3) return 'high';

  // ── LOW rules ── (all files must match low globs; empty file list is not low)
  if (files.length > 0 && files.every((f) => fileMatchesAny(f, LOW_RISK_GLOBS))) {
    return 'low';
  }

  // ── default ──
  return 'medium';
}

/**
 * Derive whether a task is boundary-touching (crosses an I/O or schema seam).
 *
 * Precedence (first match wins):
 *   1. explicit planner `task.boundaryTouching` — always wins
 *   2. testLayer is 'integration' or 'acceptance'
 *   3. ANY file matches {@link BOUNDARY_GLOBS} (adapters/clients/io/http or a
 *      schema artifact)
 *
 * INDEPENDENT of {@link deriveRiskTier}: a low-blast adapter edit is still
 * boundary-touching. Pure: no I/O, no config reads.
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
 * The agent/complexity/effort portion of a classification — the legacy
 * heuristic. The verification-ladder fields (riskTier/boundaryTouching/
 * verificationSequence) are layered on top in {@link classifyTask}.
 */
type CoreClassification = Omit<
  TaskClassification,
  'riskTier' | 'boundaryTouching' | 'verificationSequence' | 'implementerPrompt'
>;

/**
 * Legacy agent/complexity/effort heuristic.
 *
 * Priority order:
 *   0. testLayer: "acceptance" → high/implementer (highest priority)
 *   1. Title contains scaffolding keywords → low/scaffolder
 *   2. blockedBy length >= 2 → high/implementer
 *   3. files length >= 3 → high/implementer
 *   4. Default → medium/implementer
 */
function classifyTaskCore(
  task: TaskInput,
  agentConfig: ResolvedProjectConfig['agents'],
): CoreClassification {
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

/**
 * Deterministic heuristic classification for a single task.
 * Advisory — agents can override these recommendations.
 *
 * vls1-b1 (task 007): in addition to the legacy agent/complexity/effort
 * heuristic ({@link classifyTaskCore}), every classification now carries the
 * verification-ladder fields:
 *   - `riskTier`           — {@link deriveRiskTier} (honors explicit override)
 *   - `boundaryTouching`   — {@link deriveBoundaryTouching} (honors override)
 *   - `verificationSequence` — {@link resolveGateSet} for the IMPLEMENT kind
 *
 * task-004 (DR-4): the sequence is resolved by routing through
 * {@link resolveGateSet} keyed on the IMPLEMENT *kind*, not by calling the
 * verification-policy resolver directly. This makes the kind (not the
 * `delegate` phase name) the binding, so every IMPLEMENT-kind phase resolves
 * the same ladder by construction. The IMPLEMENT resolver delegates verbatim to
 * the CONFIG-RESOLVED verification policy, so the stamp is byte-identical to the
 * prior direct call: when `config` is omitted (or its relevant cell is unset)
 * the policy falls through to the frozen built-in table, and a `.exarchos.yml`
 * `verification:` cell override still changes what gets stamped onto the
 * delegation record.
 *
 * The legacy `complexity`/`effort` axis is preserved unchanged — `riskTier` is
 * a SEPARATE, blast-radius-driven axis (a scaffolding task can be low-effort
 * yet high-risk if it edits a schema, and vice versa).
 */
export function classifyTask(
  task: TaskInput,
  agentConfig: ResolvedProjectConfig['agents'] = DEFAULTS.agents,
  config?: ResolvedProjectConfig,
): TaskClassification {
  const core = classifyTaskCore(task, agentConfig);
  const riskTier = deriveRiskTier(task);
  const boundaryTouching = deriveBoundaryTouching(task);
  return {
    ...core,
    riskTier,
    boundaryTouching,
    verificationSequence: ladderGateNames(
      resolveGateSet('IMPLEMENT', { riskTier, boundaryTouching, config }),
    ),
    // #1586: render the tier-selected implementer prompt HERE, off the same
    // stamp, so the dispatch layer consumes a prompt whose verification note
    // already matches the task's blast radius — closing the gap where the
    // static medium-RGR default leaked onto every dispatch.
    implementerPrompt: renderImplementerPrompt({ riskTier, boundaryTouching }),
  };
}

// ─── DR-7: Fail-Closed at the Gate-Set Boundary ─────────────────────────────
//
// `classifyTask` routes each task's verification sequence through
// `resolveGateSet(kind, …)`. That resolver can THROW — a deferred kind whose
// resolver is not yet wired ('not-yet-wired'), or any other resolver fault.
// Mapping the wave with a raw `.map(classifyTask)` lets such a throw propagate
// out of the dispatch handler and fail the dispatch OPEN / silently.
//
// DR-7 makes the boundary FAIL CLOSED: the entire wave's classification is run
// inside one guard. On ANY resolver throw, NO task classifications are stamped
// (all-or-nothing — a partially-classified wave would be a fail-open hazard),
// and the wrapper returns a structured `blocked` result the handler turns into
// a `phase.blocked` event + an error envelope. On success it returns the
// stamped classifications unchanged.
//
// The boundary phase kind is always `IMPLEMENT` here (the delegate/wave-dispatch
// boundary). The kind is surfaced on the result so every IMPLEMENT-kind phase
// boundary that adopts this wrapper records the same diagnostic shape.

/**
 * The phase kind bound to the wave-dispatch boundary.
 *
 * `satisfies` (not a `: PhaseKind` annotation) preserves the `'IMPLEMENT'`
 * LITERAL type while still rejecting a typo at compile time. The literal is
 * load-bearing for DR-14: `mintCapabilitiesForKind(DISPATCH_PHASE_KIND)` narrows
 * to the exact posture, so `requireMutationCapabilities` in
 * {@link assertDispatchMutationCapabilities} compile-REJECTS the bundle the day
 * this is ever pointed at a read-only kind — worktree mutation is
 * unrepresentable from a read-only dispatch phase (INV-11, by construction).
 */
const DISPATCH_PHASE_KIND = 'IMPLEMENT' satisfies PhaseKind;

/**
 * DR-14 / INV-11 (#1546): assert the dispatch phase kind grants mutation,
 * via the POLA capability bundle, before authorizing a wave of mutating-agent
 * (scaffolder/implementer) tasks.
 *
 * The wave-dispatch boundary is the production point where mutation authority is
 * handed to a subagent — the "central enforcement point" the resolver map
 * lacked. `phase.entered` freezes the kind's `posture` (the serializable seed);
 * here the bundle is MINTED from that posture and REQUIRED to carry mutation.
 * Two layers of enforcement:
 *   - compile-time: `requireMutationCapabilities` REJECTS a read-only bundle, so
 *     `DISPATCH_PHASE_KIND` can never silently become a read-only posture —
 *     worktree mutation is unrepresentable from a read-only phase (DR-14).
 *   - runtime: a handshake `deny` that revokes `fs:write` (e.g. a sandboxed
 *     client) yields a bundle without the mutation token; we fail the dispatch
 *     CLOSED rather than dispatch an agent that cannot write its worktree.
 *
 * Pure (the default handshake resolves the built-in posture table; an injected
 * handshake is for the runtime-deny path). Throws on a revoked mutation token;
 * the wave-dispatch caller folds the throw into a `phase.blocked` diagnostic.
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
 * matches the `phase.blocked` event schema (`event-store/schemas.ts`):
 * `{ phase, kind, reason, error: { code, message } }`.
 */
export interface PhaseBlockedInfo {
  readonly phase: string;
  readonly kind: PhaseKind;
  readonly reason: string;
  readonly error: { readonly code: string; readonly message: string };
}

/**
 * Discriminated result of the fail-closed classification boundary:
 * - `{ ok: true, classifications }`  — every task classified cleanly.
 * - `{ ok: false, blocked }`         — a resolver threw; nothing was stamped.
 */
export type ClassifyTasksResult =
  | { readonly ok: true; readonly classifications: TaskClassification[] }
  | { readonly ok: false; readonly blocked: PhaseBlockedInfo };

/**
 * Classify a whole wave of tasks at the gate-set boundary, FAILING CLOSED.
 *
 * Wraps the per-task {@link classifyTask} call (which routes through
 * {@link resolveGateSet}) so a resolver throw never propagates out of the
 * dispatch boundary. The guard is wave-wide and all-or-nothing: a single throw
 * blocks the entire wave (no partial classification) and yields a
 * {@link PhaseBlockedInfo} the caller records as a `phase.blocked` event.
 *
 * Pure: no I/O. The caller owns event emission and the response envelope.
 *
 * @param tasks the wave's tasks
 * @param agentConfig resolved agent config (model routing)
 * @param config resolved project config (verification overlay); absence is the
 *   ordinary built-in-table path — it MUST NOT trigger a fail-closed block
 * @param phase the lifecycle phase the dispatch is at (for the diagnostic)
 */
export function classifyTasksFailClosed(
  tasks: readonly TaskInput[],
  agentConfig: ResolvedProjectConfig['agents'] = DEFAULTS.agents,
  config?: ResolvedProjectConfig,
  phase = 'delegate',
): ClassifyTasksResult {
  try {
    // DR-14 (#1546): the dispatch kind must grant mutation before a wave of
    // mutating-agent tasks is classified. Fails CLOSED into the same
    // PhaseBlockedInfo path a resolver throw uses (a revoked fs:write token →
    // blocked, never an agent dispatched without write authority).
    assertDispatchMutationCapabilities();
    return {
      ok: true,
      classifications: tasks.map(t => classifyTask(t, agentConfig, config)),
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

// ─── Plan-Stamp Lift (#1636) ────────────────────────────────────────────────

/**
 * Merge the planner's parsed per-task stamps onto the caller's task inputs.
 *
 * Precedence (highest first): an explicit field ALREADY on the `tasks[]` entry →
 * the parsed plan stamp → the classifier heuristic (applied later by
 * `deriveRiskTier`/`deriveBoundaryTouching` when neither supplied a value). Only
 * a MISSING field is filled from the stamp, so a caller that hand-supplies a
 * value is never overridden.
 *
 * Also emits a DISAGREEMENT advisory (informational — never blocks) when the
 * resolved `riskTier` differs from what the pure heuristic would have derived, so
 * an operator can see that a plan stamp overrode a divergent heuristic rather
 * than the override happening silently (issue #1636, proposed fix §3).
 *
 * Pure: no I/O (the caller reads the plan file and passes parsed stamps).
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
    if (resolved.riskTier !== undefined) {
      // Recompute the PURE heuristic (no riskTier override) to detect divergence.
      const heuristicTier = deriveRiskTier({
        id: resolved.id,
        title: resolved.title,
        files: resolved.files,
        blockedBy: resolved.blockedBy,
        testLayer: resolved.testLayer,
      });
      if (heuristicTier !== resolved.riskTier) {
        advisories.push(
          `task ${t.id}: plan stamp riskTier="${resolved.riskTier}" overrode heuristic "${heuristicTier}"`,
        );
      }
    }
    return resolved;
  });
  return { tasks: merged, advisories };
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

/**
 * DR-T-3 (#1212, T-06): produce a state-vs-plan desync diagnostic when
 * the projection's plan.taskCount diverges from workflowState.tasks.length.
 *
 * Diagnostic-only: does NOT gate readiness on its own. The blocker is
 * appended to the visible list so an operator notices, but the ready
 * gate is computed without it.
 *
 * Suppressed at empty baseline (plan.taskCount === 0) to avoid noise on
 * fresh workflows where the projection hasn't seen task.assigned events
 * yet.
 */
function computeDesyncBlockers(
  workflowState: WorkflowStateView,
  readiness: DelegationReadinessState,
): readonly string[] {
  const stateTasks = Array.isArray(workflowState.tasks) ? workflowState.tasks.length : 0;
  const planCount = readiness.plan.taskCount;

  if (planCount === 0) return []; // baseline — no diagnostic
  if (stateTasks === planCount) return [];

  return [
    `state-vs-plan desync: workflow.tasks has ${stateTasks} entries but plan.taskCount is ${planCount} (likely stale state after plan-review revision)`,
  ];
}

/**
 * DR-T-2 (#1206, T-05) / fix-005 (#1213): pure helper that recomputes
 * worktree counts and blockers against a wave subset.
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
 * Pure: no I/O, no shared state. Exported for unit testing.
 */
export interface ScopedWorktreesResult {
  readonly expected: number;
  readonly ready: number;
  readonly pending: number;
  readonly blockers: readonly string[];
}

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

// ─── Workflow Risk-Tier Persistence (DR-2) ──────────────────────────────────

/**
 * Persist the workflow-level `riskTier` to `state.riskTier` via the
 * event-sourced `state.patched` single-writer path — the same generic
 * field-update event `workflow/tools.ts` emits (`data.patch` carries the
 * dot-path delta the projection folds). `state.riskTier` is the top-level field
 * the `/review` required-reviews contract reads (`resolveWorkflowRiskTier` →
 * `getRequiredReviews`), so stamping it here is what arms the high-tier
 * `mutation-adequacy` backstop.
 *
 * Each call appends a `state.patched` the projection folds last-write-wins, so
 * `state.riskTier` always reflects the latest derived tier. It is deliberately
 * NOT keyed by tier value: a value-based idempotency key dropped a *re-raised*
 * tier — a high → medium → high sequence cache-hit the second `high` and left
 * the tier stuck at `medium`, silently under-arming the `mutation-adequacy`
 * backstop (CodeRabbit RVC-R9). A redundant re-invocation that re-derives the
 * same tier just appends a value-identical patch, a harmless no-op under the
 * fold. Emission is best-effort like the surrounding audit events — the ready
 * dispatch path must not hard-depend on a write (a re-invocation re-stamps).
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

/**
 * #1542: native-isolation shared-checkout hazard. When the host is trusted to
 * materialize worktrees but none are confirmed ready at prepare-time, dispatch
 * can silently land agents in the shared checkout. Surfaced as a warning, never
 * a blocker (the host owns isolation; readiness can't be known here).
 */
function sharedCheckoutHazardWarning(expected: number): string {
  return (
    `native isolation requested; ${expected} worktree(s) expected but 0 confirmed ready — ` +
    `verify the host materializes worktrees or dispatch may land in the shared checkout`
  );
}

export async function handlePrepareDelegation(
  args: {
    featureId: string;
    tasks?: TaskInput[];
    /**
     * #1636: path to the decomposition markdown. When present, the planner's
     * per-task `**Risk Tier:**` / `**Boundary Touching:**` stamps are lifted onto
     * the matching `tasks[]` entries (an explicit field on the entry still wins;
     * the parsed stamp wins over the heuristic). Absent, behavior is unchanged.
     */
    planPath?: string;
    nativeIsolation?: boolean;
    /**
     * task 004 (DR-2): an explicit workflow-level risk-tier override. When
     * supplied it WINS over the derived max-of-tiers and is what gets persisted
     * to `state.riskTier`. Absent, the tier is derived from the wave's task
     * classifications. Validated below alongside the task fields.
     */
    riskTier?: RiskTier;
  },
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

  // Non-MCP callers (CLI / direct / tests) hand `tasks` through an unchecked
  // cast, so the declared `TaskInput[]` type is not a runtime guarantee. (The MCP
  // adapter's registration schema strips unknown keys, but those paths do not.)
  // Validate the shape HERE with an explicit INVALID_INPUT — otherwise a
  // malformed task throws downstream in computeScopedWorktrees / classifyTaskCore
  // (e.g. `files.some(...)` on a non-array `files`) and surfaces as a misleading
  // PREPARE_DELEGATION_FAILED or, worse, a fail-closed `phase.blocked` event.
  // `phase.blocked` must stay reserved for genuine gate-set RESOLVER faults, so
  // the guard also covers the optional STRING-ARRAY fields the heuristics call
  // array methods on (`files`, `blockedBy`), not just `id`/`title`.
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
        // Validate EVERY planner-supplied field the heuristics / resolver consume,
        // not just id/title: a bad `riskTier` reaches resolveVerificationSequence
        // (BASE_SEQUENCE_BY_TIER[riskTier] → throw), and a non-array `files`
        // crashes the risk/boundary heuristics — both would otherwise be caught by
        // the fail-closed wrapper and misreported as `phase.blocked`.
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

  // task 004 (DR-2): the optional workflow-level riskTier override is persisted
  // verbatim, so an out-of-vocabulary value must be rejected at the boundary
  // rather than stamped onto state and silently ignored by getRequiredReviews.
  if (!isOptionalOneOf(args.riskTier, ['low', 'medium', 'high'])) {
    return {
      success: false,
      error: {
        code: 'INVALID_INPUT',
        message: 'riskTier must be one of low|medium|high',
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

    // #1261: capture per-guard outcomes so a single `dispatch.preflight`
    // event can be emitted regardless of which guard short-circuits.
    // Guards that never run (because an earlier guard already blocked)
    // record `passed: true` in the per-guard payload — they did not
    // observe a failure, so calling them "failed" would mislead audit
    // queries. The aggregate `passed` bit is the load-bearing
    // observable for "did anything block this dispatch".
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
      // #1509/#1501: only runs on the nativeIsolation path; `true` here means
      // "no failure observed" for dispatches that never run the guard.
      baseRef: { passed: true },
    };

    /**
     * Emit the single `dispatch.preflight` summary event. Inherits
     * `operationId` automatically via the dispatch context AsyncLocalStorage
     * stamp (B1 / #1291). Fire-and-forget at the call site — the helper
     * itself awaits store.append so callers that query the stream after
     * the dispatch return observe the event (read-your-writes).
     */
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
            // #1509/#1501: the baseRef guard runs only on the nativeIsolation
            // path. Omit it on non-native dispatches so telemetry reflects
            // "not executed" by absence rather than a misleading passed:true
            // (schema marks baseRef optional for exactly this reason).
            ...(args.nativeIsolation
              ? { baseRef: { passed: guardOutcomes.baseRef.passed } }
              : {}),
          },
          passed,
          durationMs: Date.now() - preflightStart,
        },
      });
    };

    // #1129 C: refuse dispatch from a protected base branch (main/master).
    // Runs before ancestry because 'integrationBranch descends from main'
    // trivially passes when HEAD is on main — that case must be caught
    // at HEAD inspection, not ancestry.
    //
    // DR-10 (refactor-pipeline-view-economy): skipped under nativeIsolation,
    // mirroring the DR-2 worktree-location guard below. The host materializes
    // each subagent worktree off the pinned base (`worktree.baseRef: head` →
    // the integration tip, enforced by the DR-2b baseRef guard), so the
    // orchestrator's HEAD is never inherited by dispatched agents. Crucially,
    // the server reads HEAD via `createGitExec()` from its own launch cwd —
    // the main checkout, which cannot hold the feature branch (already checked
    // out in the orchestrator worktree) and so sits on `main` — not the
    // orchestrator's worktree. This guard is therefore a guaranteed false
    // positive whenever the orchestrator drives from a worktree while the
    // server runs from the main checkout. Under native isolation the baseRef
    // guard is the applicable base-safety check, not this one.
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

    // ─── DR-2: Worktree Location Assertion ──────────────────────────────
    // Skip worktree check when nativeIsolation is true (Claude Code manages isolation)
    if (!args.nativeIsolation) {
      const worktreeResult = assertMainWorktree();
      // `mainWorktree` is reserved for a future cross-cutting "canonical
      // main worktree" assertion; today it shadows `worktree.passed` so
      // the event-schema shape is stable from day one.
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
      // ─── DR-2b (#1509/#1501): Native-isolation worktree base-pin guard ──
      // Claude Code's `isolation: worktree` branches the subagent worktree
      // from origin/HEAD (default branch = main) unless the consumer sets
      // `worktree.baseRef: "head"`. Without the pin, a subagent dispatched
      // onto a stacked/non-main integration branch gets a base missing every
      // in-branch prerequisite — the #1509/#1501 failure. Fail loud here with
      // the exact remediation rather than silently dispatching onto main.
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

    // Audit trail must name every guard actually executed on this path. Under
    // native isolation the protected-branch + worktree-location guards are
    // skipped (DR-10 / DR-2) and baseRef applies; otherwise protectedBranch runs
    // first (see above), then ancestry, then worktree.
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

    // #1261: emit the consolidated `dispatch.preflight` summary now that
    // every guard has run and recorded its outcome. Single emission per
    // dispatch — the aggregate `passed` will be `true` here.
    await emitDispatchPreflight();

    // #1261: probe for shared-stash collisions in the current worktree.
    // Advisory only — fires `stash.detected` when `git stash list`
    // returns a non-empty listing. Cross-worktree stash storage is shared
    // (`feedback_subagent_stash_hazard`), so an existing entry surfaces
    // the moment of collision for later root-cause attribution. Failures
    // are swallowed inside `probeStashAndEmit`; no dispatch impact.
    await probeStashAndEmit({
      store,
      streamId,
      worktreePath: process.cwd(),
      gitExec,
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

    // Materialize delegation readiness from event stream
    const drEvents = await queryDeltaEvents(store, materializer, streamId, DELEGATION_READINESS_VIEW);
    const readiness = materializer.materialize<DelegationReadinessState>(
      streamId,
      DELEGATION_READINESS_VIEW,
      drEvents,
    );

    // DR-T-1 (#1205, T-03): plan-artifact presence is tracked by the
    // delegation-readiness projection itself (T-02). The handler trusts
    // the view as the single source of truth and does not run a parallel
    // filesystem/state check. This eliminates the prior divergence where
    // `prepare_delegation` and `delegation_readiness` reported different
    // blocker lists for identical workflow state (axiom DIM-1, #1109 §2).
    //
    // DR-T-2 (#1206, T-05) / fix-005 (#1213): when a `tasks` arg is
    // provided, scope the worktrees-pending blocker AND the numeric
    // expected/ready counts to that subset. Prevents the documented
    // "wave-by-wave dispatch" pattern from being blocked by the global
    // per-stream count when only a subset is being prepared, and keeps
    // the visible numeric surfaces in lockstep with the (possibly
    // rewritten) blocker string so callers don't see "expected: 5 /
    // ready: 2" alongside a "1 worktrees pending" blocker.
    const scoped = computeScopedWorktrees(readiness, args.tasks);

    // When nativeIsolation is true, filter out worktree-related blockers
    // (Claude Code handles worktree isolation natively via `isolation: "worktree"`).
    const baseBlockers = args.nativeIsolation
      ? scoped.blockers.filter(b => !isWorktreeBlocker(b))
      : scoped.blockers;

    // ready is computed off the wave-scoped + native-filtered blockers,
    // BEFORE appending the desync diagnostic — drift is informational, it
    // does not gate dispatch on its own (per #1212 design).
    const effectiveReady = baseBlockers.length === 0;

    // DR-T-3 (#1212, T-06): state-vs-plan desync diagnostic. Compares the
    // projection's plan.taskCount (incremented by task.assigned events)
    // against workflowState.tasks.length. When the two diverge after a
    // plan-review revision, the operator should notice before dispatching
    // against stale state.
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

    // #1542: under native isolation the host materializes worktrees DOWNSTREAM
    // of this call, so worktree blockers are filtered (above) and `ready` can be
    // true while `worktrees.ready === 0`. That exact state has silently
    // dispatched agents into the shared checkout. Surface the hazard (INV-12:
    // the readiness affordance must not lie) WITHOUT flipping `ready` (INV-11:
    // the host owns isolation). The orchestrator-side verify-back step lives in
    // the delegate skill's native-isolation path.
    if (
      args.nativeIsolation &&
      effectiveReadiness.worktrees.expected > 0 &&
      effectiveReadiness.worktrees.ready === 0
    ) {
      warnings.push(sharedCheckoutHazardWarning(effectiveReadiness.worktrees.expected));
    }

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
        ...(warnings.length > 0 ? { warnings } : {}),
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

    // Compute task classifications when tasks are provided (advisory).
    // vls1-b2 (task 003): thread the resolved project config so the
    // verification sequence stamped on each classification honors any
    // `.exarchos.yml` `verification:` cell override. When absent, the
    // resolver falls through to the byte-identical built-in table.
    //
    // task 004: forward the config UNCONDITIONALLY — the resolver now
    // optional-chains on `config?.verification?.policy`, so a present-but-
    // partial config (one predating the `verification` overlay) is handled as
    // no-config inside the resolver rather than throwing. The earlier call-site
    // guard that forwarded config only when `verification` was present is no
    // longer needed.
    const agentConfig = ctx?.projectConfig?.agents ?? DEFAULTS.agents;
    const projectConfig = ctx?.projectConfig;

    // ─── #1636: lift planner stamps from the decomposition markdown ──────────
    // When `planPath` is supplied, parse its per-task `**Risk Tier:**` /
    // `**Boundary Touching:**` stamps and merge them onto the caller's tasks so
    // the classifier's "planner value wins" branch is reachable. Best-effort: an
    // unreadable plan leaves tasks unchanged (heuristic still applies) and only
    // surfaces an advisory — the readiness dispatch path must not hard-depend on
    // a plan read.
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

    // DR-7: classify the wave through the fail-closed boundary. A resolver
    // throw (e.g. a deferred-kind 'not-yet-wired' fault) no longer propagates
    // and fails the dispatch OPEN; instead the boundary records `phase.blocked`
    // and refuses to proceed (no task classifications stamped).
    let taskClassifications: TaskClassification[] | undefined;
    if (effectiveTasks) {
      const classified = classifyTasksFailClosed(
        effectiveTasks,
        agentConfig,
        projectConfig,
        workflowState.phase ?? 'delegate',
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

    // ─── DR-2: Derive + persist workflow-level riskTier (max-of-tiers) ──────
    // Stamp `state.riskTier` once, here at prepare_delegation, so the `/review`
    // boundary's tier-aware required-reviews contract appends the high-tier
    // `mutation-adequacy` backstop. The explicit caller override wins over the
    // derived max; absent both tasks and an override there is nothing to stamp.
    const workflowRiskTier =
      args.riskTier ??
      (taskClassifications ? deriveWorkflowRiskTier(taskClassifications) : undefined);
    if (workflowRiskTier !== undefined) {
      await persistWorkflowRiskTier(store, streamId, workflowRiskTier);
    }

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
