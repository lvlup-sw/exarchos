// ─── handleMergeOrchestrate — top-level orchestrator handler (T11) ─────────
//
// DR-MO-1 (preflight) + DR-MO-2 (executor) — composes the merge preflight
// composer (T06/T07) with the executor handler (T15) under one coherent
// entry point.
//
// SCOPE — T11 covers the happy path; T12 adds the abort branch:
//   • run preflight via the injectable composer
//   • emit `merge.preflight` to the stream (direct append, NOT wrapped in
//     `gate.executed` — the dedicated schema (T03) is top-level so HSM
//     guards / observability can match on it directly)
//   • on preflight pass, delegate to `handleExecuteMerge` and surface its
//     `phase: 'completed'` result with the preflight payload attached.
//   • on preflight fail (T12), persist
//     `mergeOrchestrator: { phase: 'aborted', preflight, abortReason:
//     'preflight-failed' }` to workflow state and return a structured
//     `PREFLIGHT_FAILED` ToolResult WITHOUT invoking the executor.
//
// Out of scope (handled in subsequent tasks):
//   • T13 — `args.dryRun` (run preflight, emit, persist, do NOT execute).
//   • T14 — `args.resume` + concurrency retry.
//   • T20 — composite registration.
//
// The composer + executor are exposed as injectable adapters so tests can
// bypass the real `mergePreflight` (which shells out to git) and the real
// `handleExecuteMerge` (which talks to the VCS provider). In production,
// the composite dispatcher (T20) constructs the defaults from
// `ctx.projectConfig` + `ctx.stateDir`.
// ───────────────────────────────────────────────────────────────────────────

import { execFileSync } from 'node:child_process';
import * as path from 'node:path';
import { z } from 'zod';

import type { ToolResult } from '../format.js';
import type { DispatchContext } from '../core/dispatch.js';
import {
  mergePreflight as defaultMergePreflight,
  type GitExec,
  type GitExecResult,
  type MergePreflightArgs,
  type MergePreflightResult,
} from './pure/merge-preflight.js';
import {
  handleExecuteMerge as defaultHandleExecuteMerge,
  type HandleExecuteMergeInput,
} from './execute-merge.js';
import { readStateFile, writeStateFile } from '../workflow/state-store.js';

// ─── Args schema ───────────────────────────────────────────────────────────

export const HandleMergeOrchestrateArgsSchema = z.object({
  featureId: z.string().min(1),
  sourceBranch: z.string().min(1),
  targetBranch: z.string().min(1),
  taskId: z.string().optional(),
  strategy: z.enum(['squash', 'rebase', 'merge']).default('squash'),
  /** Reserved for T13. Not honored in T11. */
  dryRun: z.boolean().optional(),
  /** Reserved for T14. Not honored in T11. */
  resume: z.boolean().optional(),
  /** Optional override for the repository root used by the preflight gitExec. */
  repoRoot: z.string().optional(),
  /** PR id forwarded to the default executor's vcsMerge adapter. */
  prId: z.string().optional(),
});

export type HandleMergeOrchestrateArgs = z.infer<typeof HandleMergeOrchestrateArgsSchema>;

// ─── DI override types (test-only; never crossed over the wire) ────────────

type PreflightAdapter = (args: MergePreflightArgs) => Promise<MergePreflightResult>;

type ExecuteMergeAdapter = (
  input: HandleExecuteMergeInput,
  ctx: DispatchContext,
) => Promise<ToolResult>;

/**
 * Persistence callback for the orchestrator's `mergeOrchestrator` state
 * field. T12 only emits the `aborted` shape; T13/T14 will extend the
 * union with `dry-run` and `resuming` shapes.
 */
type OrchestratorPersistState = (
  state: {
    readonly phase: 'aborted';
    readonly preflight: MergePreflightResult;
    readonly abortReason: 'preflight-failed';
  },
) => Promise<void> | void;

