/**
 * `merge_orchestrate` handler. It composes the merge preflight with `handleExecuteMerge`:
 *   1. A foreign live lease on the target branch in `worktrees@v1` fails with `MERGE_LEASE_HELD`.
 *   2. A sibling worktree that has the target branch checked out aborts with `PREFLIGHT_FAILED`.
 *      The executor merge fails there, and its rollback SHA comes from the wrong HEAD.
 *   3. With `resume`, a terminal `mergeOrchestrator` phase returns the recorded result.
 *   4. It runs the preflight and appends `merge.preflight`. A dry run stops here.
 *   5. A failed preflight writes the aborted phase to the state file and returns.
 *   6. It appends `merge.requested` through `decide`, then runs the executor outside that retry.
 *      The executor appends `merge.executed` and `merge.completed`.
 * Steps 1 and 2 run before any event append. The two side-effect imports register the
 * `worktrees@v1` and `merge-orchestrator@v1` reducers, so `AtomicAppender` resolves them by id.
 */

import { defaultGitExec } from '../vcs/git-exec-default.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { z } from 'zod';

import type { ToolResult } from '../../format.js';
import type { DispatchContext } from '../../dispatch/core/dispatch.js';
import {
  mergePreflight as defaultMergePreflight,
  type GitExec,
  type GitExecResult,
  type MergePreflightArgs,
  type MergePreflightResult,
} from '../pure/merge-preflight.js';
import {
  handleExecuteMerge as defaultHandleExecuteMerge,
  type HandleExecuteMergeInput,
} from './execute-merge.js';
import { buildMergeOrchestrateIdempotencyKey } from './merge-keys.js';
import { SequenceConflictError } from '../../events/store.js';
import {
  readStateFile,
  writeStateFile,
  VersionConflictError,
  StateStoreError,
} from '../../workflow/state-store.js';
import { ErrorCode } from '../../workflow/schemas.js';
import { EXCLUDED_MERGE_PHASES } from '../../workflow/hsm-definitions.js';
import {
  withStateRetry,
  MAX_STATE_RETRIES,
} from '../../workflow/state-retry.js';
import {
  ConcurrencyError,
  StorageBusyError,
} from '../../events/index.js';
import type { MergeOrchestratorState } from '../../projections/merge-orchestrator/index.js';
import { WORKTREES_STREAM, WORKTREES_REDUCER } from '../worktree/manager.js';
import '../worktree/projections/index.js';
import type {
  WorktreesProjection,
  InFlightMerge,
} from '../worktree/projections/worktrees.js';
import {
  probeReservations,
  defaultProcessTableSource,
  type ProcessTableSource,
} from '../worktree/pure/probe.js';
import type { OwnerLiveness } from '../worktree/pure/process-identity.js';
import '../../projections/merge-orchestrator/index.js';

/**
 * Arguments of `merge_orchestrate`. The handler validates them with this schema, because DI callers
 * bypass the Zod validation at the MCP registration boundary.
 */
export const HandleMergeOrchestrateArgsSchema = z.object({
  featureId: z.string().min(1),
  sourceBranch: z.string().min(1),
  targetBranch: z.string().min(1),
  taskId: z.string().optional(),
  /** Required with no default, as for `merge_pr.strategy`, so the event log records the intent. */
  strategy: z.enum(['squash', 'rebase', 'merge']),
  /**
   * When true, the handler stops after it appends `merge.preflight`. It writes no state and runs no
   * executor.
   */
  dryRun: z.boolean().optional(),
  /**
   * When true, the handler reads the `mergeOrchestrator` state before the preflight. A terminal
   * phase from {@link EXCLUDED_MERGE_PHASES} returns the recorded result with no new events. Any
   * other phase runs as a fresh dispatch.
   */
  resume: z.boolean().optional(),
  /** Optional override for the repository root used by the preflight gitExec. */
  repoRoot: z.string().optional(),
  /**
   * The merge-lease `operationId` of the caller. When the lease holder has this id, the merge
   * proceeds. This lets `serialize_merge` and a crash-resumed caller with the original id through.
   * A foreign holder that is not provably dead fails the merge. When absent, any live lease blocks.
   */
  leaseOperationId: z.string().optional(),
});

