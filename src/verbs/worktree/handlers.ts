/**
 * Dispatch handlers for the worktree-lifecycle actions on `exarchos_orchestrate` and
 * `exarchos_view`. They validate their arguments, then delegate to the {@link WorktreeManager},
 * the merge serializer, or a reconciler. The CLI and MCP adapters share one composite router, so
 * the same context and arguments give the same `ToolResult` on both.
 */

import type { DispatchContext } from '../../dispatch/core/dispatch.js';
import type { ToolResult } from '../../format.js';
import {
  WorktreeManager,
  DEFAULT_WAIT_TIMEOUT_MS,
  type WorktreeManagerDeps,
  type ReserveInput,
} from './manager.js';
import {
  defaultProcessSource,
  resolveStartedAt,
  type ProcessSource,
} from './pure/process-identity.js';
import { canonicalWorktreeId, defaultRealpath } from './pure/path-containment.js';
import {
  serializeMerge,
  type SerializeMergeInput,
  type SerializeMergeDeps,
  reconcileMerges,
} from './merge-serializer.js';
import type { SleepFn } from './git-retry.js';
import type { InFlightMerge, InFlightPrune } from './projections/worktrees.js';
import { reconcileLaunches } from '../../runtime/launcher/launch-reconcile.js';
import {
  DEFAULT_VIEW_ITEM_CAP,
  SUMMARY_FIRST_PAGE_ITEMS,
  estimateOutputTokens,
  resolveOutputTokenThreshold,
  countBy,
  narrowAffordance,
} from '../../dispatch/core/economy.js';
import type { QualityHintsConfig } from '../../workflow/capabilities/resolver.js';

/**
 * Test seam: the subset of {@link WorktreeManagerDeps} that a caller can inject, such as a fake git
 * probe or process source. Production callers omit it, so the manager uses the real defaults. The
 * registry input schema does not expose these fields.
 */
type InjectableDeps = Omit<WorktreeManagerDeps, 'eventStore'>;

/** Builds a {@link WorktreeManager} over the dispatch event store and the optional deps. */
function buildManager(ctx: DispatchContext, deps?: InjectableDeps): WorktreeManager {
  return new WorktreeManager({ eventStore: ctx.eventStore, ...deps });
}

function invalidInput(message: string, expectedShape?: Record<string, unknown>): ToolResult {
  return {
    success: false,
    error: { code: 'INVALID_INPUT', message, ...(expectedShape ? { expectedShape } : {}) },
  };
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function optionalBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

/** Parses a non-negative integer from a number or a numeric string. */
function optionalNonNegInt(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0) return value;
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value);
  return undefined;
}

/** Parses a positive integer from a number or a numeric string. */
function optionalPosInt(value: unknown): number | undefined {
  const n = optionalNonNegInt(value);
  return n !== undefined && n >= 1 ? n : undefined;
}

/**
 * Resolves the reserving process identity. The caller passes both `ownerPid` and `ownerStartedAt`
 * or neither, because one field alone gives a fingerprint that no real process had. With neither,
 * it uses `process.pid` and its create time, so the reservation heals after this process dies. An
 * unresolvable create time is `null`, never `''`. An explicit `ownerStartedAt` must not be empty.
 */
function resolveOwner(
  rest: Record<string, unknown>,
  processSource: ProcessSource,
):
  | { ok: true; owner: { ownerPid: number; ownerStartedAt: string | null } }
  | { ok: false; error: string } {
  const hasPid = rest.ownerPid !== undefined;
  const hasStartedAt = rest.ownerStartedAt !== undefined;

  if (hasPid !== hasStartedAt) {
    return {
      ok: false,
      error:
        'ownerPid and ownerStartedAt must be provided together (both or neither) — a partial owner override would persist a tuple no real process had',
    };
  }

  if (hasPid && hasStartedAt) {
    const explicitPid = rest.ownerPid;
    if (
      typeof explicitPid !== 'number' ||
      !Number.isInteger(explicitPid) ||
      explicitPid <= 0
    ) {
      return { ok: false, error: 'ownerPid must be a positive integer' };
    }
    const explicitStartedAt = optionalString(rest.ownerStartedAt);
    if (explicitStartedAt === undefined || explicitStartedAt.length === 0) {
      return { ok: false, error: 'ownerStartedAt must be a non-empty string' };
    }
    return { ok: true, owner: { ownerPid: explicitPid, ownerStartedAt: explicitStartedAt } };
  }

  const ownerPid = process.pid;
  const ownerStartedAt = resolveStartedAt(processSource, ownerPid);
  return { ok: true, owner: { ownerPid, ownerStartedAt } };
}

