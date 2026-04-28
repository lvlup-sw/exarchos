// ─── handleExecuteMerge — orchestrate handler (T15, DR-MO-2) ───────────────
//
// Wraps the pure `executeMerge` (T08+T09+T10) with:
//   • a local-git merge adapter via `buildLocalGitMergeAdapter` (#1194 —
//     replaced the previous remote VcsProvider call so the recorded
//     rollbackSha actually corresponds to a local ref the executor's
//     `git reset --hard` rollback can undo)
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
// has already run `git reset --hard <rollbackSha>`, so the handler emits a
// `merge.rollback` event (categorized reason: 'merge-failed' |
// 'verification-failed' | 'timeout') and returns a structured error.
// ───────────────────────────────────────────────────────────────────────────

import { execFileSync } from 'node:child_process';
import * as path from 'node:path';
import { z } from 'zod';

import type { ToolResult } from '../format.js';
import type { DispatchContext } from '../core/dispatch.js';
import { executeMerge, type GitExec, type MergeStrategy } from './pure/execute-merge.js';
import { buildLocalGitMergeAdapter } from './local-git-merge.js';
import {
  readStateFile,
  writeStateFile,
  VersionConflictError,
} from '../workflow/state-store.js';
import {
  withStateRetry,
  MAX_STATE_RETRIES,
} from '../workflow/state-retry.js';

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
 *   • `rolled-back` — terminal failure, AFTER `git reset --hard` (T27)
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

/** Default `gitExec`: synchronous shell-out with 120s timeout. */
function defaultGitExec(repoRoot: string, args: readonly string[]): { stdout: string; exitCode: number } {
  try {
    const stdout = execFileSync('git', [...args], {
      cwd: repoRoot,
      timeout: 120_000,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return { stdout, exitCode: 0 };
  } catch (err) {
    const status = (err as { status?: number }).status;
    return { stdout: '', exitCode: typeof status === 'number' ? status : 1 };
  }
}

/**
 * Build the default `vcsMerge` adapter — a *local* `git merge` of source
 * into target. See `local-git-merge.ts` for the full contract; the executor
 * uses this adapter so the recorded `rollbackSha` actually corresponds to
 * a local ref the rollback `git reset --hard` can undo (#1194).
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
 * Spreading the entire payload (rather than picking individual fields) means
 * terminal-phase fields like `mergeSha` and `reason` ride alongside the
 * always-present `phase` + `rollbackSha`, keeping the state file self-
 * describing.
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
    await writeStateFile(stateFile, next as typeof state);
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
    return {
      success: false,
      error: {
        code: 'MERGE_FAILED',
        message: err instanceof Error ? err.message : String(err),
      },
    };
  }

  // T29: wrap terminal persistState in try/catch so a CAS exhaustion on
  // the terminal write surfaces as STATE_CONFLICT (not an unhandled throw).
  try {
    if (result.phase === 'completed') {
      // T27 — persist terminal phase BEFORE event emission so observers
      // reading state at event-emit time see the final phase. Without this
      // write, disk state stays at 'executing' (T09) forever.
      await persistState({
        phase: 'completed',
        rollbackSha: result.rollbackSha,
        mergeSha: result.mergeSha,
      });
    } else {
      // T16 — phase: 'rolled-back'. The pure executor already ran
      // `git reset --hard <rollbackSha>`. T27 — persist terminal phase
      // BEFORE emitting so the HSM merge-pending exit guard and the
      // next-actions omission filter (T19) see the rolled-back phase on
      // subsequent reads.
      await persistState({
        phase: 'rolled-back',
        rollbackSha: result.rollbackSha,
        reason: result.reason,
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
    throw err;
  }

  if (result.phase === 'completed') {
    // Direct stream append — NOT wrapped in `gate.executed`. The dedicated
    // `merge.executed` schema (T03) lives at the top level so observability
    // and HSM guards can match on it directly.
    await ctx.eventStore.append(args.featureId, {
      type: 'merge.executed',
      data: {
        ...(args.taskId !== undefined ? { taskId: args.taskId } : {}),
        sourceBranch: args.sourceBranch,
        targetBranch: args.targetBranch,
        mergeSha: result.mergeSha,
        rollbackSha: result.rollbackSha,
      },
    });

    return {
      success: true,
      data: {
        phase: 'completed' as const,
        mergeSha: result.mergeSha,
        rollbackSha: result.rollbackSha,
      },
    };
  }


  await ctx.eventStore.append(args.featureId, {
    type: 'merge.rollback',
    data: {
      ...(args.taskId !== undefined ? { taskId: args.taskId } : {}),
      sourceBranch: args.sourceBranch,
      targetBranch: args.targetBranch,
      rollbackSha: result.rollbackSha,
      reason: result.reason,
    },
  });

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
    },
  };
}
