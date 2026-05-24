// ─── Integration Suite Gate (#1329) ──────────────────────────────────────────
//
// Runs the FULL vitest suite against the integration tip (worktree-aware
// repoRoot, #1330 resolver) and folds file-LOAD failures into the failure
// count. A file that fails at IMPORT is counted by vitest as "1 failed suite /
// 0 failed tests" — invisible to per-task gates that only inspect failed
// tests. This gate makes a load cascade a hard FAIL.
//
// Wiring into a runbook is T-07's job; this task only registers the action.
// ─────────────────────────────────────────────────────────────────────────────

import { execFileSync } from 'node:child_process';
import type { ToolResult } from '../format.js';
import type { EventStore } from '../event-store/store.js';
import { emitGateEvent, resolveRepoRoot } from './gate-utils.js';
import { runIntegrationSuite } from './pure/integration-suite.js';
import type { RunCommandFn, CommandResult } from './pure/static-analysis.js';

// ─── Argument & Result Types ─────────────────────────────────────────────────

interface CheckIntegrationSuiteArgs {
  readonly featureId: string;
  /**
   * Repository root to run the suite against. A literal path is used verbatim;
   * the special value `'auto'` resolves to the calling delegation's agent
   * worktree (#1330, reusing the T-04 resolver); omitting it falls back to
   * `process.cwd()` for non-delegation callers. For the post-merge use this
   * should point at the integration tip's worktree.
   */
  readonly repoRoot?: string;
  /**
   * Explicit worktree path. Preferred resolver seam for `repoRoot:'auto'`.
   * When absent, `'auto'` falls back to the latest `worktree.created` event
   * for `taskId`.
   */
  readonly worktreePath?: string;
  readonly taskId?: string;
  /** npm script that emits vitest JSON. Defaults to `test:run`. */
  readonly testScript?: string;
}

interface CheckIntegrationSuiteResult {
  readonly passed: boolean;
  /** failedTests + loadFailures — the load cascade can never read as 0. */
  readonly failCount: number;
  /** Suites that failed before collecting any test (the #1329 cohort). */
  readonly loadFailures: number;
  readonly failedTests: number;
  readonly failedSuites: number;
  readonly totalTests: number;
  readonly report: string;
  /**
   * True when the runner produced no parseable vitest JSON. The gate fails
   * closed in this case (passed=false, failCount>=1); the flag tells callers
   * the failure stems from unparseable output rather than authoritative counts.
   */
  readonly parseError: boolean;
}

// ─── Command Runner Adapter ─────────────────────────────────────────────────

/**
 * Wraps execFileSync to match the RunCommandFn signature. A non-zero exit
 * (the suite failed) is returned as a CommandResult, not thrown — vitest's
 * JSON summary is still on stdout in that case.
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
      // The integration suite is large; allow generous output + time.
      maxBuffer: 64 * 1024 * 1024,
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

/**
 * @param runCommand - Injected runner seam (defaults to execFileSync). Tests
 *   pass a stub so the gate is exercisable without running the real suite.
 */
export async function handleCheckIntegrationSuite(
  args: CheckIntegrationSuiteArgs,
  _stateDir: string,
  eventStore: EventStore,
  runCommand: RunCommandFn = execCommandRunner,
): Promise<ToolResult> {
  // Fail-fast on miswired DispatchContext: a missing eventStore is a wiring
  // bug, not a transient error.
  if (!eventStore) {
    return {
      success: false,
      error: {
        code: 'MISWIRED_CONTEXT',
        message: 'handleCheckIntegrationSuite: eventStore is required',
      },
    };
  }

  if (!args.featureId) {
    return {
      success: false,
      error: { code: 'INVALID_INPUT', message: 'featureId is required' },
    };
  }

  // Resolve repoRoot — worktree-aware 'auto' mode (#1330, T-04 resolver).
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

  // Run the full suite and fold load-failures into the failure count.
  const suite = runIntegrationSuite({
    repoRoot,
    runCommand,
    testScript: args.testScript,
  });

  const passed = suite.passed;

  // Emit gate.executed (fire-and-forget: emission failure must not break the gate).
  try {
    await emitGateEvent(eventStore, args.featureId, 'integration-suite', 'post-merge', passed, {
      phase: 'synthesize',
      failCount: suite.failCount,
      loadFailures: suite.loadFailures,
      failedTests: suite.failedTests,
      failedSuites: suite.failedSuites,
      totalTests: suite.totalTests,
      ...(suite.parseError ? { parseError: true } : {}),
      ...(args.taskId ? { taskId: args.taskId } : {}),
    });
  } catch { /* fire-and-forget */ }

  const result: CheckIntegrationSuiteResult = {
    passed,
    failCount: suite.failCount,
    loadFailures: suite.loadFailures,
    failedTests: suite.failedTests,
    failedSuites: suite.failedSuites,
    totalTests: suite.totalTests,
    report: suite.report,
    parseError: suite.parseError,
  };

  return { success: true, data: result };
}
