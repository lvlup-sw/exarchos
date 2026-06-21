// ─── handleExecuteMerge — orchestrate handler (T15, DR-MO-2) ───────────────
//
// Wraps the pure `executeMerge` (T08+T09+T10) with:
//   • a local-git merge adapter via `buildLocalGitMergeAdapter` (#1194 —
//     replaced the previous remote VcsProvider call so the recorded
//     rollbackSha actually corresponds to a local ref the executor's
//     INV-14 rollback (`git reset --keep`) can undo)
//   • a `gitExec` adapter using `execFileSync` (120s timeout, matches
//     post-merge.ts:48)
//   • a `persistState` callback that updates the workflow state's
//     `mergeOrchestrator` field (T01+T02 schema)
//   • on `phase: 'completed'`, emits `merge.executed` to the workflow's
//     event stream (stream id = featureId) carrying both the post-merge
//     `mergeSha` and the pre-merge `rollbackSha`
//
// The merge adapter is injectable via `args.vcsMerge` so tests bypass real
// git operations. Same for `gitExec` and `persistState`. In production,
// the composite dispatcher (T20) constructs the defaults from `ctx.stateDir`
// and the working tree.
//
// T16 extends this with the `phase: 'rolled-back'` branch: the pure executor
// has already run the INV-14 recovery ladder (`git merge --abort` →
// `git reset --keep <rollbackSha>`), so the handler emits a
// `merge.rollback` event (categorized reason: 'merge-failed' |
// 'verification-failed' | 'timeout') and returns a structured error.
// ───────────────────────────────────────────────────────────────────────────

import { defaultGitExec } from './git-exec-default.js';
import * as path from 'node:path';
import { z } from 'zod';

import type { ToolResult } from '../format.js';
import type { DispatchContext } from '../core/dispatch.js';
import { executeMerge, type GitExec, type MergeStrategy } from './pure/execute-merge.js';
import { buildLocalGitMergeAdapter } from './local-git-merge.js';
import { buildMergeOrchestrateIdempotencyKey } from './merge-keys.js';
import { SequenceConflictError } from '../event-store/store.js';
import {
  readStateFile,
  writeStateFile,
  VersionConflictError,
  StateStoreError,
} from '../workflow/state-store.js';
import { ErrorCode } from '../workflow/schemas.js';
import {
  withStateRetry,
  MAX_STATE_RETRIES,
} from '../workflow/state-retry.js';
import {
  ConcurrencyError,
  StorageBusyError,
} from '../event-store/index.js';
import type { MergeOrchestratorState } from '../projections/merge-orchestrator/index.js';
// Side-effect import — registers `merge-orchestrator@v1` with `defaultRegistry`
// so the Wave 3 primitive (`AtomicAppender.decide`) can resolve the reducer
// by id at Phase A (`merge.requested`) commit time.
import '../projections/merge-orchestrator/index.js';

// ─── Args schema ───────────────────────────────────────────────────────────

export const HandleExecuteMergeArgsSchema = z.object({
  featureId: z.string().min(1),
  sourceBranch: z.string().min(1),
  targetBranch: z.string().min(1),
  taskId: z.string().optional(),
  strategy: z.enum(['squash', 'rebase', 'merge']),
  repoRoot: z.string().optional(),
});

export type HandleExecuteMergeArgs = z.infer<typeof HandleExecuteMergeArgsSchema>;

// ─── Internal types for DI overrides (tests use these) ─────────────────────

interface VcsMergeAdapter {
  (args: {
    sourceBranch: string;
    targetBranch: string;
    strategy: MergeStrategy;
  }): Promise<{ mergeSha: string }>;
}

/**
 * Discriminated union over the three phase transitions the executor writes:
 *   • `executing`   — intermediate, BEFORE vcsMerge (T09)
 *   • `completed`   — terminal success, AFTER vcsMerge resolves (T27)
 *   • `rolled-back` — terminal failure, AFTER the INV-14 recovery ladder (T27)
 *
 * The terminal-phase shapes carry the result-specific fields (`mergeSha` /
 * `reason`) so a state file is self-describing without re-fetching the event
 * stream. Without these terminal writes, disk state would stay at
 * 'executing' indefinitely after a merge completes or rolls back, breaking
 * HSM exit guards and resume semantics.
 */