/**
 * Runs the adopt pass over `repoRoot`, then reserves `worktreeId` for the live owner. When the
 * adopt pass saw the target and reports it not mutable, it returns `WORKTREE_NOT_MUTABLE`, because
 * a stale worktree can drop newly pushed files. The gate lookup uses the canonical id, because
 * adopt stamps canonical ids and a Windows path can differ. The reservation keys on `worktreeId`
 * as passed, so release and view stay consistent.
 */
export async function handleAcquireWorktree(
  args: Record<string, unknown>,
  ctx: DispatchContext,
  deps?: InjectableDeps,
): Promise<ToolResult> {
  const repoRoot = optionalString(args.repoRoot);
  if (!repoRoot) {
    return invalidInput('acquire_worktree requires repoRoot: string', {
      repoRoot: 'string',
    });
  }
  const worktreeId = optionalString(args.worktreeId);
  if (!worktreeId) {
    return invalidInput('acquire_worktree requires worktreeId: string', {
      worktreeId: 'string',
    });
  }
  const manager = buildManager(ctx, deps);
  const processSource = deps?.processSource ?? defaultProcessSource;

  const adoptResult = await manager.adopt(repoRoot);

  const canonicalIdForGate =
    adoptResult.worktrees.length > 0
      ? canonicalWorktreeId(worktreeId, deps?.realpath ?? defaultRealpath)
      : undefined;
  const adoptReport =
    canonicalIdForGate === undefined
      ? undefined
      : adoptResult.worktrees.find((w) => w.worktreeId === canonicalIdForGate);
  if (adoptReport !== undefined && !adoptReport.verification.mutable) {
    return {
      success: false,
      error: {
        code: 'WORKTREE_NOT_MUTABLE',
        message: `worktree ${worktreeId} is not mutable (${adoptReport.verification.reason}) — refusing to reserve a stale worktree for mutation`,
      },
    };
  }

  const ownerResult = resolveOwner(args, processSource);
  if (!ownerResult.ok) {
    return invalidInput(ownerResult.error, {
      ownerPid: 'number (with ownerStartedAt)',
      ownerStartedAt: 'string (with ownerPid)',
    });
  }

  const featureId = args.featureId === null ? null : optionalString(args.featureId) ?? null;
  const reserveInput: ReserveInput = {
    worktreeId,
    path: optionalString(args.path) ?? worktreeId,
    featureId,
    ownerPid: ownerResult.owner.ownerPid,
    ownerStartedAt: ownerResult.owner.ownerStartedAt,
  };
  const reserveResult = await manager.reserve(reserveInput);

  if (!reserveResult.reserved) {
    return {
      success: false,
      error: {
        code: 'WORKTREE_RESERVED',
        message: `worktree ${worktreeId} is already reserved by a live owner`,
        ...(reserveResult.conflict
          ? { conflict: reserveResult.conflict }
          : {}),
      },
    };
  }

  return {
    success: true,
    data: {
      worktreeId,
      path: reserveInput.path,
      featureId,
      reserved: true,
      adopted: adoptResult.adopted.includes(worktreeId),
    },
  };
}

/**
 * Releases the reservation of the caller with a `worktree.released` event. It refuses a worktree
 * that a different live owner holds, because reaping a dead owner is the job of the reconcile pass.
 * For an unknown, unreserved, dead-owner or same-owner worktree, it appends a released event with
 * cleared owner fields.
 */
export async function handleReleaseWorktree(
  args: Record<string, unknown>,
  ctx: DispatchContext,
  deps?: InjectableDeps,
): Promise<ToolResult> {
  const worktreeId = optionalString(args.worktreeId);
  if (!worktreeId) {
    return invalidInput('release_worktree requires worktreeId: string', {
      worktreeId: 'string',
    });
  }
  const manager = buildManager(ctx, deps);
  const processSource = deps?.processSource ?? defaultProcessSource;
  const ownerResult = resolveOwner(args, processSource);
  if (!ownerResult.ok) {
    return invalidInput(ownerResult.error, {
      ownerPid: 'number (with ownerStartedAt)',
      ownerStartedAt: 'string (with ownerPid)',
    });
  }
  const result = await manager.release(worktreeId, ownerResult.owner);
  if (result.rejectedForeignOwner) {
    return {
      success: false,
      error: {
        code: 'WORKTREE_OWNED_BY_OTHER',
        message: `worktree ${worktreeId} is reserved by a different live owner — refusing to release another process's claim`,
      },
    };
  }
  return {
    success: true,
    data: { worktreeId, released: result.released },
  };
}

