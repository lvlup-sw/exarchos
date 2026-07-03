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

import type { DispatchContext } from '../../core/dispatch.js';
import type { ToolResult } from '../../format.js';
import type { AtomicAppender } from '../../event-store/atomic-appender.js';
import { ConcurrencyError, StorageBusyError } from '../../event-store/index.js';
import { withStateRetry } from '../../workflow/state-retry.js';
import {
  handleMergeOrchestrate,
  type HandleMergeOrchestrateInput,
} from '../merge-orchestrate.js';
import { defaultGitExec } from '../git-exec-default.js';
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

// ─── Crash-mid-merge resume (DR-12) ──────────────────────────────────────────
//
// `serializeMerge`'s `finally` releases the lease, and its wait-for-slot loop
// reclaims a provably-DEAD holder inline (Task 006). Two edges remain on the
// recovery surface that the lease loop alone does NOT cover:
//
//   1. SAME-PROCESS stuck lease — the merge ran, but the best-effort RELEASE
//      append failed (the `finally` swallows it). The slot now reads as held by
//      a LIVE process (us), so the inline dead-holder probe will NOT reclaim it
//      and a fresh claimant waits out the full budget. This process can safely
//      finish its OWN lease.
//   2. A crashed holder whose slot is reclaimed through an explicit
//      reconcile/recovery pass rather than incidentally during another merge's
//      wait loop.
//
// `resumeCrashedMerge` handles both: it folds the unpaired CLAIM, confirms the
// lease is ours OR provably dead (never a different live merge), runs an
// IDEMPOTENT precheck against the integration ref (`git merge-base
// --is-ancestor <sourceBranch> <integrationRef>` — is the merge already
// applied?), and emits the terminal `worktree.merge_executed` EXACTLY ONCE
// (INV-8/13) under the holder's ORIGINAL `operationId`. The terminal is a keyed
// append, so a double resume — or a race with the inline reclaim — converges on
// one release. It NEVER `git reset --hard`s: a resumed merge composes
// `merge_orchestrate` UNCHANGED, whose own INV-14 reversal is `--abort` →
// `--keep`.

/** Caller-facing arguments for {@link resumeCrashedMerge}. */
export interface ResumeCrashedMergeInput {
  /** Owning feature workflow id — threaded UNCHANGED to a resumed `merge_orchestrate`. */
  readonly featureId: string;
  /** Integration ref whose unpaired lease to resume (the per-branch serialization key). */
  readonly integrationRef: string;
  /** Merge strategy for a resumed `merge_orchestrate`. */
  readonly strategy: 'squash' | 'rebase' | 'merge';
  /** Optional task id, threaded UNCHANGED to a resumed `merge_orchestrate`. */
  readonly taskId?: string;
  /** Optional repository root for the precheck + a resumed `merge_orchestrate`. */
  readonly repoRoot?: string;
}

/**
 * Injected seams for {@link resumeCrashedMerge} — every external effect (process
 * table, git ancestry probe, the composed merge) is reachable so the resume is
 * deterministically testable with zero OS / git access. Production omits every field.
 */
export interface ResumeCrashedMergeDeps {
  /** Process-table probe for dead-holder detection. Defaults to {@link defaultProcessTableSource}. */
  readonly processTableSource?: ProcessTableSource;
  /** Per-PID source for the resuming process's own create-time. Defaults to {@link defaultProcessSource}. */
  readonly processSource?: ProcessSource;
  /** PID of the resuming process (own-lease identity). Defaults to `process.pid`. */
  readonly selfPid?: number;
  /** Create-time fingerprint of the resuming process. Defaults to the resolved create-time of `selfPid`. */
  readonly selfStartedAt?: string;
  /** The merge COMPOSED UNCHANGED for a resume. Defaults to the real {@link handleMergeOrchestrate}. */
  readonly mergeOrchestrate?: (
    input: HandleMergeOrchestrateInput,
    ctx: DispatchContext,
  ) => Promise<ToolResult>;
  /**
   * Idempotent precheck: is `sourceBranch` already an ancestor of
   * `integrationRef` (the merge already applied)? Defaults to a
   * `git merge-base --is-ancestor` over {@link defaultGitExec}.
   */
  readonly isMergeApplied?: (
    input: ResumeCrashedMergeInput,
    sourceBranch: string,
  ) => boolean;
}

