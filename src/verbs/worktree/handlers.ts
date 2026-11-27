/**
 * Read handlers for the worktree views: `worktrees`, the worktree scope of `ps` and the `until`
 * scope of `wait`. Each one folds the `worktrees@v1` projection of the singleton `worktrees`
 * stream. They append no event and start no process. The harness owns worktree setup, ownership
 * and removal, so no code writes this stream now. Old logs still fold to the same view.
 * The side-effect import of `./projections/index.js` registers the reducer once per process.
 */

import type { DispatchContext } from '../../dispatch/core/dispatch.js';
import type { EventStore } from '../../events/store.js';
import type { ToolResult } from '../../format.js';
import type {
  InFlightMerge,
  InFlightPrune,
  WorktreeEntry,
  WorktreesProjection,
} from './projections/worktrees.js';
import './projections/index.js';
import {
  DEFAULT_VIEW_ITEM_CAP,
  SUMMARY_FIRST_PAGE_ITEMS,
  estimateOutputTokens,
  resolveOutputTokenThreshold,
  countBy,
  narrowAffordance,
} from '../../dispatch/core/economy.js';
import type { QualityHintsConfig } from '../../workflow/capabilities/resolver.js';

/** The singleton stream that holds the worktree-lifecycle rows of old logs. */
export const WORKTREES_STREAM = 'worktrees';

/** The reducer id of the worktree read model. */
export const WORKTREES_REDUCER = 'worktrees@v1';

/** The default limit of a bounded wait, in milliseconds. */
export const DEFAULT_WAIT_TIMEOUT_MS = 30_000;

/** The default interval between two folds of a bounded wait, in milliseconds. */
export const DEFAULT_WAIT_POLL_INTERVAL_MS = 200;

/** The delay function of the bounded waits. Tests replace it to skip the real wait. */
export type SleepFn = (ms: number) => Promise<void>;

/** The real sleep over `setTimeout`. */
export const defaultSleep: SleepFn = (ms) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Test seam for the `ps` and `wait` handlers: the wait timing only. Production dispatch omits
 * every field.
 */
export interface WorktreeViewDeps {
  /** Bounded-wait sleep. Defaults to the real `setTimeout` sleep. */
  readonly sleep?: SleepFn;
  /** Monotone clock for the wait deadline. Defaults to `Date.now`. */
  readonly now?: () => number;
  /** Wait poll interval in milliseconds. Defaults to `DEFAULT_WAIT_POLL_INTERVAL_MS`. */
  readonly pollIntervalMs?: number;
}

/** Folds the `worktrees@v1` projection of the singleton stream. */
async function loadProjection(eventStore: EventStore): Promise<WorktreesProjection> {
  const { aggregate } = await eventStore
    .getAppender()
    .aggregateStream<WorktreesProjection>(WORKTREES_STREAM, WORKTREES_REDUCER);
  return aggregate;
}

/** The launch rows of the projection: entries that still carry a launch. */
function inFlightLaunches(projection: WorktreesProjection): readonly WorktreeEntry[] {
  return Object.values(projection.worktrees).filter((entry) => entry.launch !== undefined);
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
 * Returns the worktrees of the `worktrees@v1` projection. Without `limit`, it caps the items at
 * `DEFAULT_VIEW_ITEM_CAP`. When the capped payload exceeds `qualityHints.outputTokenThreshold`,
 * it returns counts by state and a first page. An unresolvable threshold falls back to the cap.
 */
export async function handleViewWorktrees(
  args: Record<string, unknown>,
  ctx: DispatchContext,
): Promise<ToolResult> {
  const all = Object.values((await loadProjection(ctx.eventStore)).worktrees);
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
 * `ps`: lists the in-flight merges, launches and prune passes of the `worktrees@v1` projection.
 * An entry is in flight while its start event has no terminal event. It is a pure read.
 */
export async function handleViewPs(
  _args: Record<string, unknown>,
  ctx: DispatchContext,
  _deps?: WorktreeViewDeps,
): Promise<ToolResult> {
  const projection = await loadProjection(ctx.eventStore);
  const inFlight = Object.values(projection.inFlightMerges);
  const launches = inFlightLaunches(projection);
  const prunes = Object.values(projection.inFlightPrunes);

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

/** The outcome of one bounded poll: resolved, or the projection value that still blocks it. */
type PollResult<T> =
  | { readonly resolved: true; readonly waitedMs: number }
  | { readonly resolved: false; readonly blocker: T; readonly waitedMs: number };

/**
 * Folds the projection until `blockerOf` returns `undefined` or the limit passes. It sleeps
 * through the injected {@link SleepFn}, appends nothing and starts no background timer.
 */
async function pollUntilClear<T>(
  eventStore: EventStore,
  blockerOf: (projection: WorktreesProjection) => T | undefined,
  timeoutMs: number,
  deps: WorktreeViewDeps | undefined,
): Promise<PollResult<T>> {
  const sleep = deps?.sleep ?? defaultSleep;
  const now = deps?.now ?? Date.now;
  const pollIntervalMs = deps?.pollIntervalMs ?? DEFAULT_WAIT_POLL_INTERVAL_MS;
  const start = now();
  const deadline = start + timeoutMs;
  while (true) {
    const blocker = blockerOf(await loadProjection(eventStore));
    if (blocker === undefined) return { resolved: true, waitedMs: now() - start };
    if (now() >= deadline) return { resolved: false, blocker, waitedMs: now() - start };
    await sleep(pollIntervalMs);
  }
}

/**
 * `wait`: polls the `worktrees@v1` projection until a condition holds or `timeoutMs` passes. It
 * appends nothing, starts no background timer, and returns a structured result on timeout.
 * `until: 'merge'`, the default, waits until `integrationRef` has no in-flight merge, and it
 * requires `integrationRef`. `until: 'idle'` waits until no recorded prune pass is in flight.
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

  if (until === 'idle') {
    const idle = await pollUntilClear(
      ctx.eventStore,
      (projection) => {
        const holders = Object.values(projection.inFlightPrunes);
        return holders.length === 0 ? undefined : holders;
      },
      timeoutMs,
      deps,
    );
    if (idle.resolved) {
      return {
        success: true,
        data: { until: 'idle', resolved: true, waitedMs: idle.waitedMs },
      };
    }
    return idleTimeout(timeoutMs, idle.blocker);
  }

  const integrationRef = optionalString(args.integrationRef);
  if (!integrationRef) {
    return invalidInput('wait requires integrationRef: string', {
      integrationRef: 'string',
    });
  }
  const result = await pollUntilClear(
    ctx.eventStore,
    (projection) => projection.inFlightMerges[integrationRef],
    timeoutMs,
    deps,
  );
  if (result.resolved) {
    return {
      success: true,
      data: { integrationRef, resolved: true, waitedMs: result.waitedMs },
    };
  }
  return waitTimeout(integrationRef, timeoutMs, result.blocker);
}

/**
 * The worktree scope of the generic `wait` verb. The router in `projections/views/lifecycle/wait.ts`
 * calls it when the request has no `phase`, `status` or `operation` predicate. It is the same
 * function as {@link handleViewWait}.
 */
export const handleWorktreeUntilWait = handleViewWait;

/**
 * The worktree scope of the generic `ps` verb. The router in `projections/views/lifecycle/ps.ts`
 * calls it for `scope: 'worktree'`. It is the same function as {@link handleViewPs}.
 */
export const handleWorktreeScopePs = handleViewPs;
