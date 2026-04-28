// ─── handleMergeOrchestrate — top-level orchestrator handler (T11) ─────────
//
// DR-MO-1 (preflight) + DR-MO-2 (executor) — composes the merge preflight
// composer (T06/T07) with the executor handler (T15) under one coherent
// entry point.
//
// SCOPE — T11 covers the happy path only:
//   • run preflight via the injectable composer
//   • emit `merge.preflight` to the stream (direct append, NOT wrapped in
//     `gate.executed` — the dedicated schema (T03) is top-level so HSM
//     guards / observability can match on it directly)
//   • on preflight pass, delegate to `handleExecuteMerge` and surface its
//     `phase: 'completed'` result with the preflight payload attached.
//
// Out of scope (handled in subsequent tasks):
//   • T12 — preflight-fail abort branch (`phase: 'aborted'`,
//     `abortReason: 'preflight-failed'`).
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

export interface HandleMergeOrchestrateInput extends HandleMergeOrchestrateArgs {
  readonly preflight?: PreflightAdapter;
  readonly executeMerge?: ExecuteMergeAdapter;
  readonly gitExec?: GitExec;
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

  // ─── 3. T12 will own the preflight-fail abort branch ─────────────────────
  if (!preflight.passed) {
    // Out-of-scope for T11. Surface as a structured error so callers do not
    // mistake a preflight failure for success while T12 is in flight.
    return {
      success: false,
      error: {
        code: 'PREFLIGHT_FAILED',
        message: 'merge preflight did not pass; abort branch lands in T12',
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
