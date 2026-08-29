// ─── Gate Utils ──────────────────────────────────────────────────────────────
//
// Shared utility for emitting gate.executed events across gate handlers.
// ─────────────────────────────────────────────────────────────────────────────

import { execFileSync } from 'node:child_process';
import { getDispatchContext } from '../../dispatch/dispatch-context.js';
import { orchestrateLogger } from '../../logger.js';
import type { EventStore } from '../../events/store.js';
import type { ToolResult } from '../../format.js';
import type { ResolvedProjectConfig } from '../../config/resolve.js';
import { resolveGateSeverity } from './gate-severity.js';
import {
  type GateName,
  type RiskTier,
} from '../../workflow/verification-policy.js';
import { resolveVerificationPolicy } from '../../workflow/verification-policy-resolver.js';
import type { PhaseKind } from '../../workflow/phase-kind.js';
import type { GitExec } from '../pure/execute-merge.js';
import type { EvidenceArtifactReferenceV1 } from '../../workflow/admission/evidence-artifact.js';
import type { AdmissionEvidenceRecorded } from '../../events/schemas.js';

/**
 * Output ceiling for the git shell-outs below.
 *
 * Node defaults `maxBuffer` to 1 MiB and raises ENOBUFS past it. A review-sized
 * `git diff main...HEAD` blows through that easily — a 902-file wave measured
 * 13.4 MB — and because ENOBUFS arrives as a thrown error it read as "git is
 * unavailable", taking three blocking review gates (context-economy,
 * operational-resilience, workflow-determinism) offline on exactly the large
 * changes they exist to judge. The ceiling stays finite so a genuinely runaway
 * command still fails rather than exhausting memory.
 */
const GIT_MAX_BUFFER_BYTES = 256 * 1024 * 1024;

/**
 * Shared production git executor for the per-task gate handlers (FIX-4 dedupe).
 *
 * Shells out to `git` from `repoRoot` with a 30s ceiling and captures the
 * combined stdout/stderr. NEVER throws on a non-zero exit — a failed git command
 * surfaces as `{ stdout: <combined output>, exitCode: <status> }` so each gate
 * reads the exit code as a leg verdict (a diff/checkout that legitimately fails
 * is a finding, not a tool crash). Was byte-identical in test-adequacy-handler,
 * contract-drift-handler, and mock-boundary-handler before this consolidation.
 */
