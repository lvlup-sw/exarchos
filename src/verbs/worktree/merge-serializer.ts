// ─── Integration-branch merge serializer (WLM operational core, DR-7) ────────
//
// `serialize_merge` is an OPTIMISTIC LEASE over the integration ref: it grants
// at most ONE in-flight merge per `integrationRef` at a time, then composes
// `merge_orchestrate` UNCHANGED for the actual git work. The lease itself IS the
// serialization — there is NO flock, NO PID/`.lock` file, and NO advisory-lock
// library (INV-1/INV-7): the right to merge lives EXCLUSIVELY in the event log,
// folded by `worktrees@v1` into `inFlightMerges[integrationRef]`.
//
// The lease lifecycle is a two-event pair on the singleton `worktrees` stream
// (DR-4), exactly mirroring the single-writer `reserve` pattern in `manager.ts`:
//
//   1. CLAIM (`worktree.merge_requested`) — committed through `decide` over
//      `worktrees@v1` under `withStateRetry`. The slot-emptiness check lives
//      INSIDE the decide closure so the OCC commit is gated on the exact folded
//      tail: a racing claimant loses with `ConcurrencyError`, re-folds, sees the
//      holder, and falls back to waiting. At most one claimant wins per ref.
//
//   2. RELEASE (`worktree.merge_executed`) — a PLAIN keyed append
//      (`worktree.merge_executed:<operationId>`), NOT CAS-pinned to the claim's
//      returned sequence. Other worktree events advance the stream while the
//      merge runs, so pinning the release to the claim seq would be the
//      idempotency trap that wedges every retry forever.
//
// Bounded-wait: when the slot is held, the lease waits under an explicit timeout
// using the SHARED injected `sleep` seam from `git-retry.ts`, re-folding each
// iteration. On expiry it returns a structured `merge-slot-timeout` error rather
// than hanging. Each wait iteration probes the CURRENT holder's liveness via the
// DR-5 process probe (`pure/probe.ts`): a holder whose `holderPid` /
// `holderStartedAt` is provably dead is reclaimed inline — the lease emits the
// terminal `worktree.merge_executed` ONCE under the holder's ORIGINAL
// `operationId` — so a crashed holder never wastes the full timeout budget.
// ─────────────────────────────────────────────────────────────────────────────

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
// WORKTREES_STREAM / WORKTREES_REDUCER are the singleton-stream + reducer ids
// the manager's `reserve` writes through; importing them keeps the serializer
// on the SAME stream and fold (and pulls in the DR-1 reducer self-registration).
import { WORKTREES_STREAM, WORKTREES_REDUCER } from './manager.js';
// Side-effect import: ensures the `worktrees@v1` reducer is registered with the
// process-wide `defaultRegistry` so `decide` / `aggregateStream` can resolve it.
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

// ─── Tuning ──────────────────────────────────────────────────────────────────

/** Default bounded-wait budget (ms) before a held slot yields `merge-slot-timeout`. */
export const DEFAULT_MERGE_SLOT_TIMEOUT_MS = 30_000;

/** Default poll interval (ms) between wait-for-slot re-folds. */
export const DEFAULT_MERGE_SLOT_POLL_INTERVAL_MS = 200;

// ─── Public input / dependency shapes ────────────────────────────────────────

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
   * DR-1 / INV-5c safe default: when `true` (the DEFAULT — see
   * {@link handleSerializeMerge}), the serializer claims NO lease and runs NO
   * merge; it reads the fresh integration head and returns the PLANNED effect.
   * Only `false` claims the `worktree.merge_requested` lease and composes the
   * real `merge_orchestrate`. Undefined here is treated as an apply run because
   * the safe default is applied at the handler boundary (the dispatch seam),
   * NOT the pure serializer — a direct in-process caller that omits `dryRun`
   * has already made its intent explicit by calling `serializeMerge` directly.
   */
  readonly dryRun?: boolean;
}

/**
 * Injected seams — every external effect (timing, process table, git, the
 * composed merge) is reachable here so the lease is deterministically testable
 * with zero OS / git access. Production callers omit every field.
 */
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

// ─── Default fresh-HEAD reader ───────────────────────────────────────────────

function buildDefaultReadIntegrationHead(gitExec: GitExec): (input: SerializeMergeInput) => string | null {
  return (input) => {
    const repoRoot = input.repoRoot ?? process.cwd();
    const result = gitExec(repoRoot, ['rev-parse', '--verify', input.integrationRef]);
    if (result.exitCode !== 0) return null;
    const sha = result.stdout.trim();
    return sha.length > 0 ? sha : null;
  };
}