export interface HandleMergeOrchestrateInput extends HandleMergeOrchestrateArgs {
  readonly preflight?: PreflightAdapter;
  readonly executeMerge?: ExecuteMergeAdapter;
  readonly gitExec?: GitExec;
  readonly persistState?: OrchestratorPersistState;
}

// ─── Default gitExec ───────────────────────────────────────────────────────

/**
 * Default `gitExec` for the preflight composer. Mirrors the convention used
 * by `handleExecuteMerge`: synchronous shell-out with a 120s ceiling, never
 * throws (we surface failures via `exitCode`).
 */
function defaultGitExec(repoRoot: string, args: readonly string[]): GitExecResult {
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
 * Default `persistState` for the orchestrator. Reads the workflow state
 * file at `<stateDir>/<featureId>.state.json`, sets the
 * `mergeOrchestrator` field to the supplied shape, and writes back
 * atomically. Mirrors the convention from `handleExecuteMerge`.
 */
function buildDefaultPersistState(
  featureId: string,
  stateDir: string,
): OrchestratorPersistState {
  return async (next) => {
    const stateFile = path.join(stateDir, `${featureId}.state.json`);
    const state = await readStateFile(stateFile);
    const updated = {
      ...state,
      mergeOrchestrator: {
        ...((state as Record<string, unknown>).mergeOrchestrator as
          | Record<string, unknown>
          | undefined),
        ...next,
      },
    };
    await writeStateFile(stateFile, updated as typeof state);
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

// ─── Handler ───────────────────────────────────────────────────────────────

export async function handleMergeOrchestrate(
  input: HandleMergeOrchestrateInput,
  ctx: DispatchContext,
): Promise<ToolResult> {
  // Validate the externally-supplied args (DI hooks bypass the schema).
  const parsed = HandleMergeOrchestrateArgsSchema.safeParse({
    featureId: input.featureId,
    sourceBranch: input.sourceBranch,
    targetBranch: input.targetBranch,
    taskId: input.taskId,
    strategy: input.strategy,
    dryRun: input.dryRun,
    resume: input.resume,
    repoRoot: input.repoRoot,
    prId: input.prId,
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

  // ─── 1. Run preflight ────────────────────────────────────────────────────
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

  // ─── 2. Emit merge.preflight (direct append — see header note) ───────────
  await ctx.eventStore.append(args.featureId, {
    type: 'merge.preflight',
    data: {
      ...(args.taskId !== undefined ? { taskId: args.taskId } : {}),
      sourceBranch: args.sourceBranch,
      targetBranch: args.targetBranch,
      passed: preflight.passed,
    },
  });

  // ─── 3. Preflight-fail abort branch (T12) ────────────────────────────────
  if (!preflight.passed) {
    // Persist the abort to workflow state BEFORE returning so downstream
    // observers (HSM guards, status views) see the aborted phase even if
    // the caller drops the ToolResult on the floor. The executor must NOT
    // run on this path.
    await persistState({
      phase: 'aborted',
      preflight,
      abortReason: 'preflight-failed',
    });
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

  // ─── 4. Delegate to executor ─────────────────────────────────────────────
  const execResult = await executeMergeFn(
    {
      featureId: args.featureId,
      sourceBranch: args.sourceBranch,
      targetBranch: args.targetBranch,
      ...(args.taskId !== undefined ? { taskId: args.taskId } : {}),
      strategy: args.strategy,
      ...(args.prId !== undefined ? { prId: args.prId } : {}),
      ...(args.repoRoot !== undefined ? { repoRoot: args.repoRoot } : {}),
    },
    ctx,
  );

  if (!execResult.success) {
    return execResult;
  }

  // ─── 5. Combine results ──────────────────────────────────────────────────
  const execData = execResult.data as {
    phase: 'completed';
    mergeSha: string;
    rollbackSha: string;
  };

  return {
    success: true,
    data: {
      phase: 'completed' as const,
      mergeSha: execData.mergeSha,
      rollbackSha: execData.rollbackSha,
      preflight,
    },
  };
}
