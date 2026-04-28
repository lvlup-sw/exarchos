// ─── handleExecuteMerge — orchestrate handler (T15, DR-MO-2) ───────────────
//
// Wraps the pure `executeMerge` (T08+T09+T10) with:
//   • a VCS adapter built from `createVcsProvider(ctx.projectConfig)`
//   • a `gitExec` adapter using `execFileSync` (120s timeout, matches
//     post-merge.ts:48)
//   • a `persistState` callback that updates the workflow state's
//     `mergeOrchestrator` field (T01+T02 schema)
//   • on `phase: 'completed'`, emits `merge.executed` to the workflow's
//     event stream (stream id = featureId) carrying both the post-merge
//     `mergeSha` and the pre-merge `rollbackSha`
//
// The VCS adapter is intentionally injectable via `args.vcsMerge` so tests
// can bypass `createVcsProvider`. Same for `gitExec` and `persistState`.
// In production, the composite dispatcher (T20) constructs the defaults
// from `ctx.projectConfig` + `ctx.stateDir`.
//
// SCOPE: Happy path only. The `phase: 'rolled-back'` branch is not yet
// translated into a `merge.rollback` event — that is T16's responsibility.
// On rolled-back, this handler returns a structured error rather than
// silently swallowing the failure.
// ───────────────────────────────────────────────────────────────────────────

import { execFileSync } from 'node:child_process';
import * as path from 'node:path';
import { z } from 'zod';

import type { ToolResult } from '../format.js';
import type { DispatchContext } from '../core/dispatch.js';
import { executeMerge, type GitExec, type MergeStrategy } from './pure/execute-merge.js';
import { createVcsProvider } from '../vcs/factory.js';
import { readStateFile, writeStateFile } from '../workflow/state-store.js';

// ─── Args schema ───────────────────────────────────────────────────────────

export const HandleExecuteMergeArgsSchema = z.object({
  featureId: z.string().min(1),
  sourceBranch: z.string().min(1),
  targetBranch: z.string().min(1),
  taskId: z.string().optional(),
  strategy: z.enum(['squash', 'rebase', 'merge']).default('squash'),
  /**
   * VCS pull/merge request id. When omitted, the default `vcsMerge` adapter
   * cannot resolve a PR to merge through and will reject. Tests inject a
   * stub `vcsMerge` and skip this requirement.
   */
  prId: z.string().optional(),
  repoRoot: z.string().optional(),
});

export type HandleExecuteMergeArgs = z.infer<typeof HandleExecuteMergeArgsSchema>;

// ─── Internal types for DI overrides (tests use these) ─────────────────────

interface VcsMergeAdapter {
  (args: {
    sourceBranch: string;
    targetBranch: string;
    strategy: string;
  }): Promise<{ mergeSha: string }>;
}

interface PersistStateCallback {
  (state: { phase: 'executing'; rollbackSha: string }): Promise<void> | void;
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
 * Build the default VCS merge adapter from a configured project's VCS
 * provider. Requires a `prId` to be present on the input args; without one
 * we cannot translate a (sourceBranch, targetBranch) pair into a provider
 * `mergePr(prId, strategy)` call.
 */
function buildDefaultVcsMerge(
  input: HandleExecuteMergeInput,
  ctx: DispatchContext,
): VcsMergeAdapter {
  return async ({ strategy }) => {
    if (!input.prId) {
      throw new Error(
        'handleExecuteMerge: prId is required when vcsMerge adapter is not injected',
      );
    }
    const provider = await createVcsProvider({ config: ctx.projectConfig });
    const result = await provider.mergePr(input.prId, strategy);
    if (!result.merged || !result.sha) {
      throw new Error(
        `vcs mergePr did not complete: merged=${result.merged}, error=${result.error ?? 'none'}`,
      );
    }
    return { mergeSha: result.sha };
  };
}

/**
 * Build the default `persistState` callback. Reads the workflow state file
 * at `<stateDir>/<featureId>.state.json`, sets `mergeOrchestrator` to the
 * intermediate `executing` shape, and writes back atomically.
 */
function buildDefaultPersistState(
  featureId: string,
  sourceBranch: string,
  targetBranch: string,
  taskId: string | undefined,
  stateDir: string,
): PersistStateCallback {
  return async ({ phase, rollbackSha }) => {
    const stateFile = path.join(stateDir, `${featureId}.state.json`);
    const state = await readStateFile(stateFile);
    const next = {
      ...state,
      mergeOrchestrator: {
        ...((state as Record<string, unknown>).mergeOrchestrator as Record<string, unknown> | undefined),
        phase,
        sourceBranch,
        targetBranch,
        ...(taskId !== undefined ? { taskId } : {}),
        rollbackSha,
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
    prId: input.prId,
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
  const vcsMerge = input.vcsMerge ?? buildDefaultVcsMerge(input, ctx);
  const persistState =
    input.persistState ??
    buildDefaultPersistState(
      args.featureId,
      args.sourceBranch,
      args.targetBranch,
      args.taskId,
      ctx.stateDir,
    );

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
    return {
      success: false,
      error: {
        code: 'MERGE_FAILED',
        message: err instanceof Error ? err.message : String(err),
      },
    };
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

  // T16 will translate phase: 'rolled-back' into a `merge.rollback` event.
  // For T15 we surface the rollback as a structured error so callers do not
  // silently treat a rolled-back merge as success.
  return {
    success: false,
    error: {
      code: 'MERGE_ROLLED_BACK',
      message: `merge rolled back (reason: ${result.reason}); merge.rollback emission lands in T16`,
    },
    data: {
      phase: 'rolled-back' as const,
      rollbackSha: result.rollbackSha,
      reason: result.reason,
    },
  };
}