// ─── Holder liveness (DR-5 probe reuse) ──────────────────────────────────────

/**
 * Is the current lease holder provably dead? Routes the holder's recorded
 * `holderPid` / `holderStartedAt` through the DR-5 {@link probeReservations}
 * probe — the SAME ground-truth liveness lens the manager uses for reservation
 * reaping. A holder with a null pid/create-time cannot be proven dead (the lease
 * pre-dates a holder fingerprint), so it is held, not reclaimed. Provably dead
 * means PID absent from a SUPPORTED process table OR present-with-mismatched
 * create-time (PID reuse). On an UNSUPPORTED table (off-Linux, no enumerator)
 * the probe yields `'unknown'` → `releasable === false`, so this returns `false`
 * and the holder is HELD, never reclaimed — fail closed (DR-7): the off-Linux
 * path must never steal a live holder's merge lease.
 */
function isHolderProvablyDead(
  holder: InFlightMerge,
  source: ProcessTableSource,
): boolean {
  if (holder.holderPid === null || holder.holderStartedAt === null) {
    return false; // no fingerprint to probe → fail closed (do not reclaim).
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

// ─── Lease appends (CLAIM / RELEASE / dead-holder reclaim) ───────────────────

/**
 * Terminal `worktree.merge_executed` as a PLAIN keyed append — keyed by
 * `<eventType>:<operationId>` for idempotency, but NOT CAS-pinned to any prior
 * sequence. Used for BOTH the normal release (caller's own `operationId`) and
 * dead-holder reclamation (the holder's ORIGINAL `operationId`), so two racing
 * reclaimers converge on ONE release and the reducer's `operationId` guard
 * correlates the release to exactly the claim it terminates.
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
        // Schema-conformant payload (WorktreeMergeExecutedData): `status` is
        // REQUIRED; `sourceBranch` is NOT part of the release contract (it lives
        // on the CLAIM) and the reducer correlates by integrationRef+operationId.
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
    // NOTE: no `options.expectedSequence` — a plain keyed append. The stream
    // advances (other worktree events) between CLAIM and RELEASE, so pinning to
    // the claim seq would wedge every retry forever (the idempotency trap).
  );
}

/**
 * Attempt the CLAIM under OCC. Returns `true` iff this call committed the
 * `worktree.merge_requested` event (won the slot). The slot-emptiness check is
 * INSIDE the decide closure, so the commit is gated on the exact folded tail: a
 * racing claimant loses the OCC commit, `withStateRetry` re-folds, the closure
 * now sees the holder and emits nothing (no-op). On persistent contention the
 * typed OCC/storage errors surface; the caller treats them as "not claimed" and
 * re-enters the wait loop.
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
          // Re-check slot emptiness INSIDE the closure (mirrors `reserve`). A
          // holder present in THIS fold means a concurrent winner already
          // claimed → emit nothing so the loser re-waits rather than double-claims.
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
        // alwaysEnforceConsistency=false: a no-op (slot already held) must NOT
        // throw on an unrelated concurrent worktree append; the emit path still
        // commits under expectedSequence OCC — the single-writer guard.
        { operationId, alwaysEnforceConsistency: false },
      );
      claimed = result.kind !== 'no-op';
    });
  } catch (err) {
    // Persistent OCC / substrate contention after the retry budget — treat as
    // "did not claim" and let the outer loop re-fold + wait (respecting the
    // deadline). Any other error is a genuine fault and propagates.
    if (err instanceof ConcurrencyError || err instanceof StorageBusyError) {
      return false;
    }
    throw err;
  }
  return claimed;
}

// ─── Structured timeout ──────────────────────────────────────────────────────

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
    // Structured payload rides `data` (the error envelope has a fixed field
    // set); `reason` is the stable kebab discriminator callers match on.
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

// ─── The lease ───────────────────────────────────────────────────────────────

/**
 * Serialize a `sourceBranch → integrationRef` merge behind a single-writer
 * optimistic lease, then compose `merge_orchestrate` UNCHANGED. Returns the
 * merge result (pass-through, annotated with the lease metadata) on success, or
 * a structured `merge-slot-timeout` error if the slot stays held by a live
 * process past the bounded-wait budget.
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

  // ─── DR-1 / INV-5c dry-run short-circuit ──────────────────────────────────
  //
  // On a dry-run (`input.dryRun === true`) the lease is NOT claimed and
  // `merge_orchestrate` is NOT run: append NO `worktree.merge_requested` /
  // `worktree.merge_executed` events, and return the PLANNED effect instead —
  // the merge params plus the freshly-read integration head. The head read is a
  // pure `git rev-parse` (read-only, `null` on any failure), so a dry-run stays
  // side-effect-free on the event log. The dispatch boundary
  // (`handleSerializeMerge`) makes dry-run the DEFAULT; a direct caller passes
  // `dryRun: false` (or leaves it undefined) to execute.
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

  // ─── 1+2. Wait for a free slot, then CLAIM it (loop until won or timeout) ──
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

    // Lost the claim race (a concurrent winner took the slot) — re-enter the
    // wait loop so we block on the new holder, unless the budget is spent.
    if (now() >= deadline) {
      return mergeSlotTimeout(input, timeoutMs, undefined);
    }
  }

  // ─── 3+4. Re-read fresh integration HEAD, then compose merge_orchestrate ──
  //
  // We hold the lease. RELEASE in `finally` so a thrown / failed merge never
  // wedges the slot (the dead-holder reclaim is only a crash safety net).
  // `terminalStatus` records the truthful release disposition; it stays 'failed'
  // if the merge throws (the honest terminal for a wedged-then-reclaimed slot).
  let terminalStatus: 'merged' | 'failed' = 'failed';
  try {
    const integrationHead = readIntegrationHead(input);
    const mergeResult = await mergeOrchestrate(
      {
        featureId: input.featureId,
        sourceBranch: input.sourceBranch,
        // `merge_orchestrate` calls the integration ref `targetBranch`.
        targetBranch: input.integrationRef,
        strategy: input.strategy,
        // Thread OUR lease `operationId` so `merge_orchestrate`'s DR-2
        // single-writer guard recognizes the folded lease as ours (matched by
        // operationId) and proceeds, instead of treating our own just-claimed
        // live lease as a foreign holder and failing closed.
        leaseOperationId: operationId,
        ...(input.taskId !== undefined ? { taskId: input.taskId } : {}),
        ...(input.repoRoot !== undefined ? { repoRoot: input.repoRoot } : {}),
      },
      ctx,
    );

    // Pass the merge result through UNCHANGED in shape; annotate ONLY the
    // serializer's own lease metadata under a dedicated key so the composed
    // per-featureId `merge.*` events are byte-identical to a direct call.
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
    // ─── 5. RELEASE — plain keyed append (NOT CAS-pinned to the claim seq) ──
    // Best-effort: a failed release leaves a stuck slot the dead-holder
    // reclaim path clears once this process exits; surfacing it here would
    // mask the merge's own result/error.
    try {
      await appendMergeExecuted(
        appender,
        { integrationRef: input.integrationRef, operationId },
        { status: terminalStatus },
      );
    } catch {
      /* best-effort release — see note above */
    }
  }
}

