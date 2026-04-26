// ─── Static Analysis Composite Action ────────────────────────────────────────
//
// Orchestrates static analysis checks (lint + typecheck) by calling the
// pure TypeScript runStaticAnalysis function and emitting gate.executed events
// for the quality layer.
// ─────────────────────────────────────────────────────────────────────────────

import { execFileSync } from 'node:child_process';
import type { ToolResult } from '../format.js';
import type { EventStore } from '../event-store/store.js';
import { emitGateEvent } from './gate-utils.js';
import { runStaticAnalysis } from './pure/static-analysis.js';
import type { RunCommandFn, CommandResult } from './pure/static-analysis.js';

// ─── Argument & Result Types ─────────────────────────────────────────────────

interface StaticAnalysisArgs {
  readonly featureId: string;
  readonly repoRoot?: string;
  readonly taskId?: string;
  readonly skipLint?: boolean;
  readonly skipTypecheck?: boolean;
}

interface StaticAnalysisResult {
  readonly passed: boolean;
  readonly passCount: number;
  readonly failCount: number;
  readonly report: string;
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
    const output = execFileSync(cmd, args as string[], {
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
  // Input validation
  if (!args.featureId) {
    return {
      success: false,
      error: { code: 'INVALID_INPUT', message: 'featureId is required' },
    };
  }

  const repoRoot = args.repoRoot || process.cwd();

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
      ...(args.taskId ? { taskId: args.taskId } : {}),
    });
  } catch { /* fire-and-forget */ }

  // Return structured result
  const result: StaticAnalysisResult = {
    passed,
    passCount,
    failCount,
    report: output,
  };

  return { success: true, data: result };
}
