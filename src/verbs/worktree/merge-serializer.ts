/**
 * Merge serializer for an integration branch. `serialize_merge` is an optimistic lease that allows at most one in-flight merge per `integrationRef`.
 * It then calls `merge_orchestrate` unchanged for the git work.
 * The lease lives only in the event log, folded by `worktrees@v1` into `inFlightMerges`. There is no file lock and no PID file.
 *
 * The claim, `worktree.merge_requested`, commits through `decide` under `withStateRetry`, so at most one claimant wins per ref.
 * The release, `worktree.merge_executed`, is a keyed append with no sequence pin, because other worktree events move the stream during the merge.
 * When the slot is held, the lease waits under a timeout with the shared `sleep` seam, and returns `merge-slot-timeout` on expiry.
 * Each wait probes the holder, and reclaims a holder that is provably dead.
 *
 * It uses the stream and reducer ids of `manager.ts`, and the side-effect import of `./projections/index.js` registers the reducer.
 */

import { randomUUID } from 'node:crypto';

import type { DispatchContext } from '../../dispatch/core/dispatch.js';
import type { ToolResult } from '../../format.js';
import type { AtomicAppender } from '../../events/atomic-appender.js';
import type { EventStore } from '../../events/store.js';
import { ConcurrencyError, StorageBusyError } from '../../events/index.js';
import { withStateRetry } from '../../workflow/state-retry.js';
import {
  handleMergeOrchestrate,
  type HandleMergeOrchestrateInput,
} from '../merge/merge-orchestrate.js';
import { defaultGitExec } from '../vcs/git-exec-default.js';
import type { GitExec } from '../pure/merge-preflight.js';
import { WORKTREES_STREAM, WORKTREES_REDUCER } from './manager.js';
import './projections/index.js';
import type {
  WorktreesProjection,
  InFlightMerge,
} from './projections/worktrees.js';
import { defaultSleep, type SleepFn } from './git-retry.js';
import {
  probeReservations,
  defaultProcessTableSource,
  type ProcessTableSource,
} from './pure/probe.js';
import {
  defaultProcessSource,
  type ProcessSource,
} from './pure/process-identity.js';

/** Default bounded-wait budget (ms) before a held slot yields `merge-slot-timeout`. */
export const DEFAULT_MERGE_SLOT_TIMEOUT_MS = 30_000;

/** Default poll interval (ms) between wait-for-slot re-folds. */
export const DEFAULT_MERGE_SLOT_POLL_INTERVAL_MS = 200;

/** Caller-facing arguments for {@link serializeMerge}. */
export interface SerializeMergeInput {
  /** Owning feature workflow id — the per-featureId stream `merge_orchestrate` writes to. */
  readonly featureId: string;
  /** Integration ref the merge targets — the per-branch serialization key (= `targetBranch`). */
  readonly integrationRef: string;
  /** Branch being merged into `integrationRef`. */
  readonly sourceBranch: string;
  /** Merge strategy, threaded UNCHANGED to `merge_orchestrate`. */
  readonly strategy: 'squash' | 'rebase' | 'merge';
  /** Optional task id, threaded UNCHANGED to `merge_orchestrate`. */
  readonly taskId?: string;
  /** Optional repository root for the fresh-HEAD read + `merge_orchestrate`. */
  readonly repoRoot?: string;
  /** Bounded-wait budget (ms). Defaults to {@link DEFAULT_MERGE_SLOT_TIMEOUT_MS}. */
  readonly timeoutMs?: number;
  /**
   * When `true`, the serializer claims no lease and runs no merge. It reads the integration head and returns the planned effect.
   * Undefined means an apply run here. The handler boundary, {@link handleSerializeMerge}, makes dry run the default.
   */
  readonly dryRun?: boolean;
}

/** Injected seams for timing, the process table, git and the merge, so tests need no OS or git. Production callers omit every field. */
export interface SerializeMergeDeps {
  /** Bounded-wait sleep seam (SHARED with `git-retry.ts`). Defaults to {@link defaultSleep}. */
  readonly sleep?: SleepFn;
  /** Monotone clock for the deadline. Defaults to `Date.now`. */
  readonly now?: () => number;
  /** Wait-for-slot poll interval (ms). Defaults to {@link DEFAULT_MERGE_SLOT_POLL_INTERVAL_MS}. */
  readonly pollIntervalMs?: number;
  /** Process-table probe for dead-holder reclamation. Defaults to {@link defaultProcessTableSource}. */
  readonly processTableSource?: ProcessTableSource;
  /** Per-PID source for the claiming process's own create-time. Defaults to {@link defaultProcessSource}. */
  readonly processSource?: ProcessSource;
  /** PID stamped on the claim (lease holder identity). Defaults to `process.pid`. */
  readonly selfPid?: number;
  /** Create-time fingerprint stamped on the claim. Defaults to the resolved create-time of `selfPid`, or `null` when the platform cannot resolve it. */
  readonly selfStartedAt?: string | null;
  /** The merge COMPOSED UNCHANGED. Defaults to the real {@link handleMergeOrchestrate}. */
  readonly mergeOrchestrate?: (
    input: HandleMergeOrchestrateInput,
    ctx: DispatchContext,
  ) => Promise<ToolResult>;
  /** Reads the fresh integration HEAD just before the merge. Defaults to a `git rev-parse` over {@link defaultGitExec}. */
  readonly readIntegrationHead?: (input: SerializeMergeInput) => string | null;
}