export type HandleMergeOrchestrateArgs = z.infer<typeof HandleMergeOrchestrateArgsSchema>;

type PreflightAdapter = (args: MergePreflightArgs) => Promise<MergePreflightResult>;

type ExecuteMergeAdapter = (
  input: HandleExecuteMergeInput,
  ctx: DispatchContext,
) => Promise<ToolResult>;

/**
 * Writes the `mergeOrchestrator` field of the workflow state. The handler writes only the `aborted`
 * shape.
 */
type OrchestratorPersistState = (
  state: {
    readonly phase: 'aborted';
    readonly preflight: MergePreflightResult;
    readonly abortReason: 'preflight-failed';
    readonly sourceBranch: string;
    readonly targetBranch: string;
    readonly taskId?: string;
  },
) => Promise<void> | void;

/** Reads the workflow state for the resume path. It returns `undefined` when no state exists. */
type OrchestratorReadState = () => Promise<
  | {
      readonly mergeOrchestrator?: Record<string, unknown>;
    }
  | undefined
>;

export interface HandleMergeOrchestrateInput extends HandleMergeOrchestrateArgs {
  readonly preflight?: PreflightAdapter;
  readonly executeMerge?: ExecuteMergeAdapter;
  readonly gitExec?: GitExec;
  readonly persistState?: OrchestratorPersistState;
  readonly readState?: OrchestratorReadState;
  /**
   * Process table for the liveness probe of the lease guard. The default is
   * {@link defaultProcessTableSource}.
   */
  readonly processTableSource?: ProcessTableSource;
}

/**
 * Returns the realpath of `p`, because git prints symlink-resolved worktree paths. It falls back to
 * `path.resolve` when the path does not exist.
 */
