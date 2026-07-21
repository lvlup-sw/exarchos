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

import { runCommandSync } from '../utils/process.js';
import type { ToolResult } from '../format.js';
import type { EventStore } from '../event-store/store.js';
import { runDurableGateProducer } from './durable-gate-producer.js';
import { runGatePreflight } from './pure/gate-preflight.js';
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
  readonly branch?: string;
  readonly baseBranch?: string;
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
  /**
   * When `parseError`, WHY: `'spawn-failure'` (the test command could not run)
   * vs `'shape-mismatch'` (ran, output unparseable) — #1537. Unset on clean parse.
   */
  readonly parseFailureKind?: 'spawn-failure' | 'shape-mismatch';
}

// ─── Command Runner Adapter ─────────────────────────────────────────────────

/**
 * OS-level errno codes that mean the child was NEVER created — a true spawn
 * failure (the test command is missing or unrunnable). Restricting the
 * classification to this set keeps a process that DID run from being mislabeled:
 * a non-zero exit carries a numeric `status`, and an output overflow surfaces as
 * `ERR_CHILD_PROCESS_STDIO_MAXBUFFER` (a string `code` with no `status`) even
 * though the suite ran to completion. Both must stay `shape-mismatch`, not
 * `spawn-failure` (#1537 follow-up). Set membership — not "any string code" — is
 * the discriminant.
 */
const SPAWN_ERROR_CODES: ReadonlySet<string> = new Set([
  'ENOENT', // command / file does not exist
  'EACCES', // not permitted to execute the file
  'EPERM', // operation not permitted
  'ENOTDIR', // a path component is not a directory
  'ENOMEM', // could not allocate to fork the child
]);

/**
 * True only for an execFileSync error that means the process never started:
 * no numeric exit `status` AND a recognized OS-level spawn errno (above).
 * Exported so the classification is unit-testable without spawning a real
 * process.
 */
export function isSpawnFailure(err: { status?: number; code?: string }): boolean {
  return (
    typeof err.status !== 'number' &&
    typeof err.code === 'string' &&
    SPAWN_ERROR_CODES.has(err.code)
  );
}

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
    const output = runCommandSync(cmd, args as string[], {
      encoding: 'utf-8',
      cwd: options?.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      // The integration suite is large; allow generous output + time.
      maxBuffer: 64 * 1024 * 1024,
    }) as string;
    return { exitCode: 0, stdout: output, stderr: '' };
  } catch (err: unknown) {
    const execErr = err as { status?: number; code?: string; stdout?: string; stderr?: string };
    // A spawn failure (ENOENT/EACCES/…) has no numeric exit `status` AND carries
    // a recognized OS-level errno — the process never ran. Surface it as
    // `spawnError` so the gate can tell a missing/unrunnable test command apart
    // from a process that ran but whose output we can't trust — a non-zero exit
    // or an `ERR_CHILD_PROCESS_STDIO_MAXBUFFER` overflow stay JSON-shape
    // mismatches, never spawn failures (#1537).
    const spawnFailed = isSpawnFailure(execErr);
    return {
      exitCode: execErr.status ?? (spawnFailed ? 127 : 1),
      stdout: execErr.stdout ?? '',
      stderr: execErr.stderr ?? '',
      ...(spawnFailed ? { spawnError: execErr.code } : {}),
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
  stateDir: string,
  eventStore: EventStore,
  runCommand: RunCommandFn = execCommandRunner,
): Promise<ToolResult> {
  // Preflight (DR-10): fail-fast on a miswired DispatchContext / absent
  // featureId (a missing eventStore is a wiring bug, not a transient error) and
  // resolve the worktree-aware 'auto' repoRoot (#1330, T-04 resolver). taskId is
  // optional for this post-merge gate, so it is not required here.
  const pre = await runGatePreflight(
    {
      featureId: args.featureId,
      taskId: args.taskId,
      repoRoot: args.repoRoot,
      worktreePath: args.worktreePath,
      handlerName: 'handleCheckIntegrationSuite',
    },
    eventStore,
  );
  if (!pre.ok) return pre.result;
  const repoRoot = pre.repoRoot;

  return runDurableGateProducer(
    {
      gateClass: 'integration-suite',
      featureId: args.featureId,
      ...(args.taskId ? { taskId: args.taskId } : {}),
      ...(args.branch ? { branch: args.branch } : {}),
      baseRef: args.baseBranch ?? 'main',
      repoRoot,
      stateDir,
      eventStore,
    },
    async () => {
      // Run the full suite and fold load-failures into the failure count.
      const suite = runIntegrationSuite({
        repoRoot,
        runCommand,
        testScript: args.testScript,
      });

      const result: CheckIntegrationSuiteResult = {
        passed: suite.passed,
        failCount: suite.failCount,
        loadFailures: suite.loadFailures,
        failedTests: suite.failedTests,
        failedSuites: suite.failedSuites,
        totalTests: suite.totalTests,
        report: suite.report,
        parseError: suite.parseError,
        ...(suite.parseFailureKind ? { parseFailureKind: suite.parseFailureKind } : {}),
      };
      return { success: true, data: result };
    },
  );
}