function buildDefaultReadIntegrationHead(gitExec: GitExec): (input: SerializeMergeInput) => string | null {
  return (input) => {
    const repoRoot = input.repoRoot ?? process.cwd();
    const result = gitExec(repoRoot, ['rev-parse', '--verify', input.integrationRef]);
    if (result.exitCode !== 0) return null;
    const sha = result.stdout.trim();
    return sha.length > 0 ? sha : null;
  };
}

/**
 * Whether the lease holder is provably dead, through the same {@link probeReservations} probe that the manager uses for reservations.
 * Provably dead means that the PID is absent from a supported process table, or that its create-time differs.
 * It returns `false` for a holder with a null PID or create-time, and for an unsupported process table, so a live lease is never taken.
 */
function isHolderProvablyDead(
  holder: InFlightMerge,
  source: ProcessTableSource,
): boolean {
  if (holder.holderPid === null || holder.holderStartedAt === null) {
    return false;
  }
  const [finding] = probeReservations(
    [
      {
        worktreePath: holder.integrationRef,
        ownerPid: holder.holderPid,
        ownerStartedAt: holder.holderStartedAt,
      },
    ],
    source,
  );
  return finding?.releasable === true;
}

/**
 * Appends the terminal `worktree.merge_executed`, keyed by `<eventType>:<operationId>` and with no sequence pin.
 * A sequence pin to the claim makes every retry fail, because other worktree events move the stream between claim and release.
 * The normal release uses the caller `operationId`, and a reclaim uses the original holder `operationId`, so two racing reclaimers make one release.
 * The payload has no `sourceBranch`, because the reducer matches the claim by `integrationRef` and `operationId`.
 */
async function appendMergeExecuted(
  appender: AtomicAppender,
  merge: { integrationRef: string; operationId: string; worktreeId?: string | null },
  outcome: {
    status: 'merged' | 'aborted' | 'failed';
    mergeSha?: string;
    recoveryError?: string;
  },
): Promise<void> {
  await appender.append(
    WORKTREES_STREAM,
    [
      {
        type: 'worktree.merge_executed',
        data: {
          integrationRef: merge.integrationRef,
          operationId: merge.operationId,
          status: outcome.status,
          ...(outcome.mergeSha != null ? { mergeSha: outcome.mergeSha } : {}),
          ...(outcome.recoveryError != null ? { recoveryError: outcome.recoveryError } : {}),
          ...(merge.worktreeId != null ? { worktreeId: merge.worktreeId } : {}),
        },
      },
    ],
    `worktree.merge_executed:${merge.operationId}`,
  );
}

/**
 * Tries the claim under optimistic concurrency. It returns `true` only when this call committed `worktree.merge_requested`.
 * The empty-slot check is inside the `decide` closure, so a losing claimant re-folds, sees the holder, and emits nothing.
 * `alwaysEnforceConsistency: false` keeps a no-op from throwing on an unrelated worktree append. The emit path still commits under the sequence check.
 * After the retry budget, `ConcurrencyError` or `StorageBusyError` returns `false`, and other errors propagate.
 */
async function tryClaim(
  appender: AtomicAppender,
  input: SerializeMergeInput,
  operationId: string,
  holderPid: number,
  holderStartedAt: string | null,
): Promise<boolean> {
  let claimed = false;
  try {
    await withStateRetry(async () => {
      claimed = false;
      const result = await appender.decide<WorktreesProjection>(
        WORKTREES_STREAM,
        WORKTREES_REDUCER,
        (state) => {
          if (state.inFlightMerges[input.integrationRef] !== undefined) {
            return [];
          }
          return [
            {
              type: 'worktree.merge_requested',
              data: {
                integrationRef: input.integrationRef,
                operationId,
                sourceBranch: input.sourceBranch,
                holderPid,
                holderStartedAt,
              },
            },
          ];
        },
        { operationId, alwaysEnforceConsistency: false },
      );
      claimed = result.kind !== 'no-op';
    });
  } catch (err) {
    if (err instanceof ConcurrencyError || err instanceof StorageBusyError) {
      return false;
    }
    throw err;
  }
  return claimed;
}