export type ExecutorPersistStatePayload =
  | { phase: 'executing'; rollbackSha: string }
  | { phase: 'completed'; rollbackSha: string; mergeSha: string }
  | {
      phase: 'rolled-back';
      rollbackSha: string;
      reason: 'merge-failed' | 'verification-failed' | 'timeout';
      /** INV-14 recovery-outcome discriminator; absent on a clean rollback. */
      recoveryError?: 'reset-keep-blocked' | 'reset-failed' | 'unexpected-mid-merge-drift';
      /** Human-readable detail for `recoveryError`; absent on clean rollback. */
      rollbackError?: string;
    };

interface PersistStateCallback {
  (state: ExecutorPersistStatePayload): Promise<void> | void;
}

// Internal handler signature accepts the public args plus optional DI hooks.
// The Zod schema above only validates externally-supplied fields; the DI
// hooks are TypeScript-only (callers pass them in-process, never over the
// wire).
export interface HandleExecuteMergeInput extends HandleExecuteMergeArgs {
  readonly vcsMerge?: VcsMergeAdapter;
  readonly gitExec?: GitExec;
  readonly persistState?: PersistStateCallback;
}

// ─── Default adapters ──────────────────────────────────────────────────────


/**
 * Build the default `vcsMerge` adapter — a *local* `git merge` of source
 * into target. See `local-git-merge.ts` for the full contract; the executor
 * uses this adapter so the recorded `rollbackSha` actually corresponds to
 * a local ref the rollback `git reset --keep` can undo (#1194).
 */
function buildDefaultVcsMerge(
  input: HandleExecuteMergeInput,
  gitExec: GitExec,
): VcsMergeAdapter {
  return buildLocalGitMergeAdapter(gitExec, input.repoRoot ?? process.cwd());
}

/**
 * Build the default `persistState` callback. Reads the workflow state file
 * at `<stateDir>/<featureId>.state.json`, merges the supplied phase payload
 * into `mergeOrchestrator`, and writes back atomically.
 *
 * Shallow-merges (rather than replacing) the existing `mergeOrchestrator`
 * block so terminal-phase fields like `mergeSha` and `reason` ride alongside
 * the always-present `phase` + `rollbackSha`. This is intentionally
 * different from `merge-orchestrate.ts`'s `buildDefaultPersistState`, which
 * REPLACES the block on `aborted`: the executor progresses through
 * `executing` → `completed`/`rolled-back`, so merging preserves
 * `sourceBranch`/`targetBranch`/`taskId` written during `executing`. The
 * orchestrator's abort writes a fresh terminal record with no intermediate,
 * so replacement there prevents stale fields from a prior attempt.
 *
 * STATE_NOT_FOUND is treated as "first write" so a missing state file
 * (extremely rare in practice — workflow.started writes it — but possible
 * after a manual delete) does not crash the executor.
 */
function buildDefaultPersistState(
  featureId: string,
  sourceBranch: string,
  targetBranch: string,
  taskId: string | undefined,
  stateDir: string,
): PersistStateCallback {
  return async (payload) => {
    const stateFile = path.join(stateDir, `${featureId}.state.json`);
    // Let `StateStoreError(STATE_NOT_FOUND)` propagate — the executor's
    // terminal event was already appended (event-first commit point), so
    // a missing state file is a recovery scenario the caller must handle,
    // not something to paper over with an invented baseline. Faking state
    // here would land an incomplete record on disk and trip write-time
    // schema validation anyway.
    const state = await readStateFile(stateFile);
    // Capture CAS version before mutation so the write enforces optimistic
    // concurrency. Without `expectedVersion`, `writeStateFile` skips the
    // CAS check entirely, defeating the surrounding `withStateRetry`.
    const expectedVersion = (state as Record<string, unknown>)._version as number | undefined ?? 1;
    const next = {
      ...state,
      mergeOrchestrator: {
        ...((state as Record<string, unknown>).mergeOrchestrator as Record<string, unknown> | undefined),
        sourceBranch,
        targetBranch,
        ...(taskId !== undefined ? { taskId } : {}),
        ...payload,
      },
    };
    await writeStateFile(stateFile, next as typeof state, { expectedVersion });
  };
}

// ─── Handler ───────────────────────────────────────────────────────────────

