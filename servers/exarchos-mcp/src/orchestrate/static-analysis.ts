// ─── Static Analysis Composite Action ────────────────────────────────────────
//
// Orchestrates static analysis checks (lint + typecheck) by calling the
// pure TypeScript runStaticAnalysis function and emitting gate.executed events
// for the quality layer.
// ─────────────────────────────────────────────────────────────────────────────

import { execFileSync } from 'node:child_process';
import { resolveExecutable } from '../utils/process.js';
import type { ToolResult } from '../format.js';
import type { EventStore } from '../event-store/store.js';
import { emitGateEvent, resolveRepoRoot } from './gate-utils.js';
import { runStaticAnalysis } from './pure/static-analysis.js';
import type { RunCommandFn, CommandResult } from './pure/static-analysis.js';

// ─── Argument & Result Types ─────────────────────────────────────────────────

interface StaticAnalysisArgs {
  readonly featureId: string;
  /**
   * Repository root to analyze. A literal path is used verbatim; the special
   * value `'auto'` resolves to the calling delegation's agent worktree (#1330);
   * omitting it falls back to `process.cwd()` for non-delegation callers.
   */
  readonly repoRoot?: string;
  /**
   * Explicit agent worktree path. Preferred resolver seam for `repoRoot:'auto'`
   * (threaded by the task-completion runbook in T-05). When absent, `'auto'`
   * falls back to the latest `worktree.created` event for `taskId`.
   */
  readonly worktreePath?: string;
  readonly taskId?: string;
  readonly skipLint?: boolean;
  readonly skipTypecheck?: boolean;
}

interface StaticAnalysisResult {
  readonly passed: boolean;
  readonly passCount: number;
  readonly failCount: number;
  readonly report: string;
  /**
   * True when the gate could not actually run (no recognized toolchain).
   * Distinct from `passed:false` (which means a real failure) — callers
   * should treat skipped gates as inconclusive, not green. See DR-4 in
   * docs/plans/2026-05-04-v290-dogfood-bundle.md.
   */
  readonly skipped?: boolean;
  /** Reason code when `skipped` is true (e.g. 'no-toolchain'). */
  readonly skipReason?: string;
}

// ─── Command Runner Adapter ─────────────────────────────────────────────────

/**
 * Wraps execFileSync to match the RunCommandFn signature expected by
 * the pure TypeScript runStaticAnalysis function.
 */
const execCommandRunner: RunCommandFn = (
  cmd: string,
  args: readonly string[],
  options?: { cwd?: string },
): CommandResult => {
  try {
    const output = execFileSync(resolveExecutable(cmd), args as string[], {
      encoding: 'utf-8',
      cwd: options?.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
    }) as string;
    return { exitCode: 0, stdout: output, stderr: '' };
  } catch (err: unknown) {
    const execErr = err as { status?: number; stdout?: string; stderr?: string };
    return {
      exitCode: execErr.status ?? 1,
      stdout: execErr.stdout ?? '',
      stderr: execErr.stderr ?? '',
    };
  }
};

// ─── Handler ─────────────────────────────────────────────────────────────────

export async function handleStaticAnalysis(
  args: StaticAnalysisArgs,
  _stateDir: string,
  eventStore: EventStore,
): Promise<ToolResult> {
  // Fail-fast on miswired DispatchContext: a missing eventStore here is a
  // wiring bug, not a transient error. Without this guard the fire-and-forget
  // emit below silently swallows the failure and the gate runs without
  // telemetry. See PR #1185 / CR review 4177990662.
  if (!eventStore) {
    return {
      success: false,
      error: {
        code: 'MISWIRED_CONTEXT',
        message: 'handleStaticAnalysis: eventStore is required',
      },
    };
  }

  // Input validation
  if (!args.featureId) {
    return {
      success: false,
      error: { code: 'INVALID_INPUT', message: 'featureId is required' },
    };
  }

  // Resolve repoRoot — supports worktree-aware 'auto' mode (#1330). A literal
  // path or the process.cwd() default is preserved for existing callers.
  const resolved = await resolveRepoRoot(
    {
      repoRoot: args.repoRoot,
      worktreePath: args.worktreePath,
      featureId: args.featureId,
      taskId: args.taskId,
    },
    eventStore,
  );
  if (!resolved.ok) {
    return {
      success: false,
      error: { code: 'INVALID_INPUT', message: resolved.error },
    };
  }
  const repoRoot = resolved.repoRoot;

  // Run the pure TypeScript static analysis function
  const analysisResult = runStaticAnalysis({
    repoRoot,
    skipLint: args.skipLint,
    skipTypecheck: args.skipTypecheck,
    runCommand: execCommandRunner,
  });

  // Map 'error' status to SCRIPT_ERROR response
  if (analysisResult.status === 'error') {
    return {
      success: false,
      error: {
        code: 'SCRIPT_ERROR',
        message: analysisResult.error || 'Static analysis error',
      },
    };
  }

  // T-10 / DR-4: 'skip' status means no recognized toolchain — gate is
  // inconclusive, not green. Map to passed=false + skipped=true so
  // convergence-view can surface it as skipped, and emit the gate event
  // with details.skipped + details.skipReason so projections can render
  // SKIP distinctly from PASS / FAIL.
  const skipped = analysisResult.status === 'skip';
  const passed = analysisResult.status === 'pass';
  const { passCount, failCount, output } = analysisResult;

  // Emit gate.executed event (fire-and-forget: emission failure must not break the gate check)
  try {
    const store = eventStore;
    await emitGateEvent(store, args.featureId, 'static-analysis', 'quality', passed, {
      dimension: 'D2',
      phase: 'delegate',
      passCount,
      failCount,
      ...(skipped ? { skipped: true, skipReason: analysisResult.skipReason ?? 'no-toolchain' } : {}),
      ...(args.taskId ? { taskId: args.taskId } : {}),
    });
  } catch { /* fire-and-forget */ }

  // Return structured result
  const result: StaticAnalysisResult = {
    passed,
    passCount,
    failCount,
    report: output,
    ...(skipped ? { skipped: true, skipReason: analysisResult.skipReason ?? 'no-toolchain' } : {}),
  };

  return { success: true, data: result };
}