/** Builds the `MERGE_SLOT_TIMEOUT` error. The details go in `data`, because the error envelope has a fixed field set, and callers match on `reason`. */
function mergeSlotTimeout(
  input: SerializeMergeInput,
  timeoutMs: number,
  holder: InFlightMerge | undefined,
): ToolResult {
  return {
    success: false,
    error: {
      code: 'MERGE_SLOT_TIMEOUT',
      message: `merge slot for integration ref '${input.integrationRef}' is held by a live process after ${timeoutMs}ms`,
    },
    data: {
      reason: 'merge-slot-timeout' as const,
      integrationRef: input.integrationRef,
      timeoutMs,
      ...(holder !== undefined
        ? {
            holder: {
              operationId: holder.operationId,
              sourceBranch: holder.sourceBranch,
              holderPid: holder.holderPid,
            },
          }
        : {}),
    },
  };
}

/**
 * Serializes a merge of `sourceBranch` into `integrationRef` behind the lease, then calls `merge_orchestrate`.
 * On success it returns the merge result with the lease data under `serializedMerge`. The `merge.*` events stay the same as for a direct call.
 * It returns `merge-slot-timeout` when a live holder keeps the slot past the budget.
 *
 * A dry run claims no lease, runs no merge and appends no event. It returns the planned effect with the integration head from `git rev-parse`.
 * It passes its lease `operationId` to `merge_orchestrate`, so the single-writer guard there accepts the lease as its own.
 * It releases in `finally` with status `failed` unless the merge succeeds. A failed release is ignored, and the dead-holder reclaim frees the slot after this process exits.
 */
export async function serializeMerge(
  input: SerializeMergeInput,
  ctx: DispatchContext,
  deps: SerializeMergeDeps = {},
): Promise<ToolResult> {
  const sleep = deps.sleep ?? defaultSleep;
  const now = deps.now ?? Date.now;
  const pollIntervalMs = deps.pollIntervalMs ?? DEFAULT_MERGE_SLOT_POLL_INTERVAL_MS;
  const processTableSource = deps.processTableSource ?? defaultProcessTableSource;
  const processSource = deps.processSource ?? defaultProcessSource;
  const mergeOrchestrate = deps.mergeOrchestrate ?? handleMergeOrchestrate;
  const readIntegrationHead =
    deps.readIntegrationHead ?? buildDefaultReadIntegrationHead(defaultGitExec);

  if (input.dryRun === true) {
    const integrationHead = readIntegrationHead(input);
    return {
      success: true,
      data: {
        dryRun: true,
        integrationRef: input.integrationRef,
        sourceBranch: input.sourceBranch,
        strategy: input.strategy,
        featureId: input.featureId,
        integrationHead,
        ...(input.taskId !== undefined ? { taskId: input.taskId } : {}),
        ...(input.repoRoot !== undefined ? { repoRoot: input.repoRoot } : {}),
      },
    };
  }

  const selfPid = deps.selfPid ?? process.pid;
  const selfStartedAt =
    deps.selfStartedAt ?? resolveSelfStartedAt(selfPid, processSource);

  const appender = ctx.eventStore.getAppender();
  const operationId = randomUUID();
  const timeoutMs = input.timeoutMs ?? DEFAULT_MERGE_SLOT_TIMEOUT_MS;
  const deadline = now() + timeoutMs;

  while (true) {
    const slot = await waitForFreeSlot({
      appender,
      input,
      deadline,
      now,
      sleep,
      pollIntervalMs,
      processTableSource,
    });
    if (!slot.free) {
      return mergeSlotTimeout(input, timeoutMs, slot.holder);
    }

    const claimed = await tryClaim(appender, input, operationId, selfPid, selfStartedAt);
    if (claimed) break;

    if (now() >= deadline) {
      return mergeSlotTimeout(input, timeoutMs, undefined);
    }
  }

  let terminalStatus: 'merged' | 'failed' = 'failed';
  try {
    const integrationHead = readIntegrationHead(input);
    const mergeResult = await mergeOrchestrate(
      {
        featureId: input.featureId,
        sourceBranch: input.sourceBranch,
        targetBranch: input.integrationRef,
        strategy: input.strategy,
        leaseOperationId: operationId,
        ...(input.taskId !== undefined ? { taskId: input.taskId } : {}),
        ...(input.repoRoot !== undefined ? { repoRoot: input.repoRoot } : {}),
      },
      ctx,
    );

    if (mergeResult.success) {
      terminalStatus = 'merged';
      return {
        ...mergeResult,
        data: {
          ...((mergeResult.data as Record<string, unknown> | undefined) ?? {}),
          serializedMerge: {
            integrationRef: input.integrationRef,
            operationId,
            integrationHead,
          },
        },
      };
    }
    return mergeResult;
  } finally {
    try {
      await appendMergeExecuted(
        appender,
        { integrationRef: input.integrationRef, operationId },
        { status: terminalStatus },
      );
    } catch {
    }
  }
}

