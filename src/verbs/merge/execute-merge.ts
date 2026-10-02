/**
 * The internal merge executor handler. It wraps the pure `executeMerge` with a local `git merge`
 * adapter, a `gitExec` adapter, and a `persistState` callback for the `mergeOrchestrator` state field.
 * Tests can inject each of the three through the input.
 *
 * The side-effect import of the merge-orchestrator projection registers `merge-orchestrator@v1`.
 * `AtomicAppender.decide` resolves that reducer by id when it commits `merge.requested`.
 */

import { defaultGitExec } from '../vcs/git-exec-default.js';
import * as path from 'node:path';
import { z } from 'zod';

import type { ToolResult } from '../../format.js';
import type { DispatchContext } from '../../dispatch/core/dispatch.js';
import { executeMerge, type GitExec, type MergeStrategy } from '../pure/execute-merge.js';
import { buildLocalGitMergeAdapter } from './local-git-merge.js';
import { buildMergeOrchestrateIdempotencyKey } from './merge-keys.js';
import { SequenceConflictError } from '../../events/store.js';
import {
  readStateFile,
  writeStateFile,
  VersionConflictError,
  StateStoreError,
} from '../../workflow/state-store.js';
import { ErrorCode } from '../../workflow/schemas.js';
import {
  withStateRetry,
  MAX_STATE_RETRIES,
} from '../../workflow/state-retry.js';
import {
  ConcurrencyError,
  StorageBusyError,
} from '../../events/index.js';
import type { MergeOrchestratorState } from '../../projections/merge-orchestrator/index.js';
import '../../projections/merge-orchestrator/index.js';

export const HandleExecuteMergeArgsSchema = z.object({
  featureId: z.string().min(1),
  sourceBranch: z.string().min(1),
  targetBranch: z.string().min(1),
  taskId: z.string().optional(),
  strategy: z.enum(['squash', 'rebase', 'merge']),
  repoRoot: z.string().optional(),
});

export type HandleExecuteMergeArgs = z.infer<typeof HandleExecuteMergeArgsSchema>;

interface VcsMergeAdapter {
  (args: {
    sourceBranch: string;
    targetBranch: string;
    strategy: MergeStrategy;
  }): Promise<{ mergeSha: string }>;
}

/**
 * The three phases that the executor writes: `executing` before `vcsMerge`, `completed` after it
 * resolves, and `rolled-back` after the recovery ladder. The terminal shapes carry `mergeSha` or
 * `reason`, so the state file describes the result without the event stream.
 */
export type ExecutorPersistStatePayload =
  | { phase: 'executing'; recoveryPointSha: string }
  | { phase: 'completed'; recoveryPointSha: string; mergeSha: string }
  | {
      phase: 'rolled-back';
      recoveryPointSha: string;
      reason: 'merge-failed' | 'verification-failed' | 'timeout';
      /** The recovery fault. It is absent on a clean recovery. */
      recoveryError?: 'reset-keep-blocked' | 'reset-failed' | 'unexpected-mid-merge-drift';
      /** The text detail for `recoveryError`. It is absent on a clean recovery. */
      recoveryErrorDetail?: string;
    };

interface PersistStateCallback {
  (state: ExecutorPersistStatePayload): Promise<void> | void;
}

/** The public args plus in-process injection hooks. The Zod schema validates only the public fields. */
export interface HandleExecuteMergeInput extends HandleExecuteMergeArgs {
  readonly vcsMerge?: VcsMergeAdapter;
  readonly gitExec?: GitExec;
  readonly persistState?: PersistStateCallback;
  /**
   * Test hooks for the timeout retry, forwarded to the pure `executeMerge`. `jitter` fixes the
   * backoff jitter and `sleep` skips the real delay. Production leaves both undefined.
   */
  readonly jitter?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
}

/**
 * Builds the default `vcsMerge` adapter: a local `git merge` of source into target. A local merge
 * makes the recorded `recoveryPointSha` a local ref that `git reset --keep` can undo.
 */
