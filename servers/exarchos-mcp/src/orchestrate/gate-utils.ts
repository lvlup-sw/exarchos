// ─── Gate Utils ──────────────────────────────────────────────────────────────
//
// Shared utility for emitting gate.executed events across gate handlers.
// ─────────────────────────────────────────────────────────────────────────────

import { execFileSync } from 'node:child_process';
import type { EventStore } from '../event-store/store.js';
import type { ToolResult } from '../format.js';
import type { ResolvedProjectConfig } from '../config/resolve.js';
import { resolveGateSeverity } from './gate-severity.js';
import {
  type GateName,
  type RiskTier,
} from '../workflow/verification-policy.js';
import { resolveVerificationPolicy } from '../workflow/verification-policy-resolver.js';
import type { GitExec } from './pure/execute-merge.js';

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
 */
export function getDiff(repoRoot: string, baseBranch: string): string | null {
  try {
    return execFileSync(
      'git',
      ['diff', `${baseBranch}...HEAD`],
      { cwd: repoRoot, encoding: 'utf-8', timeout: 30_000, stdio: ['pipe', 'pipe', 'pipe'] },
    );
  } catch {
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
   * Omit it for fire-and-forget gates that intentionally emit one row per call.
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
    readonly repoRoot?: string;
    readonly worktreePath?: string;
    readonly featureId: string;
    readonly taskId?: string;
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
      const data = events[i].data as WorktreeCreatedData | undefined;
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
 * — a failing gate is `{ success: true, data: { passed: false } }`, so
 * {@link withConfigSeverity}'s `success:false`-only conversion does not apply.
 * This helper resolves the gate's effective severity via
 * {@link resolveGateSeverity} (threading `workflowType`) and, ONLY when that
 * severity is `'warning'` and the advisory result reports a failing verdict
 * (`data.passed === false`), annotates it with a warning. In every other case
 * the result is returned UNCHANGED:
 *   - `severity !== 'warning'` (e.g. blocking for a feature workflow) → unchanged,
 *     so the orchestrator still reads `data.passed:false` and blocks;
 *   - `config` absent → unchanged (legacy / no-config callers);
 *   - a passing verdict → unchanged;
 *   - a real error envelope (`success:false`) → unchanged (an INVALID_INPUT /
 *     MISWIRED_CONTEXT must never be downgraded to a warning).
 */
export function applyLadderGateSeverity(
  gateName: string,
  dimension: string,
  config: ResolvedProjectConfig | undefined,
  result: ToolResult,
  workflowType?: string,
): ToolResult {
  // No config, or a real error envelope, or a non-advisory shape — leave as-is.
  if (!config || !result.success) return result;

  const data = result.data as { passed?: unknown } | undefined;
  // Only an explicit failing verdict is a candidate for downgrade. A passing or
  // shape-less advisory carrier is returned verbatim.
  if (!data || data.passed !== false) return result;

  const severity = resolveGateSeverity(gateName, dimension, config, workflowType);
  if (severity !== 'warning') return result;

  return {
    ...result,
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
  readonly riskTier?: RiskTier;
  readonly boundaryTouching?: boolean;
  readonly config?: ResolvedProjectConfig;
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