/**
 * The fail-closed worktree GC. It is a dry run unless `dryRun` is `false`, and a dry run deletes
 * nothing. Orphan deletion also needs `pruneOrphans` and `yes`. The dry-run default lives here, not
 * on the schema, because the MCP registration flattener forbids different defaults on a shared
 * field.
 */
export async function handlePruneWorktrees(
  args: Record<string, unknown>,
  ctx: DispatchContext,
  deps?: InjectableDeps,
): Promise<ToolResult> {
  const repoRoot = optionalString(args.repoRoot);
  if (!repoRoot) {
    return invalidInput('prune_worktrees requires repoRoot: string', {
      repoRoot: 'string',
    });
  }
  const apply = optionalBoolean(args.dryRun) === false;
  const manager = buildManager(ctx, deps);
  const result = await manager.prune({
    repoRoot,
    apply,
    pruneOrphans: optionalBoolean(args.pruneOrphans),
    yes: optionalBoolean(args.yes),
  });
  return { success: true, data: result };
}

/**
 * Returns the governed worktrees from the `worktrees@v1` projection, with no adopt, git probe or
 * append. Without `limit`, it caps the items at `DEFAULT_VIEW_ITEM_CAP`. When the capped payload
 * exceeds `qualityHints.outputTokenThreshold`, it returns counts by state and a first page. An
 * unresolvable threshold falls back to the item cap.
 */
export async function handleViewWorktrees(
  args: Record<string, unknown>,
  ctx: DispatchContext,
  deps?: InjectableDeps,
): Promise<ToolResult> {
  const manager = buildManager(ctx, deps);
  const all = await manager.list();
  const total = all.length;

  const offset = optionalNonNegInt(args.offset) ?? 0;
  const limitArg = optionalPosInt(args.limit);
  const explicitLimit = limitArg !== undefined;
  const pageSize = explicitLimit ? limitArg : DEFAULT_VIEW_ITEM_CAP;
  const worktrees = all.slice(offset, offset + pageSize);
  const capTruncated = !explicitLimit && total - offset > DEFAULT_VIEW_ITEM_CAP;

  const config = ctx.config as QualityHintsConfig | undefined;
  const narrowHint = 'exarchos vw worktrees --limit 20 --offset 0';

  const detailData = { worktrees, count: worktrees.length };
  const threshold = resolveOutputTokenThreshold(config);
  if (threshold !== null && estimateOutputTokens(detailData) > threshold) {
    const firstPage = worktrees.slice(0, SUMMARY_FIRST_PAGE_ITEMS);
    return {
      success: true,
      data: {
        summary: { total, byState: countBy(all, (w) => w.state), firstPage },
        total,
        truncated: true,
      },
      next_actions: [narrowAffordance('worktrees', firstPage.length, total, narrowHint)],
    };
  }

  if (capTruncated) {
    return {
      success: true,
      data: { worktrees, count: worktrees.length, total, truncated: true },
      next_actions: [narrowAffordance('worktrees', worktrees.length, total, narrowHint)],
    };
  }

  return {
    success: true,
    data: detailData,
  };
}

/**
 * Serializes an integration-branch merge behind a lease per `integrationRef`, then runs
 * `merge_orchestrate`. The lease is a `worktree.merge_requested` and `worktree.merge_executed`
 * pair on the `worktrees` stream. It is a dry run unless `dryRun` is `false`, and a dry run claims
 * no lease and runs no merge. The default lives here for the reason in
 * {@link handlePruneWorktrees}. Direct callers of `serializeMerge` pass their own `dryRun`.
 */
