/**
 * Shared helpers for gate handlers: git shell-outs, `gate.executed` appends, verdict
 * normalization, evidence references, `repoRoot` resolution, graduation modes, severity
 * wrappers, and policy skips.
 */

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
 * Output ceiling for the git shell-outs in this module. The Node default of 1 MiB raises
 * ENOBUFS on a large review diff, and the gates then read git as unavailable. The ceiling stays
 * finite, so a runaway command still fails.
 */
const GIT_MAX_BUFFER_BYTES = 256 * 1024 * 1024;

/**
 * Shared production git executor for the per-task gate handlers. It runs `git` in `repoRoot`
 * with a 30-second timeout and returns the combined stdout and stderr. It does not throw on a
 * non-zero exit, so each gate reads the exit code as a finding, not as a tool crash.
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
 * Returns the unified diff from `baseBranch` to HEAD, or null on failure. It logs the failure
 * cause, because the callers report only a generic `DIFF_ERROR`.
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
 * Appends a `gate.executed` event to the event store.
 *
 * @param store - The event store to append to
 * @param streamId - The stream (feature) ID
 * @param gateName - Name of the gate, for example 'test-suite' or 'typecheck'
 * @param layer - The workflow layer, for example 'CI', 'design', or 'planning'
 * @param passed - Whether the gate passed
 * @param details - Optional details payload
 * @param idempotencyKey - Optional key. A second append with the same key collapses onto the
 *   first row. Omit it for a gate that emits one row per call.
 */
export async function emitGateEvent(
  store: EventStore,
  streamId: string,
  gateName: string,
  layer: string,
  passed: boolean,
  details?: Record<string, unknown>,
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
  if (idempotencyKey !== undefined) {
    await store.append(streamId, event, { idempotencyKey });
  } else {
    await store.append(streamId, event);
  }
}

/**
 * Appends `gate.executed` and makes its landing a precondition of the success carrier, for a
 * gate that declares the event unconditionally. It wraps {@link emitGateEvent} and does not
 * repeat the append literal, because the producer census in `check-gate-runner-ownership.mjs`
 * counts literals for each file.
 *
 * Returns `undefined` when the row landed. When the append throws, it returns a
 * `GATE_EVENT_UNRECORDED` failure that keeps the gate verdict on `data`.
 *
 * @param carrier - The `ToolResult` that the caller returns otherwise. Only its `data` goes into
 *   the failure envelope.
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
 * The idempotency key that collapses a self-emitted `gate.executed` row onto the row of the
 * first attempt of the same operation. A same-operation retry runs the provider again, so an
 * unkeyed append leaves two rows for one gate run. The key includes the operation id, so only a
 * retry collapses. Returns `undefined` outside a dispatch scope, because no operation exists there.
 */
export function sameOperationGateKey(gateName: string): string | undefined {
  const operationId = getDispatchContext()?.operationId;
  return operationId === undefined ? undefined : `gate.executed:${gateName}:${operationId}`;
}

/** Compact durable references added to (but never substituted for) gate data. */
export interface GateEvidenceReference {
  readonly evidenceId: string;
  readonly subject: AdmissionEvidenceRecorded['evidence']['subject'];
  readonly contentDigest: AdmissionEvidenceRecorded['evidence']['contentDigest'];
  readonly supersedesEvidenceId?: string;
  readonly reportArtifact?: EvidenceArtifactReferenceV1;
}

/**
 * The skip facts that a gate carrier declares about itself. {@link normalizeGateVerdict} reads
 * them, and the runner copies them into the `gate.executed` row, so the two agree.
 */
export interface GateSkipDescriptor {
  readonly skipped: true;
  /** For example {@link SKIPPED_BY_POLICY}. Absent when the producer declared none. */
  readonly discriminant?: string;
  /** Human-readable cause, when the producer supplied one. */
  readonly reason?: string;
}

/**
 * Reads the skip descriptor of a carrier. The verdict normalizer and the runner signal both use
 * it, so they agree on whether the gate ran. The test is `skipped === true` only, and it does
 * not depend on `passed`.
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
 * Maps a gate carrier to the proof verdict. It reads boolean `passed`, then boolean `ready`, then
 * a `verdict` of `APPROVED`, `NEEDS_FIXES` or `BLOCKED`. A provider error, a non-object data
 * value, or data with none of these values gives `indeterminate`.
 *
 * A skipped carrier is `indeterminate`, even with `passed: true`, because the gate produced no
 * proof and no finding. Ladder gates return `{ passed: true, skipped: true }` when the policy
 * excludes them. `indeterminate` fails closed in transition admission. The carrier does not
 * change, so the runbook still reads `data.passed: true`.
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
 * Adds proof references to the provider envelope and keeps its data fields. A defined data value
 * that is not a plain object, an array included, moves under `result`.
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

/**
 * The `repoRoot` value that requests resolution to the agent worktree of the calling delegation.
 * Without it, a gate runs in the main worktree of the orchestrator, which lacks the agent diff.
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
  /** Absolute worktree path. The key must match the `path` field of the canonical schema. */
  readonly path?: string;
}