/** Outcome of a {@link resumeCrashedMerge} pass. */
export type ResumeCrashedMergeOutcome =
  /** No unpaired CLAIM for the ref (nothing to resume), OR a DIFFERENT live process owns it. */
  | { readonly resumed: false; readonly reason: 'no-lease' | 'foreign-live-holder' }
  /** A resume re-merge ran and FAILED — the lease is left intact (no terminal), the failure surfaced. */
  | {
      readonly resumed: false;
      readonly reason: 'resume-merge-failed';
      readonly operationId: string;
      readonly mergeResult: ToolResult;
    }
  /** The lease was terminated exactly once. `reMerged` ⇒ the precheck said "not applied" so the merge re-ran. */
  | {
      readonly resumed: true;
      readonly operationId: string;
      readonly reMerged: boolean;
      readonly holderKind: 'self' | 'dead';
      readonly mergeResult?: ToolResult;
    };

/** Default `git merge-base --is-ancestor <sourceBranch> <integrationRef>` precheck. */
function buildDefaultIsMergeApplied(
  gitExec: GitExec,
): (input: ResumeCrashedMergeInput, sourceBranch: string) => boolean {
  return (input, sourceBranch) => {
    const repoRoot = input.repoRoot ?? process.cwd();
    // exit 0 ⇒ sourceBranch is an ancestor of integrationRef (already merged).
    return (
      gitExec(repoRoot, [
        'merge-base',
        '--is-ancestor',
        sourceBranch,
        input.integrationRef,
      ]).exitCode === 0
    );
  };
}

/**
 * Re-claim a crash-interrupted merge lease under OCC so a RESUMED
 * `merge_orchestrate` runs AT MOST ONCE across concurrent recovery passes (DR-7
 * / DR-12 no-double-merge).
 *
 * The `resumeCrashedMerge` precheck (`isMergeApplied`) is a read-only git probe:
 * two concurrent resumes can BOTH observe "not applied" and BOTH re-run the
 * merge, double-applying it. This re-claim is the serialization point — the SAME
 * claim-inside-`decide` OCC the live `serializeMerge` path uses. It re-folds
 * `inFlightMerges` inside the closure and commits a re-claim ONLY when the slot
 * is STILL the lease being resumed (`operationId` unchanged) AND still
 * ours-or-provably-dead under the now-fail-closed liveness (an `'unknown'`
 * holder on an unsupported table is NOT reclaimable). The re-claim keeps the
 * holder's ORIGINAL `operationId` (so the eventual terminal still correlates via
 * the reducer's operationId guard) but stamps OUR LIVE identity, so a racing
 * resumer re-folds, sees a live foreign holder, and backs off.
 *
 * Returns `true` iff this call WON the slot; `false` (closure no-op, OCC
 * `ConcurrencyError`, or transient `StorageBusyError`) means a concurrent
 * claimant holds it — the caller MUST abort the resume rather than re-merge. We
 * never retry-and-steal: re-running the merge is the exact hazard guarded here.
 *
 * The `decide` idempotency key is a FRESH uuid (NOT the holder's operationId,
 * which already keys the original CLAIM via `serializeMerge`) so the re-claim is
 * a genuine new commit, never a cache-hit of the pre-crash claim.
 */