export async function handleSerializeMerge(
  args: Record<string, unknown>,
  ctx: DispatchContext,
  deps?: SerializeMergeDeps,
): Promise<ToolResult> {
  const featureId = optionalString(args.featureId);
  if (!featureId) {
    return invalidInput('serialize_merge requires featureId: string', {
      featureId: 'string',
    });
  }
  const integrationRef = optionalString(args.integrationRef);
  if (!integrationRef) {
    return invalidInput('serialize_merge requires integrationRef: string', {
      integrationRef: 'string',
    });
  }
  const sourceBranch = optionalString(args.sourceBranch);
  if (!sourceBranch) {
    return invalidInput('serialize_merge requires sourceBranch: string', {
      sourceBranch: 'string',
    });
  }
  const strategy = optionalString(args.strategy);
  if (strategy !== 'squash' && strategy !== 'rebase' && strategy !== 'merge') {
    return invalidInput(
      "serialize_merge requires strategy: 'squash' | 'rebase' | 'merge'",
      { strategy: "'squash' | 'rebase' | 'merge'" },
    );
  }
  const taskId = optionalString(args.taskId);
  const repoRoot = optionalString(args.repoRoot);
  const timeoutMs =
    typeof args.timeoutMs === 'number' &&
    Number.isInteger(args.timeoutMs) &&
    args.timeoutMs > 0
      ? args.timeoutMs
      : undefined;

  const dryRun = optionalBoolean(args.dryRun) !== false;

  const input: SerializeMergeInput = {
    featureId,
    integrationRef,
    sourceBranch,
    strategy,
    dryRun,
    ...(taskId !== undefined ? { taskId } : {}),
    ...(repoRoot !== undefined ? { repoRoot } : {}),
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
  };
  return serializeMerge(input, ctx, deps);
}

/**
 * Test seam for the `ps`, `wait` and `reconcile_worktrees` handlers. It adds the probe self-PID
 * and the wait timing to {@link InjectableDeps}. Production dispatch omits every field.
 */
export interface WorktreeViewDeps extends InjectableDeps {
  /** Probe self-PID whose FULL ancestry is excluded from occupancy. Defaults to `process.pid`. */
  readonly selfPid?: number;
  /** Bounded-wait sleep seam (shared with `git-retry.ts`). Defaults to the real `setTimeout` sleep. */
  readonly sleep?: SleepFn;
  /** Monotone clock for the wait deadline. Defaults to `Date.now`. */
  readonly now?: () => number;
  /** Wait poll interval (ms). Defaults to the manager's `DEFAULT_WAIT_POLL_INTERVAL_MS`. */
  readonly pollIntervalMs?: number;
}

/**
 * `ps`: lists the in-flight merges, launches and prune passes from the `worktrees@v1` projection.
 * An entry is in flight while its start event has no terminal event. It is a pure read with no
 * process scan. {@link handleReconcileWorktrees} runs the process probe and the reconcilers.
 */
export async function handleViewPs(
  args: Record<string, unknown>,
  ctx: DispatchContext,
  deps?: WorktreeViewDeps,
): Promise<ToolResult> {
  const manager = buildManager(ctx, deps);
  const inFlight = await manager.listInFlightMerges();
  const launches = await manager.listInFlightLaunches();
  const prunes = await manager.listInFlightPrunes();

  return {
    success: true,
    data: {
      inFlight,
      count: inFlight.length,
      launches,
      launchCount: launches.length,
      prunes,
      pruneCount: prunes.length,
    },
  };
}

/**
 * `reconcile_worktrees`: runs three reconcile passes against one process table, the real OS table
 * when none is injected:
 *   1. {@link WorktreeManager.probeAndReclaim} appends `worktree.released` or
 *      `worktree.orphan_detected` for a dead owner.
 *   2. {@link reconcileLaunches} closes a launch whose supervisor is dead with `launch.executed`.
 *   3. {@link reconcileMerges} frees a lease whose holder is dead with `worktree.merge_executed`.
 * A live or unprovable holder stays in flight. The in-flight columns fold after the passes, so no
 * entry reads as both in flight and reconciled.
 */
export async function handleReconcileWorktrees(
  _args: Record<string, unknown>,
  ctx: DispatchContext,
  deps?: WorktreeViewDeps,
): Promise<ToolResult> {
  const manager = buildManager(ctx, deps);
  const reclaim = await manager.probeAndReclaim(deps?.selfPid);
  const reconcile = await reconcileLaunches(ctx.eventStore, deps?.processTableSource);
  const mergeReconcile = await reconcileMerges(ctx.eventStore, deps?.processTableSource);
  const launches = await manager.listInFlightLaunches();
  const inFlight = await manager.listInFlightMerges();
  const prunes = await manager.listInFlightPrunes();
  return {
    success: true,
    data: {
      inFlight,
      count: inFlight.length,
      launches,
      launchCount: launches.length,
      prunes,
      pruneCount: prunes.length,
      probe: reclaim,
      reconcile,
      mergeReconcile,
    },
  };
}