function buildDefaultVcsMerge(
  input: HandleExecuteMergeInput,
  gitExec: GitExec,
): VcsMergeAdapter {
  return buildLocalGitMergeAdapter(gitExec, input.repoRoot ?? process.cwd());
}

/**
 * Builds the default `persistState` callback. It reads `<stateDir>/<featureId>.state.json`, merges
 * the payload into the existing `mergeOrchestrator` block, and writes the file with `expectedVersion`.
 * It merges and does not replace the block, so fields from earlier phase writes stay.
 * Without that version, `writeStateFile` skips its version check and `withStateRetry` has nothing to retry.
 * A missing state file throws `StateStoreError`, and the callback does not invent a baseline.
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
    const state = await readStateFile(stateFile);
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

/**
 * Runs one merge and records its events. `decide` commits `merge.requested` before the git merge. It
 * appends nothing when the projection phase is `requested`, `executed`, `recovering`, or `completed`.
 * The `decide` call turns off the empty-write check, so a concurrent append does not fail that no-op path.
 * The git merge runs outside the `decide` retry, so a lost race there does not run the merge again.
 *
 * A success appends `merge.executed`, then retries `merge.completed` in place, because this call owns completion.
 * A rollback appends only `merge.recovered`. Each terminal event goes to the store before the state file write.
 * Each direct append reads a fresh stream tail and has its own idempotency key, so a replay is a no-op.
 * Other event types share the stream, so a sequence pin from an earlier append leaves the workflow in `executing`.
 * A sequence conflict on the liveness or retry audit events does not stop the merge.
 */
