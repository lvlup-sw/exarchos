/**
 * check_integration_suite: runs the vitest suite against the integration tip
 * and adds file load failures to the failure count. Vitest counts a file that
 * fails at import as one failed suite with zero failed tests. A gate that reads
 * only failed tests misses it, so this gate fails on a load failure.
 */

import { runCommandSync } from '../../utils/process.js';
import type { ToolResult } from '../../format.js';
import type { EventStore } from '../../events/store.js';
import { runDurableGateProducer } from './durable-gate-producer.js';
import { runGatePreflight } from '../pure/gate-preflight.js';
import { runIntegrationSuite } from '../pure/integration-suite.js';
import type { RunCommandFn, CommandResult } from '../pure/static-analysis.js';

interface CheckIntegrationSuiteArgs {
  readonly featureId: string;
  /**
   * The repository root for the suite. The gate uses a literal path as given.
   * `'auto'` resolves to the agent worktree of the calling delegation. When
   * absent, the gate uses `process.cwd()`. After a merge, it must point at the
   * worktree of the integration tip.
   */
  readonly repoRoot?: string;
  /**
   * The explicit worktree path, which `repoRoot:'auto'` uses first. When it is
   * absent, `'auto'` uses the latest `worktree.created` event for `taskId`.
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
  /** Suites that failed before they collected a test. */
  readonly loadFailures: number;
  readonly failedTests: number;
  readonly failedSuites: number;
  readonly totalTests: number;
  readonly report: string;
  /**
   * True when the runner gave no vitest JSON that the gate can parse. The gate
   * then fails closed with `passed=false` and `failCount>=1`. The flag tells
   * callers that the counts are not authoritative.
   */
  readonly parseError: boolean;
  /**
   * The cause of a `parseError`. `'spawn-failure'` means that the test command
   * did not start. `'shape-mismatch'` means that it ran, but the gate cannot
   * parse the output. Unset on a clean parse.
   */
  readonly parseFailureKind?: 'spawn-failure' | 'shape-mismatch';
}

/**
 * OS errno codes that mean the child process did not start: `ENOENT` (no such
 * file), `EACCES` and `EPERM` (no permission), `ENOTDIR` (a path part is not a
 * directory), and `ENOMEM` (no memory to fork). A process that ran stays a
 * `shape-mismatch`. This includes an output overflow, which gives the string
 * code `ERR_CHILD_PROCESS_STDIO_MAXBUFFER` and no `status`.
 */
const SPAWN_ERROR_CODES: ReadonlySet<string> = new Set([
  'ENOENT',
  'EACCES',
  'EPERM',
  'ENOTDIR',
  'ENOMEM',
]);

/**
 * True only for an execFileSync error that means the process did not start:
 * no numeric exit `status` and a code in {@link SPAWN_ERROR_CODES}. Exported
 * for unit tests.
 */
export function isSpawnFailure(err: { status?: number; code?: string }): boolean {
  return (
    typeof err.status !== 'number' &&
    typeof err.code === 'string' &&
    SPAWN_ERROR_CODES.has(err.code)
  );
}

/**
 * Wraps `runCommandSync` to match the RunCommandFn signature. It returns a non-zero
 * exit as a CommandResult and does not throw, because the vitest JSON summary
 * is still on stdout. A spawn failure sets `spawnError`, so the gate can tell
 * a missing test command apart from a process that ran. The 64 MiB `maxBuffer`
 * holds the output of a large suite.
 *
 * @internal Exported so a test can run the real spawn and parse chain without
 * the suite of this repository.
 */
export const execCommandRunner: RunCommandFn = (
  cmd: string,
  args: readonly string[],
  options?: { cwd?: string },
): CommandResult => {
  try {
    const output = runCommandSync(cmd, args as string[], {
      encoding: 'utf-8',
      cwd: options?.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      maxBuffer: 64 * 1024 * 1024,
    }) as string;
    return { exitCode: 0, stdout: output, stderr: '' };
  } catch (err: unknown) {
    const execErr = err as { status?: number; code?: string; stdout?: string; stderr?: string };
    const spawnFailed = isSpawnFailure(execErr);
    return {
      exitCode: execErr.status ?? (spawnFailed ? 127 : 1),
      stdout: execErr.stdout ?? '',
      stderr: execErr.stderr ?? '',
      ...(spawnFailed ? { spawnError: execErr.code } : {}),
    };
  }
};

/**
 * Runs the shared gate preflight, then runs the suite inside the durable gate
 * producer. The preflight rejects a miswired event store and an absent
 * `featureId`, and resolves `repoRoot`. `taskId` is optional for this gate.
 *
 * @param runCommand - The runner, {@link execCommandRunner} by default. Tests pass a stub.
 */
export async function handleCheckIntegrationSuite(
  args: CheckIntegrationSuiteArgs,
  stateDir: string,
  eventStore: EventStore,
  runCommand: RunCommandFn = execCommandRunner,
): Promise<ToolResult> {
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