/**
 * Structured timeout result of the merge wait in {@link handleViewWait}. The error envelope has a
 * fixed field set, so the payload goes in `data` with the stable `reason` discriminator.
 */
function waitTimeout(
  integrationRef: string,
  timeoutMs: number,
  holder: InFlightMerge,
): ToolResult {
  return {
    success: false,
    error: {
      code: 'WAIT_TIMEOUT',
      message: `merge slot for integration ref '${integrationRef}' did not reach a terminal worktree.merge_executed within ${timeoutMs}ms`,
    },
    data: {
      reason: 'wait-timeout' as const,
      integrationRef,
      timeoutMs,
      holder: {
        operationId: holder.operationId,
        sourceBranch: holder.sourceBranch,
        holderPid: holder.holderPid,
      },
    },
  };
}

/** Structured timeout result of the `until: 'idle'` wait, in the same form as `waitTimeout`. */
function idleTimeout(
  timeoutMs: number,
  holders: readonly InFlightPrune[],
): ToolResult {
  return {
    success: false,
    error: {
      code: 'WAIT_TIMEOUT',
      message: `worktree layer did not become prune-idle within ${timeoutMs}ms (${holders.length} in-flight prune pass${holders.length === 1 ? '' : 'es'} still running)`,
    },
    data: {
      reason: 'wait-idle-timeout' as const,
      timeoutMs,
      holders: holders.map((h) => ({
        operationId: h.operationId,
        repoRoot: h.repoRoot,
        holderPid: h.holderPid,
      })),
    },
  };
}

/**
 * `wait`: polls the `worktrees@v1` projection until a condition holds or `timeoutMs` passes. It
 * appends nothing, starts no background timer, and returns a structured result on timeout.
 * `until: 'merge'`, the default, waits for `worktree.merge_executed` on `integrationRef`, which it
 * requires. `until: 'idle'` waits until no `prune_worktrees` pass is in flight.
 */
export async function handleViewWait(
  args: Record<string, unknown>,
  ctx: DispatchContext,
  deps?: WorktreeViewDeps,
): Promise<ToolResult> {
  const until = optionalString(args.until) ?? 'merge';
  if (until !== 'merge' && until !== 'idle') {
    return invalidInput("wait requires until: 'merge' | 'idle'", {
      until: "'merge' | 'idle'",
    });
  }
  const timeoutMs =
    typeof args.timeoutMs === 'number' &&
    Number.isInteger(args.timeoutMs) &&
    args.timeoutMs > 0
      ? args.timeoutMs
      : DEFAULT_WAIT_TIMEOUT_MS;

  const manager = buildManager(ctx, deps);
  const timing = {
    timeoutMs,
    ...(deps?.sleep !== undefined ? { sleep: deps.sleep } : {}),
    ...(deps?.now !== undefined ? { now: deps.now } : {}),
    ...(deps?.pollIntervalMs !== undefined ? { pollIntervalMs: deps.pollIntervalMs } : {}),
  };

  if (until === 'idle') {
    const idle = await manager.waitForPruneIdle(timing);
    if (idle.resolved) {
      return {
        success: true,
        data: { until: 'idle', resolved: true, waitedMs: idle.waitedMs },
      };
    }
    return idleTimeout(timeoutMs, idle.holders);
  }

  const integrationRef = optionalString(args.integrationRef);
  if (!integrationRef) {
    return invalidInput('wait requires integrationRef: string', {
      integrationRef: 'string',
    });
  }
  const result = await manager.waitForMergeTerminal(integrationRef, timing);
  if (result.resolved) {
    return {
      success: true,
      data: { integrationRef, resolved: true, waitedMs: result.waitedMs },
    };
  }
  return waitTimeout(integrationRef, timeoutMs, result.holder);
}

/**
 * The worktree scope of the generic `wait` verb. The router in `projections/views/lifecycle/wait.ts`
 * calls it when the request has no `phase`, `status` or `operation` predicate. It is the same
 * function as {@link handleViewWait}, so the suites that import `handleViewWait` still cover it.
 */
export const handleWorktreeUntilWait = handleViewWait;

/**
 * The worktree scope of the generic `ps` verb. The router in `projections/views/lifecycle/ps.ts`
 * calls it for `scope: 'worktree'`. It is the same function as {@link handleViewPs}.
 */
export const handleWorktreeScopePs = handleViewPs;