export const defaultGitExec: GitExec = (repoRoot, args) => {
  try {
    const stdout = execFileSync('git', [...args], {
      cwd: repoRoot,
      timeout: 30_000,
      encoding: 'utf-8',
      maxBuffer: GIT_MAX_BUFFER_BYTES,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return { stdout, exitCode: 0 };
  } catch (err) {
    const e = err as { status?: number; stdout?: string | Buffer; stderr?: string | Buffer };
    const out =
      (typeof e.stdout === 'string' ? e.stdout : e.stdout?.toString('utf-8') ?? '') +
      (typeof e.stderr === 'string' ? e.stderr : e.stderr?.toString('utf-8') ?? '');
    return { stdout: out, exitCode: e.status ?? 1 };
  }
};

/**
 * Fetch the unified diff between baseBranch and HEAD.
 * Returns null on failure so callers can distinguish "no diff" from "error".
 *
 * The failure reason is logged rather than discarded: every caller collapses
 * `null` to one generic DIFF_ERROR envelope, so a swallowed cause sent readers
 * hunting a git problem when the real answer was an output-size ceiling.
 */
export function getDiff(repoRoot: string, baseBranch: string): string | null {
  try {
    return execFileSync(
      'git',
      ['diff', `${baseBranch}...HEAD`],
      {
        cwd: repoRoot,
        encoding: 'utf-8',
        timeout: 30_000,
        maxBuffer: GIT_MAX_BUFFER_BYTES,
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );
  } catch (err) {
    const e = err as { code?: string; status?: number; message?: string };
    orchestrateLogger.warn(
      { repoRoot, baseBranch, code: e.code, status: e.status, err: e.message },
      'getDiff: git diff failed; the gate will report DIFF_ERROR',
    );
    return null;
  }
}

/**
 * Emit a gate.executed event to the event store.
 *
 * @param store - The event store to append to
 * @param streamId - The stream (feature) ID
 * @param gateName - Name of the gate (e.g. 'test-suite', 'typecheck', 'design-completeness')
 * @param layer - The workflow layer (e.g. 'CI', 'design', 'planning', 'testing', 'post-merge')
 * @param passed - Whether the gate passed
 * @param details - Optional details payload
 */
export async function emitGateEvent(
  store: EventStore,
  streamId: string,
  gateName: string,
  layer: string,
  passed: boolean,
  details?: Record<string, unknown>,
  /**
   * Optional idempotency key (INV-8). When supplied, a second emission with the
   * same key collapses to the first row instead of appending a duplicate — so a
   * gate re-run under the same operationId leaves a single `gate.executed`.
   * Omit it for legacy gates that intentionally emit one row per call.
   */
  idempotencyKey?: string,
): Promise<void> {
  const event = {
    type: 'gate.executed' as const,
    data: {
      gateName,
      layer,
      passed,
      ...(details !== undefined ? { details } : {}),
    },
  };
  // Only thread the AppendOptions arg when an idempotency key is present, so
  // callers that don't opt into idempotency see the unchanged 2-arg append
  // signature (no spurious `undefined` third argument).
  if (idempotencyKey !== undefined) {
    await store.append(streamId, event, { idempotencyKey });
  } else {
    await store.append(streamId, event);
  }
}

/**
 * Append `gate.executed` and make its landing a precondition of the gate's own
 * success carrier, for the gates that declare the event unconditionally
 * (`emissions: gate.executed always`). A handler that swallows the append and
 * still returns a success carrier is asserting a fact — "this run produced the
 * declared durable row" — that the log does not hold; the two are only kept
 * from disagreeing by making the append part of the result, not a side note.
 *
 * Wraps {@link emitGateEvent} rather than re-implementing the append, so the
 * `gate.executed` literal stays owned by exactly one call site per handler
 * (the per-file producer census in `check-gate-runner-ownership.mjs` counts
 * literals, not call graphs).
 *
 * Returns `undefined` when the row landed — the caller proceeds to its own
 * success return. On a thrown append it returns a failure envelope carrying
 * the gate's own result data through on `data` (the verdict the gate reached
 * is still true and still worth reading) with `error.code`
 * `GATE_EVENT_UNRECORDED`, mirroring how `EMISSION_CONTRACT_VIOLATED`
 * preserves `result.data` for a completed operation whose bookkeeping failed
 * (`src/dispatch/core/dispatch.ts`) — the effect happened, only the durable
 * record of it did not.
 *
 * @param carrier - the `ToolResult` the caller would otherwise have returned;
 *   only its `data` rides into the failure envelope.
 */
export async function requireGateEvent(
  store: EventStore,
  streamId: string,
  gateName: string,
  layer: string,
  passed: boolean,
  carrier: ToolResult,
  details?: Record<string, unknown>,
  idempotencyKey?: string,
): Promise<ToolResult | undefined> {
  try {
    await emitGateEvent(store, streamId, gateName, layer, passed, details, idempotencyKey);
    return undefined;
  } catch (err) {
    return {
      success: false,
      data: carrier.data,
      error: {
        code: 'GATE_EVENT_UNRECORDED',
        message:
          `${gateName}: the gate ran and its verdict is preserved on \`data\` — ` +
          `what failed is the durable \`gate.executed\` record this action ` +
          `declares unconditionally. Withholding the success carrier rather than ` +
          `letting the declaration and the log disagree: ` +
          `${err instanceof Error ? err.message : String(err)}`,
      },
    };
  }
}

/**
 * The key that collapses a self-emitted `gate.executed` row onto the one the
 * first attempt of the SAME operation already wrote.
 *
 * A gate that mints its own row instead of letting the canonical runner mint
 * one is still re-executed by a same-operation retry: the runner runs the
 * provider before it can discover that the operation already produced
 * evidence, so the provider's append fires twice while the evidence row —
 * keyed on its own deterministic id — collapses to one. Unkeyed, that leaves
 * two rows describing one gate run, and every reader that folds the log
 * (receipts, convergence, prior-fix-cycle counts) sees the duplicate.
 *
 * Keyed on the operation identity a retry deliberately reuses, so two distinct
 * calls still leave two rows and only a retry collapses.
 *
 * `undefined` outside a dispatch scope: there is no operation for a second
 * append to be the same as, and a constant key would collapse calls that have
 * nothing to do with each other.
 */
export function sameOperationGateKey(gateName: string): string | undefined {
  const operationId = getDispatchContext()?.operationId;
  return operationId === undefined ? undefined : `gate.executed:${gateName}:${operationId}`;
}

// ─── Canonical gate-runner result helpers ───────────────────────────────────

/** Compact durable references added to (but never substituted for) gate data. */
export interface GateEvidenceReference {
  readonly evidenceId: string;
  readonly subject: AdmissionEvidenceRecorded['evidence']['subject'];
  readonly contentDigest: AdmissionEvidenceRecorded['evidence']['contentDigest'];
  readonly supersedesEvidenceId?: string;
  readonly reportArtifact?: EvidenceArtifactReferenceV1;
}

/**
 * The skip facts a gate carrier declares about itself.
 *
 * Read by {@link normalizeGateVerdict} to decide the proof verdict AND carried
 * into the durable `gate.executed` row, so the two can never disagree about
 * whether the gate ran.
 */
export interface GateSkipDescriptor {
  readonly skipped: true;
  /** e.g. {@link SKIPPED_BY_POLICY}; absent when the producer declared none. */
  readonly discriminant?: string;
  /** Human-readable cause, when the producer supplied one. */
  readonly reason?: string;
}

/**
 * THE authority on "did this carrier declare itself skipped?".
 *
 * One predicate, consumed by both the verdict normalizer and the runner's
 * signal minting, because a carrier the verdict calls a skip and the signal
 * calls a run is exactly the disagreement DR-7 exists to remove.
 *
 * `skipped === true` is the whole test — deliberately NOT conditioned on
 * `passed`. See {@link normalizeGateVerdict} for why.
 */
export function readGateSkipDescriptor(result: ToolResult): GateSkipDescriptor | undefined {
  const data = result.data;
  if (data === null || typeof data !== 'object' || Array.isArray(data)) return undefined;
  const record = data as Readonly<Record<string, unknown>>;
  if (record.skipped !== true) return undefined;
  const discriminant = record.discriminant;
  const reason = record.reason;
  return {
    skipped: true,
    ...(typeof discriminant === 'string' ? { discriminant } : {}),
    ...(typeof reason === 'string' ? { reason } : {}),
  };
}

/**
 * Normalize the existing gate carriers to the proof verdict vocabulary.
 *
 * A provider error is indeterminate, while advisory carriers retain their
 * established `data.passed` contract. A success carrier without a boolean
 * verdict is also indeterminate rather than being promoted to passing proof.
 *
 * DR-7: an explicitly-skipped carrier is `indeterminate` REGARDLESS of
 * `passed`. The gate did not run to a conclusion, so it produced neither proof
 * nor a finding — `fail` would name a failure that was never observed, and
 * `pass` would mint proof that was never produced.
 *
 * The `passed !== true` qualifier this guard used to carry made it unreachable
 * for the carrier that most needed it. Three ladder gates (test-adequacy,
 * contract-drift, mock-boundary) emit `{ passed: true, skipped: true }` when the
 * verification policy routes them out of the sequence, so the durable evidence
 * row recorded `verdict: 'pass'` and `gate.executed` was minted `passed: true`
 * for a gate that never ran — proof manufactured from a skip. "Advisory skips
 * satisfy a presence requirement" was the old rationale; presence is satisfied
 * by the row EXISTING, not by it claiming to have passed.
 *
 * Indeterminate is NOT lenient: it fails closed downstream exactly as a deny
 * does (policy-evaluation's `evaluateGate` → `indeterminate('EVALUATOR_FAILED')`
 * → `PolicyVerdict 'indeterminate'` → `transition-command` records the attempt
 * and leaves the phase UNCHANGED; a waiver never rescues it). It is also not a
 * blocker for the ladder: the ToolResult carrier the orchestrator reads is
 * returned verbatim, so a policy-skipped gate still reports `data.passed: true`
 * to its runbook chain. Only the PROOF changes, which is the point.
 */
export function normalizeGateVerdict(result: ToolResult): 'pass' | 'fail' | 'indeterminate' {
  if (!result.success) return 'indeterminate';
  const data = result.data;
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    return 'indeterminate';
  }
  if (readGateSkipDescriptor(result) !== undefined) return 'indeterminate';
  const passed = (data as { readonly passed?: unknown }).passed;
  if (passed === true) return 'pass';
  if (passed === false) return 'fail';

  const ready = (data as { readonly ready?: unknown }).ready;
  if (ready === true) return 'pass';
  if (ready === false) return 'fail';

  const verdict = (data as { readonly verdict?: unknown }).verdict;
  if (verdict === 'APPROVED') return 'pass';
  if (verdict === 'NEEDS_FIXES' || verdict === 'BLOCKED') return 'fail';
  return 'indeterminate';
}

/**
 * Preserve the provider envelope and its data fields while adding proof refs.
 * Gate data is object-shaped in the owned provider registry; the fallback
 * keeps an unusual primitive carrier available under `result`.
 */
export function attachGateEvidence(
  result: ToolResult,
  references: readonly GateEvidenceReference[],
): ToolResult {
  const priorData = result.data;
  const data =
    priorData !== null && typeof priorData === 'object' && !Array.isArray(priorData)
      ? { ...(priorData as Readonly<Record<string, unknown>>), evidenceReferences: references }
      : {
          ...(priorData === undefined ? {} : { result: priorData }),
          evidenceReferences: references,
        };
  return { ...result, data };
}

// ─── Worktree-Aware repoRoot Resolution (#1330) ─────────────────────────────

/**
 * The literal value that requests dynamic resolution of `repoRoot` to the
 * calling delegation's agent worktree, rather than a fixed path or
 * `process.cwd()`. See #1330: when the orchestrator gate omits `repoRoot`, the
 * gate runs against the orchestrator's main worktree (which lacks the agent's
 * diff), making it a coin-flip.
 */
export const AUTO_REPO_ROOT = 'auto';

/** Outcome of {@link resolveRepoRoot}: a path, or a structured error. */
export type ResolveRepoRootResult =
  | { readonly ok: true; readonly repoRoot: string }
  | { readonly ok: false; readonly error: string };

/**
 * Shape of the `worktree.created` event data carrying a worktree path for a
 * task. Only the fields we read are modelled.
 */
interface WorktreeCreatedData {
  readonly taskId?: string;
  /**
   * Absolute worktree path. Must match the canonical `WorktreeCreatedData`
   * schema field name (`path`) — see event-store/schemas.ts. Reading any other
   * key here silently never matches a real event (INV-1 projection/contract
   * divergence; was `worktreePath`, fixed for #1330).
   */
  readonly path?: string;
}

/**
 * Resolve a gate's `repoRoot` input to a concrete filesystem path, honoring the
 * worktree-aware `'auto'` mode (#1330).
 *
 * Resolution rules:
 * - A falsy `repoRoot` → `process.cwd()` (unchanged default for non-delegation callers).
 * - A literal path (anything other than {@link AUTO_REPO_ROOT}) → returned verbatim.
 * - {@link AUTO_REPO_ROOT} → the agent worktree path, resolved in order:
 *     1. the explicit `worktreePath` arg, when present and non-empty;
 *     2. otherwise the latest `worktree.created` event for `taskId` on the
 *        `featureId` stream.
 *   If neither yields a path, returns `{ ok: false }` rather than silently
 *   falling back to `process.cwd()` — the silent fallback is the #1330
 *   coin-flip this resolver eliminates.
 *
 * Pure aside from the injected event-store query (testable via a stub store).
 */
export async function resolveRepoRoot(
  args: {
    readonly repoRoot?: string | undefined;
    readonly worktreePath?: string | undefined;
    readonly featureId: string;
    readonly taskId?: string | undefined;
  },
  store: EventStore,
): Promise<ResolveRepoRootResult> {
  const { repoRoot, worktreePath, featureId, taskId } = args;

  if (!repoRoot) {
    return { ok: true, repoRoot: process.cwd() };
  }

  if (repoRoot !== AUTO_REPO_ROOT) {
    return { ok: true, repoRoot };
  }

  // 'auto' — prefer the explicit worktreePath arg.
  if (worktreePath && worktreePath.trim().length > 0) {
    return { ok: true, repoRoot: worktreePath };
  }

  // Fall back to the latest worktree.created event for this task.
  if (taskId) {
    const events = await store.query(featureId, { type: 'worktree.created' });
    for (let i = events.length - 1; i >= 0; i--) {
      const data = events[i]?.data as WorktreeCreatedData | undefined;
      if (data?.taskId === taskId && data.path && data.path.trim().length > 0) {
        return { ok: true, repoRoot: data.path };
      }
    }
  }

  return {
    ok: false,
    error:
      `repoRoot 'auto' could not be resolved: no worktreePath provided and no ` +
      `worktree.created event found for taskId '${taskId ?? '<none>'}' on stream '${featureId}'`,
  };
}

// ─── Implement-phase graduation mode (DR-6) ─────────────────────────────────
//
// The audit→enforce graduation knob for the IMPLEMENT-kind phase obligation
// surface. Distinct from SEVERITY (advisory vs blocking): mode is whether a
// failing gate is *consulted at all* as a transition blocker, or only RECORDED
// (the handler's `gate.executed` finding is emitted in BOTH modes; audit just
// never lets a failure re-assert a blocking verdict).
//
// CRITICAL INV-6: this map is WORKFLOW-specific, NOT kind-universal. It lives
// here next to the KIND_OBLIGATIONS *consumers* — it must NEVER move into
// `KIND_OBLIGATIONS` (phase-kind.ts), because an obligation that attaches to a
// kind composes across every workflow type, whereas a graduation mode is a
// per-workflow rollout decision.

/** The audit→enforce graduation mode for an IMPLEMENT-phase gate binding. */
export type ImplementMode = 'audit' | 'enforce';

/**
 * Per-workflow IMPLEMENT-phase graduation mode (DR-6).
 *
 * A DATA TABLE — not branching prose — keyed by workflow type. Mode is the
 * audit→enforce rollout axis; SEVERITY (advisory vs blocking) is the orthogonal
 * axis resolved by {@link resolveGateSeverity}. The two compose: a phase blocks
 * only when its mode is `enforce` AND its severity is `blocking`.
 *
 * Live defaults per the epic severity policy + DR-6 acceptance criteria:
 *   - `oneshot`  (oneshot:implementing) → audit
 *       Its severity is already advisory (WORKFLOW_DEFAULT_SEVERITY.oneshot), so
 *       audit is the natural rollout home: findings recorded, never blocking.
 *   - `feature`  (delegate)             → enforce  (already covered pre-DR-4)
 *   - `debug`    (debug-implement)      → enforce  (DR-6 AC: "blocks (enforce mode)")
 *   - `refactor` (polish-implement)     → enforce  (epic policy: blocking)
 *
 * The `audit` mode itself is a first-class, exercised mechanism (a phase can be
 * graduated/demoted by editing one cell here); a workflow type without an entry
 * falls back to `enforce` (the safe default — a missing entry must NEVER
 * silently stop a gate from blocking). Adding a workflow type is a single-line
 * ADDITION, never new control flow in {@link resolveImplementMode}.
 */
export const IMPLEMENT_PHASE_MODE: Readonly<Record<string, ImplementMode>> =
  Object.freeze({
    oneshot: 'audit',
    feature: 'enforce',
    debug: 'enforce',
    refactor: 'enforce',
  });

/**
 * Resolve the IMPLEMENT-phase graduation mode for a workflow type.
 *
 * Reads {@link IMPLEMENT_PHASE_MODE}; an unmapped workflow type defaults to
 * `'enforce'` so a phase is never silently downgraded by an unknown type.
 */
export function resolveImplementMode(workflowType: string): ImplementMode {
  return IMPLEMENT_PHASE_MODE[workflowType] ?? 'enforce';
}

/**
 * Resolve the graduation MODE for a phase kind's gates (DR-16, #1546).
 *
 * IMPLEMENT is the only kind with an audit→enforce graduation — per-workflow,
 * via {@link resolveImplementMode} — because audit-first was correct ONLY for
 * S2's genuinely-new IMPLEMENT coverage. The migrated PLAN/REVIEW/SYNTHESIZE
 * gates already BLOCKED under the pre-binding playbooks, so they bind DIRECTLY
 * to `'enforce'` (behavior-preserving). GATHER carries no gates; `'enforce'` is
 * the safe default so an unexpected kind never silently downgrades a gate.
 *
 * This stays a workflow/kind-keyed function in the orchestrate layer (next to
 * `IMPLEMENT_PHASE_MODE`) — NOT in `KIND_OBLIGATIONS`, because graduation is a
 * per-workflow rollout decision, not a kind-universal obligation (INV-6).
 */
export function resolvePhaseMode(kind: PhaseKind, workflowType: string): ImplementMode {
  return kind === 'IMPLEMENT' ? resolveImplementMode(workflowType) : 'enforce';
}

// ─── Config-Aware Gate Wrapper ──────────────────────────────────────────────

/**
 * Wraps a gate handler with config-aware severity resolution.
 *
 * - **disabled**: Skips execution entirely, returns success with `skipped: true`
 * - **warning**: Executes handler; converts failures to success with a warning
 * - **blocking**: Executes handler; failures remain failures (default behaviour)
 *
 * When `config` is `undefined`, defaults to blocking (backwards compatible).
 *
 * `workflowType` (task 005) is threaded to {@link resolveGateSeverity} so a
 * verification-ladder gate can pick up its per-workflow default severity (e.g.
 * oneshot → warning). Omitting it preserves the pre-task-005 resolution.
 */
export async function withConfigSeverity(
  gateName: string,
  dimension: string,
  config: ResolvedProjectConfig | undefined,
  handler: () => Promise<ToolResult>,
  workflowType?: string,
): Promise<ToolResult> {
  // When no config, default to blocking (backwards compat)
  if (!config) {
    return handler();
  }

  const severity = resolveGateSeverity(gateName, dimension, config, workflowType);

  if (severity === 'disabled') {
    return {
      success: true,
      data: { skipped: true, reason: `Gate '${gateName}' disabled by project config` },
    };
  }

  const result = await handler();

  // If gate passed, return as-is regardless of severity
  if (result.success) return result;

  // If severity is 'warning', convert failure to success with warning
  if (severity === 'warning') {
    return {
      success: true,
      data: result.data ?? result.error,
      warnings: [`Gate '${gateName}' failed but is configured as warning-only`],
    };
  }

  // Blocking: return failure as-is
  return result;
}

/**
 * Apply per-workflow severity to a verification-LADDER gate's ADVISORY-carrier
 * result (task 005).
 *
 * Ladder gates (INV-5b) never return `success:false` for a gate-failure verdict
 * — a failing gate is `{ success: true, data: { passed: false } }`, where
 * `data.passed:false` is the blocking signal the orchestrator reads. So
 * {@link withConfigSeverity}'s `success:false`-only conversion does not apply;
 * the ladder analogue is to clear `data.passed` (false → true) the same way the
 * sibling clears `success`.
 *
 * This helper DOWNGRADES a failing advisory verdict (`data.passed === false`) to
 * non-blocking — clearing the blocking signal (`data.passed → true`) AND
 * attaching an explanatory warning — when EITHER:
 *   - the binding's graduation `mode` is `'audit'` (DR-6) — an audit-mode gate
 *     RECORDS its finding (the handler already emitted `gate.executed`) but is
 *     never consulted as a transition blocker, regardless of severity OR config.
 *     Audit mode is resolved from the workflow type (config-INDEPENDENT), so this
 *     downgrade applies even on the no-config path; OR
 *   - a config is present and the resolved severity (via {@link resolveGateSeverity},
 *     threading `workflowType`) is `'warning'`.
 *
 * The truthful failing verdict survives in the `gate.executed` event the handler
 * emitted before this post-processing; only the returned ToolResult's block
 * signal is normalized — so an audit/warning gate cannot still block on a stale
 * `data.passed:false`.
 *
 * In every other case the result is returned UNCHANGED:
 *   - `mode === 'enforce'` (or omitted) AND `severity !== 'warning'` (e.g.
 *     blocking for a feature workflow) → unchanged, so the orchestrator still
 *     reads `data.passed:false` and blocks;
 *   - `mode !== 'audit'` AND `config` absent → unchanged (legacy / no-config
 *     severity passthrough — severity reads `config.review.gates.*`);
 *   - a passing verdict → unchanged;
 *   - a real error envelope (`success:false`) → unchanged (an INVALID_INPUT /
 *     MISWIRED_CONTEXT must never be downgraded to a warning).
 *
 * `mode` defaults to `'enforce'`, so legacy callers that don't thread it see
 * exactly the pre-DR-6 severity-only resolution.
 */
export function applyLadderGateSeverity(
  gateName: string,
  dimension: string,
  config: ResolvedProjectConfig | undefined,
  result: ToolResult,
  workflowType?: string,
  mode: ImplementMode = 'enforce',
): ToolResult {
  // A real error envelope (success:false) or a non-advisory shape — leave as-is.
  // An INVALID_INPUT / MISWIRED_CONTEXT must never be softened to a warning.
  if (!result.success) return result;

  const data = result.data as { passed?: unknown } | undefined;
  // Only an explicit failing verdict is a candidate for downgrade. A passing or
  // shape-less advisory carrier is returned verbatim.
  if (!data || data.passed !== false) return result;

  // Audit mode is resolved from the workflow type (IMPLEMENT_PHASE_MODE) — it is
  // CONFIG-INDEPENDENT, so it downgrades a failing verdict whether or not a
  // project config is present. The handler already emitted its `gate.executed`
  // finding; audit mode only stops that failure from re-asserting a blocking
  // verdict. This MUST precede the `!config` guard below (DR-6 fix): severity
  // reads `config`, but mode does not.
  if (mode === 'audit') {
    return {
      ...result,
      // Clear the blocking signal — `data.passed:false` is what the orchestrator
      // reads to block, so the warning alone would not actually unblock.
      data: { ...(data as Record<string, unknown>), passed: true },
      warnings: [
        ...(result.warnings ?? []),
        `Gate '${gateName}' failed but the implement phase is in audit mode (finding recorded, non-blocking)`,
      ],
    };
  }

  // Severity-based downgrade reads `config.review.gates.*`, so it requires a
  // resolved config; absent one, this is the legacy / no-config passthrough.
  if (!config) return result;
  const severity = resolveGateSeverity(gateName, dimension, config, workflowType);
  if (severity !== 'warning') return result;

  return {
    ...result,
    // Clear the blocking signal alongside the warning (see the audit branch).
    data: { ...(data as Record<string, unknown>), passed: true },
    warnings: [
      ...(result.warnings ?? []),
      `Gate '${gateName}' failed but is configured as warning-only`,
    ],
  };
}

// ─── Verification-ladder self-routing (FIX-1a) ──────────────────────────────

/** The discriminant carried by a gate skipped because the policy excludes it. */
export const SKIPPED_BY_POLICY = 'skipped-by-policy';

/**
 * Decide whether a gate should self-skip given the task's stamped verification
 * profile.
 *
 * The SINGLE SOURCE OF TRUTH for which gates run is the config-resolved policy
 * ({@link resolveVerificationPolicy}, the declared only composer of config +
 * the frozen built-in table) — this helper reads it, it does NOT re-derive
 * sequences or touch the table directly. Consuming the SAME resolver the
 * delegation stamp uses ({@link classifyTask}) guarantees stamp and skip can
 * never disagree: a `.exarchos.yml` `verification:` cell that excludes a gate
 * makes BOTH the stamp drop it AND this helper skip it.
 *
 * When `config` is omitted (or its relevant cell is unset) the resolver
 * delegates to the built-in table, so the skip decision is byte-identical to
 * the pre-config behavior.
 *
 * Returns a skip decision ONLY when BOTH stamped fields are present AND the
 * resolved sequence for that profile does not contain `gateName`. When either
 * stamp is absent (legacy callers that don't thread the profile) it returns
 * `null` → the handler runs unconditionally, preserving current behavior
 * EXACTLY (config presence does not change the absent-stamp path).
 *
 * The skip `reason` names the policy SOURCE (`config` vs `builtin`) so a
 * config-induced skip is never mistaken for a built-in decision.
 */
export function resolvePolicySkip(args: {
  readonly gateName: GateName;
  readonly riskTier?: RiskTier | undefined;
  readonly boundaryTouching?: boolean | undefined;
  readonly config?: ResolvedProjectConfig | undefined;
}): { readonly reason: string } | null {
  const { gateName, riskTier, boundaryTouching, config } = args;
  // Both stamps required — a partial stamp is treated as "no stamp" so we never
  // skip on a half-resolved profile. This guard runs BEFORE any config read so
  // the absent-stamp path is byte-identical regardless of config presence.
  if (riskTier === undefined || boundaryTouching === undefined) {
    return null;
  }
  const { sequence, source } = resolveVerificationPolicy(riskTier, boundaryTouching, config);
  if (sequence.includes(gateName)) {
    return null;
  }
  return {
    reason:
      `skipped by verification policy — ${gateName} is not in the resolved ` +
      `sequence for riskTier='${riskTier}', boundaryTouching=${boundaryTouching} ` +
      `(sequence: ${sequence.join(', ') || 'none'}; policy: ${source})`,
  };
}