// ─── Wait-for-slot (with inline dead-holder reclamation) ─────────────────────

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
 * Block until `inFlightMerges[integrationRef]` is clear, re-folding the
 * `worktrees@v1` projection each iteration. A provably-dead holder is reclaimed
 * inline (emit the terminal release under the holder's ORIGINAL operationId) and
 * the loop re-folds — so a crashed holder is freed without waiting out the
 * budget. A live (or unprovable) holder is waited on via the injected `sleep`
 * seam until the deadline, then surfaced for a structured timeout.
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

    // Dead-holder reclamation: probe the CURRENT holder's liveness and, if
    // provably gone, emit its terminal release under its OWN operationId, then
    // re-fold (the slot should now be clear).
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

    // Live / unprovable holder — wait under the deadline.
    if (now() >= deadline) {
      return { free: false, holder };
    }
    await sleep(pollIntervalMs);
  }
}

// ─── Self create-time resolution ─────────────────────────────────────────────

/**
 * Resolve the claiming process's create-time fingerprint via the injected
 * {@link ProcessSource}. A platform that cannot resolve it yields `null` — still
 * a well-formed claim; it just cannot defeat PID reuse for dead-holder probing.
 * Modeled as `null` (not `''`) so the emitted `holderStartedAt` stays schema-
 * valid (`z.string().min(1).nullable()`) rather than an out-of-contract empty
 * string that only the projection defensively normalized.
 */