async function tryReclaimLeaseForResume(
  appender: AtomicAppender,
  holder: InFlightMerge,
  selfPid: number,
  selfStartedAt: string | null,
  processTableSource: ProcessTableSource,
): Promise<boolean> {
  try {
    const result = await appender.decide<WorktreesProjection>(
      WORKTREES_STREAM,
      WORKTREES_REDUCER,
      (state) => {
        const current = state.inFlightMerges[holder.integrationRef];
        // The lease vanished (a concurrent resume already terminated it) OR a
        // concurrent resumer re-claimed under a different lease — either way it
        // is no longer ours to take over.
        if (current === undefined || current.operationId !== holder.operationId) {
          return [];
        }
        // Re-verify against the FRESH fold (fail-closed): the slot is takeable
        // only when it is STILL us (a wedged self-release) or STILL provably
        // dead. A holder that became a live foreign process is left untouched.
        const stillSelf =
          current.holderPid === selfPid &&
          current.holderStartedAt !== null &&
          current.holderStartedAt !== '' &&
          current.holderStartedAt === selfStartedAt;
        const stillDead = isHolderProvablyDead(current, processTableSource);
        if (!stillSelf && !stillDead) {
          return [];
        }
        // Win the slot: re-claim the SAME lease (operationId unchanged) under OUR
        // live identity so a racing resumer re-folds and backs off as foreign-live.
        return [
          {
            type: 'worktree.merge_requested',
            data: {
              integrationRef: holder.integrationRef,
              operationId: holder.operationId,
              sourceBranch: holder.sourceBranch,
              holderPid: selfPid,
              holderStartedAt: selfStartedAt,
              ...(holder.worktreeId != null ? { worktreeId: holder.worktreeId } : {}),
            },
          },
        ];
      },
      { operationId: randomUUID(), alwaysEnforceConsistency: false },
    );
    // A cache-hit (the same keyed append already landed) is a WIN, same as a
    // fresh commit — only a no-op (the decide closure emitted nothing: lease
    // vanished or turned foreign-live) means we did not take the slot. Mirrors
    // tryClaim's `!== 'no-op'` check; `=== 'committed'` would wrongly fail on a
    // cache-hit (improbable under randomUUID, but a latent semantic inconsistency).
    return result.kind !== 'no-op';
  } catch (err) {
    // Lost the OCC (a concurrent resumer committed first) or transient substrate
    // contention — treat as "did not win" so the caller aborts the resume.
    if (err instanceof ConcurrencyError || err instanceof StorageBusyError) {
      return false;
    }
    throw err;
  }
}

/**
 * Resume a crash-interrupted serialized merge: an unpaired
 * `worktree.merge_requested` (CLAIM) on `integrationRef` with no
 * `worktree.merge_executed` (RELEASE), whose holder is THIS process or provably
 * dead. Idempotently terminates the lease exactly once — re-running
 * `merge_orchestrate` only when the precheck proves the merge was NOT applied
 * before the crash.
 *
 * Resolves to `{ resumed: false, reason: 'no-lease' }` when there is no lease to
 * resume (idempotent across repeated calls — once terminated, the next fold sees
 * an empty slot), and `{ resumed: false, reason: 'foreign-live-holder' }` when a
 * DIFFERENT live process still owns the merge (we never steal an active merge).
 */