export async function handleExecuteMerge(
  input: HandleExecuteMergeInput,
  ctx: DispatchContext,
): Promise<ToolResult> {
  // Validate the externally-supplied args (DI hooks bypass the schema).
  const parsed = HandleExecuteMergeArgsSchema.safeParse({
    featureId: input.featureId,
    sourceBranch: input.sourceBranch,
    targetBranch: input.targetBranch,
    taskId: input.taskId,
    strategy: input.strategy,
    repoRoot: input.repoRoot,
  });
  if (!parsed.success) {
    return {
      success: false,
      error: {
        code: 'INVALID_INPUT',
        message: `handleExecuteMerge: ${parsed.error.message}`,
      },
    };
  }
  const args = parsed.data;

  const gitExec = input.gitExec ?? defaultGitExec;
  const vcsMerge = input.vcsMerge ?? buildDefaultVcsMerge(input, gitExec);
  const rawPersistState =
    input.persistState ??
    buildDefaultPersistState(
      args.featureId,
      args.sourceBranch,
      args.targetBranch,
      args.taskId,
      ctx.stateDir,
    );

  // T29: wrap every state write in `withStateRetry` so concurrent writers
  // (e.g. another orchestrate handler updating the same workflow state file)
  // don't fail this merge permanently on a single CAS conflict. Wraps both
  // injected and default `persistState` so caller-supplied hooks share the
  // same race-tolerance contract.
  const persistState: PersistStateCallback = async (state) => {
    await withStateRetry(async () => {
      await rawPersistState(state);
    });
  };

  // ─── Phase A — durable INTENT (Wave 4 / audit §F1.2) ─────────────────────
  //
  // Commit `merge.requested` PURELY under `withStateRetry` BEFORE the
  // executor's `vcsMerge` side effect fires. The decide closure
  // short-circuits idempotently when the merge-orchestrator projection
  // already shows `requested` / `executed` / `recovering` / `completed`
  // — covers both (a) replays of this same invocation under OCC retries,
  // and (b) the orchestrator-already-emitted case (when `handleExecuteMerge`
  // is invoked via `handleMergeOrchestrate` the orchestrator's own Phase A
  // has already landed `merge.requested`; the executor sees
  // `state.phase === 'requested'` and emits nothing).
  //
  // When invoked DIRECTLY (e.g., CLI `exarchos execute-merge`), no
  // upstream orchestrator emitted the intent; this Phase A is the FIRST
  // `merge.requested` for the stream.
  //
  // `vcsMerge` runs OUTSIDE this retry boundary so an OCC loss inside
  // `decide` never re-fires the local git merge — the canonical
  // process-manager anti-pattern guard from audit §F1.2.
  const requestedOperationId =
    args.taskId !== undefined
      ? `merge-requested:${args.featureId}:${args.taskId}`
      : `merge-requested:${args.featureId}`;
  const appender = ctx.eventStore.getAppender();
  try {
    await withStateRetry(() =>
      appender.decide<MergeOrchestratorState>(
        args.featureId,
        'merge-orchestrator@v1',
        (state) => {
          if (
            state.phase === 'requested' ||
            state.phase === 'executed' ||
            state.phase === 'recovering' ||
            state.phase === 'completed'
          ) {
            return [];
          }
          return [
            {
              type: 'merge.requested',
              data: {
                sourceBranch: args.sourceBranch,
                targetBranch: args.targetBranch,
                strategy: args.strategy,
                ...(args.taskId !== undefined ? { taskId: args.taskId } : {}),
                featureId: args.featureId,
              },
              correlationId: requestedOperationId,
            },
          ];
        },
        // alwaysEnforceConsistency=false: the no-op branches above (state
        // already requested/executed/recovering/completed) intentionally
        // emit zero events. With the default-on tail re-read, a concurrent
        // merge.executed landing between the read and our empty return
        // would throw spurious ConcurrencyError on a path whose only job
        // was to confirm "already done". Disabling the empty-write check
        // makes the idempotent-recovery path safe under contention; the
        // event-emitting branch is unaffected because it actually appends.
        // Sentry #14058535/0.
        { operationId: requestedOperationId, alwaysEnforceConsistency: false },
      ),
    );
  } catch (err) {
    if (err instanceof ConcurrencyError) {
      return {
        success: false,
        error: {
          code: 'CONCURRENCY_CONFLICT',
          message: `merge.requested decide lost OCC race after ${MAX_STATE_RETRIES} retries: ${err.message}`,
        },
      };
    }
    if (err instanceof StorageBusyError) {
      return {
        success: false,
        error: {
          code: 'STORAGE_BUSY',
          message: `merge.requested decide hit storage contention after ${MAX_STATE_RETRIES} retries: ${err.message}`,
        },
      };
    }
    throw err;
  }

  let result;
  try {
    result = await executeMerge({
      sourceBranch: args.sourceBranch,
      targetBranch: args.targetBranch,
      strategy: args.strategy as MergeStrategy,
      gitExec,
      vcsMerge,
      persistState,
      ...(args.repoRoot !== undefined ? { repoRoot: args.repoRoot } : {}),
    });
  } catch (err) {
    // T29: optimistic-concurrency exhaustion → structured STATE_CONFLICT
    // ToolResult so callers see a categorized failure (not a raw exception).
    if (err instanceof VersionConflictError) {
      return {
        success: false,
        error: {
          code: 'STATE_CONFLICT',
          message: `Workflow state version conflict after ${MAX_STATE_RETRIES} retries: ${err.message}`,
        },
      };
    }
    // Persisting the intermediate `executing` phase touches the state file;
    // a missing/corrupt file there must surface as a categorized failure
    // rather than masquerading as MERGE_FAILED.
    if (err instanceof StateStoreError) {
      return {
        success: false,
        error: {
          code: err.code === ErrorCode.STATE_NOT_FOUND ? 'STATE_READ_FAILED' : err.code,
          message: err.message,
        },
      };
    }
    return {
      success: false,
      error: {
        code: 'MERGE_FAILED',
        message: err instanceof Error ? err.message : String(err),
      },
    };
  }

  // Event-first commit point (#1109 §1): append the terminal event BEFORE
  // mutating the state file. If append fails, the state file stays at
  // `executing` and a subsequent reconcile/projection rebuild reflects only
  // what the event store recorded — no silent state/event divergence. If
  // the state write fails after a successful append, projection replay
  // still reconstructs the terminal phase from the recorded event.
  if (result.phase === 'completed') {
    // Direct stream append — NOT wrapped in `gate.executed`. The dedicated
    // `merge.executed` schema (T03) lives at the top level so observability
    // and HSM guards can match on it directly.
    //
    // #1303 — pass `idempotencyKey` (when taskId is present) and
    // `expectedSequence` (CAS on the stream high-water mark) so the
    // substrate guarantees added in #1259 / #1323 reach this surface:
    //
    //   • idempotency-key dedup makes crash-replay safe — a retry after a
    //     mid-handler crash returns the original cached event rather than
    //     appending a duplicate `merge.executed`.
    //   • `expectedSequence` enforces optimistic concurrency at the
    //     append-transaction level — two concurrent invocations against
    //     the same stream cannot land overlapping sequences.
    //
    // The key shape `${streamId}:merge_orchestrate:${taskId}:${eventType}`
    // matches the prefix produced by `next-actions-computer.ts` for the
    // `merge_orchestrate` verb (extending it with the event-type segment so
    // the three append sites in this orchestrator surface — preflight,
    // executed, rollback — each have a distinct dedup key).
    const tailEventsExecuted = await ctx.eventStore.query(args.featureId);
    const expectedSequenceExecuted =
      tailEventsExecuted.length > 0
        ? Math.max(...tailEventsExecuted.map((e) => e.sequence))
        : 0;
    // INV-8: always set an idempotency key so concurrent invocations
    // without a `taskId` (e.g., CLI direct-invocation) dedup at the
    // substrate's idempotency_claims row rather than racing to append.
    // The helper falls back to a `featureId`-only key when `taskId` is
    // absent.
    const appendOptionsExecuted: { idempotencyKey: string; expectedSequence: number } = {
      expectedSequence: expectedSequenceExecuted,
      idempotencyKey: buildMergeOrchestrateIdempotencyKey(
        args.featureId,
        args.taskId,
        'merge.executed',
      ),
    };
    try {
      await ctx.eventStore.append(
        args.featureId,
        {
          type: 'merge.executed',
          data: {
            ...(args.taskId !== undefined ? { taskId: args.taskId } : {}),
            sourceBranch: args.sourceBranch,
            targetBranch: args.targetBranch,
            strategy: args.strategy,
            mergeSha: result.mergeSha,
            rollbackSha: result.rollbackSha,
          },
        },
        appendOptionsExecuted,
      );
    } catch (err) {
      // SequenceConflict here means a concurrent invocation already
      // advanced this stream past our observed tail. The other side will
      // have appended the canonical `merge.executed` (its own idempotency
      // key dedups its own retry) — surface a structured STATE_CONFLICT
      // rather than letting a raw substrate error escape.
      if (err instanceof SequenceConflictError) {
        return {
          success: false,
          error: {
            code: 'STATE_CONFLICT',
            message: `merge.executed append lost sequence race: expected=${err.expected} actual=${err.actual}`,
          },
        };
      }
      throw err;
    }

    // Terminal lifecycle marker — append `merge.completed` immediately after
    // `merge.executed` so the projection's `completed` phase is reachable.
    // Distinct event from `merge.executed`: the side effect record vs. the
    // lifecycle-terminated record. Future work may interpose post-merge
    // verification between the two. Idempotency-key suffix `:merge.completed`
    // keeps this dedup row separate from the executed/rollback rows on the
    // same stream.
    //
    // CAS against a FRESH stream-tail read — the SAME high-water-mark idiom
    // the `merge.executed` and `merge.rollback` sites use. We deliberately do
    // NOT pin to the `merge.executed` sequence we just observed: a static pin
    // strands the workflow permanently in `executing` (Sentry r3315312847).
    // The featureId stream is shared across many event types, so any unrelated
    // concurrent append between our two writes advances the tail past the pin.
    // Log adjacency is not a projection invariant — the reducer folds
    // `merge.completed` whenever it appears after `merge.executed`, regardless
    // of intervening events.
    //
    // RETRY IN PLACE (Sentry r3329404869). Recovery cannot be delegated to the
    // caller: `handleMergeOrchestrate` runs the executor OUTSIDE its retry
    // boundary on purpose, so re-invoking it would re-fire the non-idempotent
    // `vcsMerge` side effect. But this invocation just won the `merge.executed`
    // CAS, so it is the canonical owner of completion and must drive the stream
    // to its terminal phase itself. `withStateRetry` (which recognizes
    // `SequenceConflictError`) re-reads the advanced tail and re-appends on a
    // transient race; the idempotency key makes each attempt safe — a winner's
    // `merge.completed` returns a cache-hit rather than a duplicate, ending the
    // loop. The git merge already happened and is NOT re-run; only the terminal
    // marker is retried. A losing `merge.executed` invocation, by contrast,
    // returns STATE_CONFLICT above and defers completion to the winner.
    try {
      await withStateRetry(async () => {
        const tailEventsCompleted = await ctx.eventStore.query(args.featureId);
        const expectedSequenceCompleted =
          tailEventsCompleted.length > 0
            ? Math.max(...tailEventsCompleted.map((e) => e.sequence))
            : 0;
        const appendOptionsCompleted: { idempotencyKey: string; expectedSequence: number } = {
          expectedSequence: expectedSequenceCompleted,
          idempotencyKey: buildMergeOrchestrateIdempotencyKey(
            args.featureId,
            args.taskId,
            'merge.completed',
          ),
        };
        await ctx.eventStore.append(
          args.featureId,
          {
            type: 'merge.completed',
            data: {
              ...(args.taskId !== undefined ? { taskId: args.taskId } : {}),
              sourceBranch: args.sourceBranch,
              targetBranch: args.targetBranch,
              featureId: args.featureId,
              mergeSha: result.mergeSha,
            },
          },
          appendOptionsCompleted,
        );
      });
    } catch (err) {
      // The transient sequence race did not clear within MAX_STATE_RETRIES
      // attempts (substrate genuinely contended). `merge.executed` is already
      // durable, so the stream still rebuilds to `executed` — it does NOT
      // silently flip to a terminal phase — and a later re-dispatch can still
      // complete it (the idempotency key keeps that safe). Surface a
      // categorized STATE_CONFLICT rather than letting a raw substrate error
      // escape — symmetric with the `merge.executed`/`merge.rollback` sites.
      if (err instanceof SequenceConflictError) {
        return {
          success: false,
          error: {
            code: 'STATE_CONFLICT',
            message: `merge.completed append lost sequence race after ${MAX_STATE_RETRIES} retries: expected=${err.expected} actual=${err.actual}`,
          },
        };
      }
      throw err;
    }
  } else {
    // T16 — phase: 'rolled-back'. The pure executor already ran the INV-14
    // recovery ladder (`git merge --abort` → `git reset --keep`, never
    // `--hard`). Surface `recoveryError` + detail (when recovery was not clean)
    // so consumers can detect an indeterminate worktree.
    //
    // #1303 (α-05): pass `idempotencyKey` (when `taskId` is present) and
    // `expectedSequence` (CAS on stream high-water mark) so the substrate
    // guarantees from #1259 / #1323 reach this append site too. Symmetric
    // with α-02 (merge.executed) and α-04 (merge.preflight). The three
    // append sites in this orchestrator surface — preflight, executed,
    // rollback — each carry a distinct dedup key via the trailing
    // `:${eventType}` segment.
    const tailEventsRollback = await ctx.eventStore.query(args.featureId);
    const expectedSequenceRollback =
      tailEventsRollback.length > 0
        ? Math.max(...tailEventsRollback.map((e) => e.sequence))
        : 0;
    // INV-8: always set an idempotency key (helper falls back to a
    // featureId-only shape when taskId is absent) so concurrent invocations
    // without a taskId dedup at the substrate layer.
    const appendOptionsRollback: { idempotencyKey: string; expectedSequence: number } = {
      expectedSequence: expectedSequenceRollback,
      idempotencyKey: buildMergeOrchestrateIdempotencyKey(
        args.featureId,
        args.taskId,
        'merge.rollback',
      ),
    };
    try {
      await ctx.eventStore.append(
        args.featureId,
        {
          type: 'merge.rollback',
          data: {
            ...(args.taskId !== undefined ? { taskId: args.taskId } : {}),
            sourceBranch: args.sourceBranch,
            targetBranch: args.targetBranch,
            rollbackSha: result.rollbackSha,
            reason: result.reason,
            // INV-14 discriminator — the pure executor's recovery ladder
            // (`git merge --abort` → `git reset --keep`, never `--hard`)
            // classifies any indeterminate outcome so observability distinguishes
            // a stranded worktree from a clean rollback. Forward the enum + detail
            // verbatim; both absent on a clean recovery.
            ...(result.recoveryError !== undefined
              ? {
                  recoveryError: result.recoveryError,
                  ...(result.rollbackError !== undefined
                    ? { rollbackError: result.rollbackError }
                    : {}),
                }
              : {}),
          },
        },
        appendOptionsRollback,
      );
    } catch (err) {
      // SequenceConflict here means a concurrent invocation already
      // advanced this stream past our observed tail. Surface a structured
      // STATE_CONFLICT rather than letting a raw substrate error escape.
      if (err instanceof SequenceConflictError) {
        return {
          success: false,
          error: {
            code: 'STATE_CONFLICT',
            message: `merge.rollback append lost sequence race: expected=${err.expected} actual=${err.actual}`,
          },
        };
      }
      throw err;
    }
  }

  // Persist terminal phase to workflow state. CAS exhaustion surfaces as
  // STATE_CONFLICT — the event has already committed, so a projection
  // rebuild can still recover the terminal phase even if this write fails.
  try {
    if (result.phase === 'completed') {
      await persistState({
        phase: 'completed',
        rollbackSha: result.rollbackSha,
        mergeSha: result.mergeSha,
      });
    } else {
      await persistState({
        phase: 'rolled-back',
        rollbackSha: result.rollbackSha,
        reason: result.reason,
        ...(result.recoveryError !== undefined ? { recoveryError: result.recoveryError } : {}),
        ...(result.rollbackError !== undefined ? { rollbackError: result.rollbackError } : {}),
      });
    }
  } catch (err) {
    if (err instanceof VersionConflictError) {
      return {
        success: false,
        error: {
          code: 'STATE_CONFLICT',
          message: `Workflow state version conflict after ${MAX_STATE_RETRIES} retries: ${err.message}`,
        },
      };
    }
    // Surface other StateStoreErrors (notably STATE_NOT_FOUND when the
    // workflow's state file is missing) as structured failures. The
    // terminal `merge.executed` / `merge.rollback` event has already been
    // appended above, so projection rebuild can still recover the terminal
    // phase from the event stream even if this write fails.
    if (err instanceof StateStoreError) {
      return {
        success: false,
        error: {
          code: err.code === ErrorCode.STATE_NOT_FOUND ? 'STATE_READ_FAILED' : err.code,
          message: err.message,
        },
      };
    }
    throw err;
  }

  if (result.phase === 'completed') {
    return {
      success: true,
      data: {
        phase: 'completed' as const,
        mergeSha: result.mergeSha,
        rollbackSha: result.rollbackSha,
      },
    };
  }

  return {
    success: false,
    error: {
      code: 'MERGE_ROLLED_BACK',
      message: `Merge of ${args.sourceBranch} into ${args.targetBranch} rolled back: ${result.reason}`,
    },
    data: {
      phase: 'rolled-back' as const,
      rollbackSha: result.rollbackSha,
      reason: result.reason,
      ...(result.recoveryError !== undefined ? { recoveryError: result.recoveryError } : {}),
      ...(result.rollbackError !== undefined ? { rollbackError: result.rollbackError } : {}),
    },
  };
}