export async function handleExecuteMerge(
  input: HandleExecuteMergeInput,
  ctx: DispatchContext,
): Promise<ToolResult> {
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

  const instanceId = args.taskId ?? `${args.sourceBranch}→${args.targetBranch}`;

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

  const emitExecutingStarted = async (recoveryPointSha: string): Promise<void> => {
    const tailEventsStarted = await ctx.eventStore.query(args.featureId);
    const expectedSequenceStarted =
      tailEventsStarted.length > 0
        ? Math.max(...tailEventsStarted.map((e) => e.sequence))
        : 0;
    try {
      await ctx.eventStore.append(
        args.featureId,
        {
          type: 'merge.executing_started',
          data: {
            ...(args.taskId !== undefined ? { taskId: args.taskId } : {}),
            sourceBranch: args.sourceBranch,
            targetBranch: args.targetBranch,
            recoveryPointSha,
            startedAt: new Date().toISOString(),
            instanceId,
          },
        },
        {
          expectedSequence: expectedSequenceStarted,
          idempotencyKey: buildMergeOrchestrateIdempotencyKey(
            args.featureId,
            args.taskId,
            'merge.executing_started',
          ),
        },
      );
    } catch (err) {
      if (!(err instanceof SequenceConflictError)) {
        throw err;
      }
    }
  };

  let executingStartedEmitted = false;
  const persistState: PersistStateCallback = async (state) => {
    if (state.phase === 'executing' && !executingStartedEmitted) {
      executingStartedEmitted = true;
      await emitExecutingStarted(state.recoveryPointSha);
    }
    await withStateRetry(async () => {
      await rawPersistState(state);
    });
  };

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

  const onRetryAttempt = async (info: {
    attempt: number;
    delayMs: number;
    reason: 'timeout';
  }): Promise<void> => {
    const tailEventsRetry = await ctx.eventStore.query(args.featureId);
    const expectedSequenceRetry =
      tailEventsRetry.length > 0
        ? Math.max(...tailEventsRetry.map((e) => e.sequence))
        : 0;
    try {
      await ctx.eventStore.append(
        args.featureId,
        {
          type: 'merge.retry_attempt',
          data: {
            attempt: info.attempt,
            delayMs: info.delayMs,
            reason: info.reason,
          },
        },
        {
          expectedSequence: expectedSequenceRetry,
          idempotencyKey: buildMergeOrchestrateIdempotencyKey(
            args.featureId,
            args.taskId,
            `merge.retry_attempt:${info.attempt}`,
          ),
        },
      );
    } catch (err) {
      if (!(err instanceof SequenceConflictError)) {
        throw err;
      }
    }
  };

  let result;
  try {
    result = await executeMerge({
      sourceBranch: args.sourceBranch,
      targetBranch: args.targetBranch,
      strategy: args.strategy as MergeStrategy,
      gitExec,
      vcsMerge,
      persistState,
      onRetryAttempt,
      ...(input.jitter !== undefined ? { jitter: input.jitter } : {}),
      ...(input.sleep !== undefined ? { sleep: input.sleep } : {}),
      ...(args.repoRoot !== undefined ? { repoRoot: args.repoRoot } : {}),
    });
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

  if (result.phase === 'completed') {
    const tailEventsExecuted = await ctx.eventStore.query(args.featureId);
    const expectedSequenceExecuted =
      tailEventsExecuted.length > 0
        ? Math.max(...tailEventsExecuted.map((e) => e.sequence))
        : 0;
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
            rollbackSha: result.recoveryPointSha,
            instanceId,
          },
        },
        appendOptionsExecuted,
      );
    } catch (err) {
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
    const tailEventsRecovered = await ctx.eventStore.query(args.featureId);
    const expectedSequenceRecovered =
      tailEventsRecovered.length > 0
        ? Math.max(...tailEventsRecovered.map((e) => e.sequence))
        : 0;
    const appendOptionsRecovered: { idempotencyKey: string; expectedSequence: number } = {
      expectedSequence: expectedSequenceRecovered,
      idempotencyKey: buildMergeOrchestrateIdempotencyKey(
        args.featureId,
        args.taskId,
        'merge.recovered',
      ),
    };
    try {
      await ctx.eventStore.append(
        args.featureId,
        {
          type: 'merge.recovered',
          data: {
            ...(args.taskId !== undefined ? { taskId: args.taskId } : {}),
            sourceBranch: args.sourceBranch,
            targetBranch: args.targetBranch,
            recoveryPointSha: result.recoveryPointSha,
            reason: result.reason,
            ...(result.recoveryError !== undefined
              ? {
                  recoveryError: result.recoveryError,
                  ...(result.recoveryErrorDetail !== undefined
                    ? { recoveryErrorDetail: result.recoveryErrorDetail }
                    : {}),
                }
              : {}),
          },
        },
        appendOptionsRecovered,
      );
    } catch (err) {
      if (err instanceof SequenceConflictError) {
        return {
          success: false,
          error: {
            code: 'STATE_CONFLICT',
            message: `merge.recovered append lost sequence race: expected=${err.expected} actual=${err.actual}`,
          },
        };
      }
      throw err;
    }
  }

  try {
    if (result.phase === 'completed') {
      await persistState({
        phase: 'completed',
        recoveryPointSha: result.recoveryPointSha,
        mergeSha: result.mergeSha,
      });
    } else {
      await persistState({
        phase: 'rolled-back',
        recoveryPointSha: result.recoveryPointSha,
        reason: result.reason,
        ...(result.recoveryError !== undefined ? { recoveryError: result.recoveryError } : {}),
        ...(result.recoveryErrorDetail !== undefined ? { recoveryErrorDetail: result.recoveryErrorDetail } : {}),
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
        recoveryPointSha: result.recoveryPointSha,
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
      recoveryPointSha: result.recoveryPointSha,
      reason: result.reason,
      ...(result.recoveryError !== undefined ? { recoveryError: result.recoveryError } : {}),
      ...(result.recoveryErrorDetail !== undefined ? { recoveryErrorDetail: result.recoveryErrorDetail } : {}),
    },
  };
}