export async function resumeCrashedMerge(
  input: ResumeCrashedMergeInput,
  ctx: DispatchContext,
  deps: ResumeCrashedMergeDeps = {},
): Promise<ResumeCrashedMergeOutcome> {
  const processTableSource = deps.processTableSource ?? defaultProcessTableSource;
  const processSource = deps.processSource ?? defaultProcessSource;
  const mergeOrchestrate = deps.mergeOrchestrate ?? handleMergeOrchestrate;
  const isMergeApplied = deps.isMergeApplied ?? buildDefaultIsMergeApplied(defaultGitExec);
  const selfPid = deps.selfPid ?? process.pid;
  const selfStartedAt =
    deps.selfStartedAt ?? resolveSelfStartedAt(selfPid, processSource);

  const appender = ctx.eventStore.getAppender();
  const { aggregate } = await appender.aggregateStream<WorktreesProjection>(
    WORKTREES_STREAM,
    WORKTREES_REDUCER,
  );
  const holder = aggregate.inFlightMerges[input.integrationRef];
  if (holder === undefined) {
    // No unpaired CLAIM for this ref — nothing to resume (idempotent: a prior
    // resume already terminated it, or the lease was never held).
    return { resumed: false, reason: 'no-lease' };
  }

  // Only terminate a lease we MAY safely finish: our OWN (a failed best-effort
  // release that wedged our slot — the holder is alive and is us) OR a provably
  // dead holder (a crashed process). A DIFFERENT LIVE holder owns an ACTIVE
  // merge; leave it untouched so we never steal a live merge's lease.
  const sameProcess =
    holder.holderPid === selfPid &&
    holder.holderStartedAt !== null &&
    holder.holderStartedAt !== '' &&
    holder.holderStartedAt === selfStartedAt;
  const dead = isHolderProvablyDead(holder, processTableSource);
  if (!sameProcess && !dead) {
    return { resumed: false, reason: 'foreign-live-holder' };
  }
  const holderKind: 'self' | 'dead' = sameProcess ? 'self' : 'dead';

  // Idempotent precheck: is the merge already applied to the integration ref?
  // `git merge-base --is-ancestor <sourceBranch> <integrationRef>` exit 0 ⇒ the
  // source tip is already contained → the pre-crash merge SUCCEEDED → skip the
  // re-merge and just release. Otherwise RESUME by re-running merge_orchestrate.
  let reMerged = false;
  let mergeResult: ToolResult | undefined;
  if (!isMergeApplied(input, holder.sourceBranch)) {
    // ─── OCC re-claim BEFORE the re-merge (DR-7 / DR-12 no-double-merge) ──
    // The `isMergeApplied` precheck is a read-only git probe — two concurrent
    // resumes can BOTH see "not applied" and BOTH re-run the merge. Serialize
    // the re-merge behind the SAME claim-inside-`decide` OCC `serializeMerge`
    // uses: only the resumer that WINS the re-claim re-runs `merge_orchestrate`;
    // a loser aborts rather than double-applying. (When the merge is ALREADY
    // applied no merge runs, so the keyed terminal alone is safe without a claim.)
    const reclaimed = await tryReclaimLeaseForResume(
      appender,
      holder,
      selfPid,
      selfStartedAt,
      processTableSource,
    );
    if (!reclaimed) {
      // A concurrent claimant holds the slot — never double-run the merge.
      return { resumed: false, reason: 'foreign-live-holder' };
    }
    mergeResult = await mergeOrchestrate(
      {
        featureId: input.featureId,
        sourceBranch: holder.sourceBranch,
        // `merge_orchestrate` calls the integration ref `targetBranch`.
        targetBranch: input.integrationRef,
        strategy: input.strategy,
        // Present the ORIGINAL claim's `operationId` (unchanged across the
        // re-claim, even from a NEW pid) so `merge_orchestrate`'s DR-2 guard
        // matches the resumed lease as ours and proceeds — the crash-resume
        // "match by operationId, not pid" contract.
        leaseOperationId: holder.operationId,
        ...(input.taskId !== undefined ? { taskId: input.taskId } : {}),
        ...(input.repoRoot !== undefined ? { repoRoot: input.repoRoot } : {}),
      },
      ctx,
    );
    reMerged = true;
    // A FAILED resume merge must NOT emit the terminal — leave the lease intact
    // so a later resume / dead-holder reclaim can retry, and surface the
    // failure. `merge_orchestrate`'s own INV-14 reversal has already rewound any
    // partial merge (`--abort` → `--keep`, never `--hard`), so nothing is
    // half-applied.
    if (!mergeResult.success) {
      return {
        resumed: false,
        reason: 'resume-merge-failed',
        operationId: holder.operationId,
        mergeResult,
      };
    }
  }

  // Emit the terminal EXACTLY ONCE under the holder's ORIGINAL operationId. The
  // keyed append (`worktree.merge_executed:<operationId>`) dedups, so a double
  // resume — or a race with the inline dead-holder reclaim — converges on ONE
  // release (INV-8/13); the reducer's operationId guard correlates it to exactly
  // the CLAIM it terminates.
  // Reached only when the merge succeeded or was already applied (a failed
  // resume returns early WITHOUT emitting) → the terminal status is 'merged'.
  await appendMergeExecuted(
    appender,
    {
      integrationRef: holder.integrationRef,
      operationId: holder.operationId,
      worktreeId: holder.worktreeId,
    },
    { status: 'merged' },
  );
  return {
    resumed: true,
    operationId: holder.operationId,
    reMerged,
    holderKind,
    ...(mergeResult !== undefined ? { mergeResult } : {}),
  };
}