function normalizePath(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

/**
 * Default `persistState`. It reads `<stateDir>/<featureId>.state.json` and replaces the
 * `mergeOrchestrator` block, so stale SHAs or failure data of an earlier attempt do not stay. The
 * write passes the read `_version`, 1 when absent, so `withStateRetry` sees a concurrent writer. A
 * missing file throws `STATE_NOT_FOUND`, and the handler returns a structured error.
 */
function buildDefaultPersistState(
  featureId: string,
  stateDir: string,
): OrchestratorPersistState {
  return async (next) => {
    const stateFile = path.join(stateDir, `${featureId}.state.json`);
    const state = await readStateFile(stateFile);
    const expectedVersion = (state as Record<string, unknown>)._version as number | undefined ?? 1;
    const updated = {
      ...state,
      mergeOrchestrator: { ...next },
    };
    await writeStateFile(stateFile, updated as typeof state, { expectedVersion });
  };
}

/**
 * Default `readState`. It returns `undefined` only when `readStateFile` reports `STATE_NOT_FOUND`.
 * Any other error throws, so `resume` does not treat a corrupt file as absent and repeat the merge.
 */
function buildDefaultReadState(
  featureId: string,
  stateDir: string,
): OrchestratorReadState {
  return async () => {
    const stateFile = path.join(stateDir, `${featureId}.state.json`);
    try {
      const state = await readStateFile(stateFile);
      return state as unknown as { mergeOrchestrator?: Record<string, unknown> };
    } catch (err) {
      if (err instanceof StateStoreError && err.code === ErrorCode.STATE_NOT_FOUND) {
        return undefined;
      }
      throw err;
    }
  };
}

/**
 * Derive a short, operator-facing reason string from a failed preflight
 * result. Order mirrors the precedence used by the pure composer:
 * ancestry > current-branch protection > worktree assertion > drift.
 */
function describePreflightFailure(preflight: MergePreflightResult): string {
  if (!preflight.ancestry.passed) {
    const missing = preflight.ancestry.missing ?? [];
    return missing.length > 0
      ? `ancestry missing: ${missing.join(', ')}`
      : 'ancestry not satisfied';
  }
  if (preflight.currentBranchProtection.blocked) {
    const branch = preflight.currentBranchProtection.currentBranch ?? 'unknown';
    return `current branch protected: ${branch}`;
  }
  if (!preflight.worktree.isMain) {
    return `not on main worktree (actual: ${preflight.worktree.actual})`;
  }
  if (!preflight.drift.clean) {
    if (preflight.drift.detachedHead) return 'working tree detached';
    if (preflight.drift.indexStale) return 'git index stale';
    const files = preflight.drift.uncommittedFiles;
    return files.length > 0
      ? `uncommitted changes: ${files.length} file(s)`
      : 'working tree drift';
  }
  return 'preflight failed';
}

/**
 * Classifies the liveness of a foreign lease holder with {@link probeReservations}, the check that
 * the serializer uses to reclaim a dead holder. A holder with no fingerprint, or any pid on an
 * unsupported process table, is `'unknown'` and counts as held. Only `'dead'` lets the merge run.
 */
function classifyMergeHolderLiveness(
  holder: InFlightMerge,
  source: ProcessTableSource,
): OwnerLiveness {
  if (holder.holderPid === null || holder.holderStartedAt === null) {
    return 'unknown';
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
  return finding?.liveness ?? 'unknown';
}

/**
 * Runs the steps in the file header. The lease lookup uses the bare `targetBranch`, because the
 * serializer keys `inFlightMerges` by it, not by `refs/heads/...`. The sibling check compares
 * realpaths, because git prints symlink-resolved paths. Without `repoRoot`, the root comes from
 * `git rev-parse --show-toplevel`, because the cwd can be a subdirectory.
 *
 * The `merge.preflight` append carries an idempotency key and an `expectedSequence`. A replay then
 * dedups, and a race gives `STATE_CONFLICT`. In the `requested`, `executed`, `recovering` and
 * `completed` phases, the `decide` closure emits nothing. Its `alwaysEnforceConsistency: false`
 * keeps a concurrent append from failing that no-op path.
 */
export async function handleMergeOrchestrate(
  input: HandleMergeOrchestrateInput,
  ctx: DispatchContext,
): Promise<ToolResult> {
  const parsed = HandleMergeOrchestrateArgsSchema.safeParse({
    featureId: input.featureId,
    sourceBranch: input.sourceBranch,
    targetBranch: input.targetBranch,
    taskId: input.taskId,
    strategy: input.strategy,
    dryRun: input.dryRun,
    resume: input.resume,
    repoRoot: input.repoRoot,
    leaseOperationId: input.leaseOperationId,
  });
  if (!parsed.success) {
    return {
      success: false,
      error: {
        code: 'INVALID_INPUT',
        message: `handleMergeOrchestrate: ${parsed.error.message}`,
      },
    };
  }
  const args = parsed.data;

  const preflightFn = input.preflight ?? defaultMergePreflight;
  const executeMergeFn = input.executeMerge ?? defaultHandleExecuteMerge;
  const gitExec = input.gitExec ?? defaultGitExec;
  const persistState =
    input.persistState ?? buildDefaultPersistState(args.featureId, ctx.stateDir);
  const readState =
    input.readState ?? buildDefaultReadState(args.featureId, ctx.stateDir);
  const processTableSource = input.processTableSource ?? defaultProcessTableSource;
  const appender = ctx.eventStore.getAppender();

  const worktreesFold = await appender.aggregateStream<WorktreesProjection>(
    WORKTREES_STREAM,
    WORKTREES_REDUCER,
  );
  const leaseHolder = worktreesFold.aggregate.inFlightMerges[args.targetBranch];
  if (leaseHolder !== undefined && leaseHolder.operationId !== args.leaseOperationId) {
    const liveness = classifyMergeHolderLiveness(leaseHolder, processTableSource);
    if (liveness !== 'dead') {
      return {
        success: false,
        error: {
          code: 'MERGE_LEASE_HELD',
          message:
            `integration ref '${args.targetBranch}' is held by an in-flight merge lease ` +
            `(operationId=${leaseHolder.operationId}, liveness=${liveness}) — ` +
            `route this merge through serialize_merge to acquire the single-writer lease`,
        },
        data: {
          reason: 'foreign-live-lease' as const,
          integrationRef: args.targetBranch,
          holder: {
            operationId: leaseHolder.operationId,
            sourceBranch: leaseHolder.sourceBranch,
            holderPid: leaseHolder.holderPid,
            liveness,
          },
        },
      };
    }
  }

  let derivedRoot = args.repoRoot;
  if (derivedRoot === undefined) {
    const topLevel = gitExec(process.cwd(), ['rev-parse', '--show-toplevel']);
    if (topLevel.exitCode === 0) {
      derivedRoot = topLevel.stdout.trim();
    } else {
      derivedRoot = process.cwd();
    }
  }
  const repoRoot = normalizePath(derivedRoot);
  const worktreeListResult = gitExec(repoRoot, ['worktree', 'list', '--porcelain']);
  if (worktreeListResult.exitCode === 0) {
    const targetRef = `refs/heads/${args.targetBranch}`;
    let currentPath: string | undefined;
    let siblingHoldingTarget: string | undefined;
    for (const rawLine of worktreeListResult.stdout.split('\n')) {
      const line = rawLine.trimEnd();
      if (line.startsWith('worktree ')) {
        currentPath = normalizePath(line.slice('worktree '.length));
      } else if (line.startsWith('branch ')) {
        const ref = line.slice('branch '.length);
        if (ref === targetRef && currentPath !== undefined && currentPath !== repoRoot) {
          siblingHoldingTarget = currentPath;
          break;
        }
      } else if (line === '') {
        currentPath = undefined;
      }
    }
    if (siblingHoldingTarget !== undefined) {
      return {
        success: false,
        error: {
          code: 'PREFLIGHT_FAILED',
          message: `Target branch '${args.targetBranch}' is checked out in sibling worktree: ${siblingHoldingTarget}`,
        },
        data: {
          phase: 'aborted' as const,
          reason: 'target-checked-out-elsewhere' as const,
          siblingWorktreePath: siblingHoldingTarget,
        },
      };
    }
  }

  if (args.resume === true) {
    let existing: Awaited<ReturnType<OrchestratorReadState>>;
    try {
      existing = await readState();
    } catch (err) {
      return {
        success: false,
        error: {
          code: 'STATE_READ_FAILED',
          message: `Resume read failed: ${err instanceof Error ? err.message : String(err)}`,
        },
      };
    }
    const merge = existing?.mergeOrchestrator;
    const phase = typeof merge?.phase === 'string' ? merge.phase : undefined;
    if (phase !== undefined && EXCLUDED_MERGE_PHASES.has(phase)) {
      if (phase === 'completed') {
        return {
          success: true,
          data: { ...merge },
        };
      }
      return {
        success: false,
        error: {
          code: phase === 'aborted' ? 'PREFLIGHT_FAILED' : 'MERGE_ROLLED_BACK',
          message: `Resume: merge already in terminal phase '${phase}'`,
        },
        data: { ...merge },
      };
    }
  }

  let preflight: MergePreflightResult;
  try {
    preflight = await preflightFn({
      sourceBranch: args.sourceBranch,
      targetBranch: args.targetBranch,
      gitExec,
      ...(args.repoRoot !== undefined ? { cwd: args.repoRoot } : {}),
    });
  } catch (err) {
    return {
      success: false,
      error: {
        code: 'PREFLIGHT_FAILED',
        message: err instanceof Error ? err.message : String(err),
      },
    };
  }

  const tailEventsPreflight = await ctx.eventStore.query(args.featureId);
  const expectedSequencePreflight =
    tailEventsPreflight.length > 0
      ? Math.max(...tailEventsPreflight.map((e) => e.sequence))
      : 0;
  const appendOptionsPreflight: { idempotencyKey: string; expectedSequence: number } = {
    expectedSequence: expectedSequencePreflight,
    idempotencyKey: buildMergeOrchestrateIdempotencyKey(
      args.featureId,
      args.taskId,
      'merge.preflight',
    ),
  };
  try {
    await ctx.eventStore.append(
      args.featureId,
      {
        type: 'merge.preflight',
        data: {
          ...(args.taskId !== undefined ? { taskId: args.taskId } : {}),
          sourceBranch: args.sourceBranch,
          targetBranch: args.targetBranch,
          passed: preflight.passed,
          ancestry: preflight.ancestry,
          currentBranchProtection: preflight.currentBranchProtection,
          worktree: preflight.worktree,
          drift: preflight.drift,
          ...(preflight.passed
            ? {}
            : { failureReasons: [describePreflightFailure(preflight)] }),
          ...(preflight.debug !== undefined && preflight.ancestry?.passed === false
            ? { debug: preflight.debug }
            : {}),
        },
      },
      appendOptionsPreflight,
    );
  } catch (err) {
    if (err instanceof SequenceConflictError) {
      return {
        success: false,
        error: {
          code: 'STATE_CONFLICT',
          message: `merge.preflight append lost sequence race: expected=${err.expected} actual=${err.actual}`,
        },
      };
    }
    return {
      success: false,
      error: {
        code: ErrorCode.EVENT_APPEND_FAILED,
        message: `merge.preflight append failed: ${err instanceof Error ? err.message : String(err)}`,
      },
    };
  }

  if (args.dryRun === true) {
    if (preflight.passed) {
      return {
        success: true,
        data: {
          dryRun: true as const,
          preflight,
          phase: 'pending' as const,
        },
      };
    }
    return {
      success: false,
      error: {
        code: 'PREFLIGHT_FAILED',
        message: `Preflight failed: ${describePreflightFailure(preflight)}`,
      },
      data: {
        dryRun: true as const,
        preflight,
        phase: 'aborted' as const,
      },
    };
  }

  if (!preflight.passed) {
    try {
      await withStateRetry(() =>
        Promise.resolve(
          persistState({
            phase: 'aborted',
            preflight,
            abortReason: 'preflight-failed',
            sourceBranch: args.sourceBranch,
            targetBranch: args.targetBranch,
            ...(args.taskId !== undefined ? { taskId: args.taskId } : {}),
          }),
        ),
      );
    } catch (err) {
      if (err instanceof VersionConflictError) {
        return {
          success: false,
          error: {
            code: 'STATE_CONFLICT',
            message: `Workflow state version conflict after ${MAX_STATE_RETRIES} retries`,
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
          data: {
            phase: 'aborted' as const,
            preflight,
          },
        };
      }
      return {
        success: false,
        error: {
          code: 'STATE_WRITE_FAILED',
          message: err instanceof Error ? err.message : String(err),
        },
        data: {
          phase: 'aborted',
          preflight,
        },
      };
    }
    return {
      success: false,
      error: {
        code: 'PREFLIGHT_FAILED',
        message: `Preflight failed: ${describePreflightFailure(preflight)}`,
      },
      data: {
        phase: 'aborted' as const,
        preflight,
      },
    };
  }

  const operationId =
    args.taskId !== undefined
      ? `merge-requested:${args.featureId}:${args.taskId}`
      : `merge-requested:${args.featureId}`;
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
              correlationId: operationId,
            },
          ];
        },
        { operationId, alwaysEnforceConsistency: false },
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
    return {
      success: false,
      error: {
        code: ErrorCode.EVENT_APPEND_FAILED,
        message: `merge.requested decide failed: ${err instanceof Error ? err.message : String(err)}`,
      },
    };
  }

  const execResult = await executeMergeFn(
    {
      featureId: args.featureId,
      sourceBranch: args.sourceBranch,
      targetBranch: args.targetBranch,
      ...(args.taskId !== undefined ? { taskId: args.taskId } : {}),
      strategy: args.strategy,
      ...(args.repoRoot !== undefined ? { repoRoot: args.repoRoot } : {}),
    },
    ctx,
  );

  if (!execResult.success) {
    return execResult;
  }

  const execData = execResult.data as {
    phase: 'completed';
    mergeSha: string;
    recoveryPointSha: string;
  };

  return {
    success: true,
    data: {
      phase: 'completed' as const,
      mergeSha: execData.mergeSha,
      recoveryPointSha: execData.recoveryPointSha,
      preflight,
    },
  };
}