/**
 * Resolves the `repoRoot` input of a gate to a path.
 * - Empty: `process.cwd()`.
 * - A path other than {@link AUTO_REPO_ROOT}: returned as given.
 * - {@link AUTO_REPO_ROOT}: the `worktreePath` argument, then the latest `worktree.created`
 *   event for `taskId` on the `featureId` stream. If neither gives a path, it returns
 *   `{ ok: false }` and does not fall back to `process.cwd()`.
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

  if (worktreePath && worktreePath.trim().length > 0) {
    return { ok: true, repoRoot: worktreePath };
  }

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

/**
 * The graduation mode of an IMPLEMENT-phase gate binding. In `audit` mode, a failing gate
 * records its finding but does not block a transition. Mode is separate from severity.
 */
export type ImplementMode = 'audit' | 'enforce';

/**
 * IMPLEMENT-phase graduation mode by workflow type. A phase blocks only when its mode is
 * `enforce` and its severity from {@link resolveGateSeverity} is `blocking`. `oneshot` is in
 * `audit`, because its severity is already advisory. An unmapped workflow type gets `enforce`.
 * The table is per workflow, so it must not move into the kind-universal `KIND_OBLIGATIONS`.
 */
export const IMPLEMENT_PHASE_MODE: Readonly<Record<string, ImplementMode>> =
  Object.freeze({
    oneshot: 'audit',
    feature: 'enforce',
    debug: 'enforce',
    refactor: 'enforce',
  });

/** Returns the IMPLEMENT-phase mode for a workflow type, or `enforce` for an unmapped type. */
export function resolveImplementMode(workflowType: string): ImplementMode {
  return IMPLEMENT_PHASE_MODE[workflowType] ?? 'enforce';
}

/**
 * Returns the graduation mode for the gates of a phase kind. Only IMPLEMENT has a per-workflow
 * mode. Each other kind gets `enforce`, so an unknown kind cannot downgrade a gate. This
 * function stays out of `KIND_OBLIGATIONS`, because graduation is a per-workflow decision.
 */
export function resolvePhaseMode(kind: PhaseKind, workflowType: string): ImplementMode {
  return kind === 'IMPLEMENT' ? resolveImplementMode(workflowType) : 'enforce';
}

/**
 * Wraps a gate handler with config-aware severity resolution.
 * - **disabled**: skips the handler and returns success with `skipped: true`.
 * - **warning**: runs the handler and converts a failure to success with a warning.
 * - **blocking**: runs the handler, and a failure stays a failure.
 *
 * With no `config`, the handler result returns unchanged. `workflowType` goes to
 * {@link resolveGateSeverity} for the per-workflow default severity of a ladder gate.
 */
export async function withConfigSeverity(
  gateName: string,
  dimension: string,
  config: ResolvedProjectConfig | undefined,
  handler: () => Promise<ToolResult>,
  workflowType?: string,
): Promise<ToolResult> {
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

  if (result.success) return result;

  if (severity === 'warning') {
    return {
      success: true,
      data: result.data ?? result.error,
      warnings: [`Gate '${gateName}' failed but is configured as warning-only`],
    };
  }

  return result;
}

/**
 * Applies per-workflow severity to the advisory carrier of a verification-ladder gate. A ladder
 * gate reports failure as `{ success: true, data: { passed: false } }`, so this helper clears
 * `data.passed` where {@link withConfigSeverity} clears `success`.
 *
 * A failing verdict becomes `passed: true` with a warning in two cases: `mode` is `audit`, or
 * config resolves the severity to `warning`. Audit mode does not need config. The handler event
 * keeps the true verdict. Each other result returns unchanged, an error envelope included, so
 * `INVALID_INPUT` is never softened. `mode` defaults to `enforce`.
 */
export function applyLadderGateSeverity(
  gateName: string,
  dimension: string,
  config: ResolvedProjectConfig | undefined,
  result: ToolResult,
  workflowType?: string,
  mode: ImplementMode = 'enforce',
): ToolResult {
  if (!result.success) return result;

  const data = result.data as { passed?: unknown } | undefined;
  if (!data || data.passed !== false) return result;

  if (mode === 'audit') {
    return {
      ...result,
      data: { ...(data as Record<string, unknown>), passed: true },
      warnings: [
        ...(result.warnings ?? []),
        `Gate '${gateName}' failed but the implement phase is in audit mode (finding recorded, non-blocking)`,
      ],
    };
  }

  if (!config) return result;
  const severity = resolveGateSeverity(gateName, dimension, config, workflowType);
  if (severity !== 'warning') return result;

  return {
    ...result,
    data: { ...(data as Record<string, unknown>), passed: true },
    warnings: [
      ...(result.warnings ?? []),
      `Gate '${gateName}' failed but is configured as warning-only`,
    ],
  };
}

/** The discriminant carried by a gate skipped because the policy excludes it. */
export const SKIPPED_BY_POLICY = 'skipped-by-policy';

/**
 * Returns a skip reason when the stamped profile of the task excludes `gateName`. It reads the
 * config-resolved policy from {@link resolveVerificationPolicy}, the same policy that the
 * delegation stamp uses, so the stamp and the skip agree. When a stamp field is absent, it
 * returns `null` before any config read, and the handler runs. The reason names the policy
 * source, `config` or `builtin`.
 */
export function resolvePolicySkip(args: {
  readonly gateName: GateName;
  readonly riskTier?: RiskTier | undefined;
  readonly boundaryTouching?: boolean | undefined;
  readonly config?: ResolvedProjectConfig | undefined;
}): { readonly reason: string } | null {
  const { gateName, riskTier, boundaryTouching, config } = args;
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