function resolveSelfStartedAt(pid: number, source: ProcessSource): string | null {
  const probe = source.getStartTime(pid);
  return probe.status === 'present' ? probe.startedAt : null;
}

// ─── Crash-mid-merge recovery (DR-3): free a stranded dead-holder lease ───────
//
// A crash between the CLAIM (`worktree.merge_requested`) and the RELEASE
// (`worktree.merge_executed`) leaves an unpaired lease on `integrationRef`. Two
// production paths recover it — BOTH by freeing the dead slot (never by re-running
// the crashed caller's merge: the caller is gone, and the `worktrees@v1`
// {@link InFlightMerge} projection carries no `featureId`/`strategy`, so a re-merge
// could not even be correctly attributed. The WLM re-drives an interrupted merge
// the honest way — the orchestrator re-dispatches, which is a FRESH
// `serialize_merge` on the ref that runs its own correctly-attributed merge):
//
//   1. INLINE, incidental — the next `serialize_merge` on the ref hits the
//      dead-holder reclaim in {@link waitForFreeSlot}, freeing the slot before it
//      claims (Task 006).
//   2. EXPLICIT, on-demand — {@link reconcileMerges} folds EVERY in-flight lease
//      and frees each provably-dead one, WITHOUT needing a subsequent merge. It is
//      wired into the `ps --probe` reconcile pass (`handleViewPs`) alongside the
//      reservation reconciler ({@link WorktreeManager.probeAndReclaim}) and the
//      launch reconciler (`reconcileLaunches`) — the merge-lease third member of
//      that trio, so a crashed lease can never fold as a permanent `ps` phantom.
//
// A prior standalone `resumeCrashedMerge` export lived here with zero production
// callers and re-ran the crashed merge under the caller's `featureId`; it was
// excised (WLM slice 3, DR-3) in favor of these two slot-freeing paths — the sound
// and sufficient recovery.

/** Outcome of a {@link reconcileMerges} pass (DR-3). */
export interface ReconcileMergesResult {
  /**
   * The `integrationRef`s whose stranded lease was reclaimed to a terminal
   * `worktree.merge_executed` this pass (holder provably dead). Empty when no
   * lease needed freeing.
   */
  readonly reconciled: readonly string[];
  /**
   * The `integrationRef`s left in-flight — the holder is live, its liveness is
   * unprovable (`'unknown'` / unsupported table), OR its terminal append failed
   * this pass (isolated so it does not sink the others; a later pass retries it).
   * Fail closed: a live holder's active merge is never reclaimed away.
   */
  readonly leftInFlight: readonly string[];
  /** Total in-flight merge leases probed this pass. */
  readonly probed: number;
}

/**
 * Reconcile every stranded in-flight merge lease whose holder is provably dead to
 * a terminal `worktree.merge_executed` (DR-3) — the EXPLICIT on-demand counterpart
 * of the inline dead-holder reclaim in {@link waitForFreeSlot}, and the merge-lease
 * sibling of {@link WorktreeManager.probeAndReclaim} (reservations) and
 * `reconcileLaunches` (launches). Folds the `worktrees@v1` projection, probes each
 * holder through the SAME DR-5 liveness lens {@link isHolderProvablyDead} uses, and
 * for each provably-dead holder emits the terminal under its OWN `operationId` (a
 * keyed append, so a race with the inline reclaim converges on ONE release,
 * INV-8/13). Never re-runs the merge — freeing the slot for the next live claimant
 * is the recovery.
 *
 * On-demand only: registers NO timer / daemon — a single pure fold plus a
 * point-in-time process-table read. Idempotent across runs (once terminated the
 * lease is no longer in-flight). `source` is injected so the pass is testable with
 * a fake process table and zero OS access; it defaults to the real
 * {@link defaultProcessTableSource} (off-Linux `isSupported() === false` → every
 * holder reads `'unknown'` and NOTHING is reconciled: fail closed, DR-7/REV-H1).
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
    // Provably dead → the terminal will never be written by the crashed holder;
    // emit it under the holder's ORIGINAL operationId (identical to the inline
    // reclaim's release: status 'aborted', `dead-holder-reclaimed`). Isolate
    // per-holder failure — a single append that retries out must NOT sink the
    // pass; the failed ref is reported left-in-flight so a later pass retries it
    // (the keyed terminal is idempotent, so a retry is safe). Kept SEQUENTIAL:
    // every append lands on the singleton `worktrees` stream, whose in-process
    // StreamLockManager already serializes same-stream appends (INV-7).
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