interface WaitForFreeSlotArgs {
  readonly appender: AtomicAppender;
  readonly input: SerializeMergeInput;
  readonly deadline: number;
  readonly now: () => number;
  readonly sleep: SleepFn;
  readonly pollIntervalMs: number;
  readonly processTableSource: ProcessTableSource;
}

type WaitOutcome =
  | { readonly free: true }
  | { readonly free: false; readonly holder: InFlightMerge };

/**
 * Waits until `inFlightMerges[integrationRef]` is clear, and folds `worktrees@v1` again on each iteration.
 * It reclaims a provably dead holder with a release under the original holder `operationId`, so a crashed holder does not use the budget.
 * It waits on a live or unprovable holder until the deadline, then returns that holder.
 */
async function waitForFreeSlot(args: WaitForFreeSlotArgs): Promise<WaitOutcome> {
  const { appender, input, deadline, now, sleep, pollIntervalMs, processTableSource } = args;
  while (true) {
    const { aggregate } = await appender.aggregateStream<WorktreesProjection>(
      WORKTREES_STREAM,
      WORKTREES_REDUCER,
    );
    const holder = aggregate.inFlightMerges[input.integrationRef];
    if (holder === undefined) {
      return { free: true };
    }

    if (isHolderProvablyDead(holder, processTableSource)) {
      await appendMergeExecuted(
        appender,
        {
          integrationRef: holder.integrationRef,
          operationId: holder.operationId,
          worktreeId: holder.worktreeId,
        },
        { status: 'aborted', recoveryError: 'dead-holder-reclaimed' },
      );
      continue;
    }

    if (now() >= deadline) {
      return { free: false, holder };
    }
    await sleep(pollIntervalMs);
  }
}

/**
 * Resolves the create-time of the claiming process through the injected {@link ProcessSource}.
 * It returns `null` when the probe is not `present`. The claim is still valid, but it cannot detect PID reuse.
 * It never returns an empty string, because the `holderStartedAt` schema accepts only a non-empty string or `null`.
 */
function resolveSelfStartedAt(pid: number, source: ProcessSource): string | null {
  const probe = source.getStartTime(pid);
  return probe.status === 'present' ? probe.startedAt : null;
}

/** Outcome of a {@link reconcileMerges} pass. */
export interface ReconcileMergesResult {
  /** The refs whose lease this pass released, because the holder is provably dead. */
  readonly reconciled: readonly string[];
  /**
   * The refs left in flight: the holder is live, its liveness is unprovable, or its terminal append failed.
   * A failed append does not stop the pass, and a later pass tries it again.
   */
  readonly leftInFlight: readonly string[];
  /** Total in-flight merge leases probed this pass. */
  readonly probed: number;
}

/**
 * Releases every in-flight merge lease whose holder is provably dead, after a crash between claim and release.
 * It is the on-demand form of the inline reclaim in {@link waitForFreeSlot}. The `reconcile_worktrees` action calls it.
 *
 * It appends the terminal event under the original holder `operationId`, so a race with the inline reclaim makes one release.
 * It never runs the merge again, because the lease has no `featureId` or `strategy`. A new `serialize_merge` runs the merge.
 * The appends run in sequence, because they all go to the singleton `worktrees` stream.
 * On an unsupported process table, every holder reads `'unknown'` and nothing is released.
 */
export async function reconcileMerges(
  eventStore: EventStore,
  source: ProcessTableSource = defaultProcessTableSource,
): Promise<ReconcileMergesResult> {
  const appender = eventStore.getAppender();
  const { aggregate } = await appender.aggregateStream<WorktreesProjection>(
    WORKTREES_STREAM,
    WORKTREES_REDUCER,
  );
  const merges = Object.values(aggregate.inFlightMerges);

  const reconciled: string[] = [];
  const leftInFlight: string[] = [];
  for (const holder of merges) {
    if (!isHolderProvablyDead(holder, source)) {
      leftInFlight.push(holder.integrationRef);
      continue;
    }
    try {
      await appendMergeExecuted(
        appender,
        {
          integrationRef: holder.integrationRef,
          operationId: holder.operationId,
          worktreeId: holder.worktreeId,
        },
        { status: 'aborted', recoveryError: 'dead-holder-reclaimed' },
      );
      reconciled.push(holder.integrationRef);
    } catch {
      leftInFlight.push(holder.integrationRef);
    }
  }
  return { reconciled, leftInFlight, probed: merges.length };
}
