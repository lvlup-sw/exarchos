// ─── Gate Utils ──────────────────────────────────────────────────────────────
//
// Shared utility for emitting gate.executed events across gate handlers.
// ─────────────────────────────────────────────────────────────────────────────

import { execFileSync } from 'node:child_process';
import type { EventStore } from '../event-store/store.js';
import type { ToolResult } from '../format.js';
import type { ResolvedProjectConfig } from '../config/resolve.js';
import { resolveGateSeverity } from './gate-severity.js';

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
  await store.append(
    streamId,
    {
      type: 'gate.executed',
      data: {
        gateName,
        layer,
        passed,
        ...(details !== undefined ? { details } : {}),
      },
    },
    idempotencyKey !== undefined ? { idempotencyKey } : undefined,
  );
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
 */
export async function withConfigSeverity(
  gateName: string,
  dimension: string,
  config: ResolvedProjectConfig | undefined,
  handler: () => Promise<ToolResult>,
): Promise<ToolResult> {
  // When no config, default to blocking (backwards compat)
  if (!config) {
    return handler();
  }

  const severity = resolveGateSeverity(gateName, dimension, config);

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
