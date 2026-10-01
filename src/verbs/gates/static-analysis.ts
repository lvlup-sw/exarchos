/**
 * Static analysis gate. It runs lint and typecheck through the durable gate producer, which records the gate evidence.
 */

import { runCommandSync } from '../../utils/process.js';
import type { ToolResult } from '../../format.js';
import type { EventStore } from '../../events/store.js';
import { runDurableGateProducer } from './durable-gate-producer.js';
import { runGatePreflight } from '../pure/gate-preflight.js';
import { runStaticAnalysis } from '../pure/static-analysis.js';
import type { RunCommandFn, CommandResult } from '../pure/static-analysis.js';

interface StaticAnalysisArgs {
  readonly featureId: string;
  /**
   * Repository root to analyze. The gate uses a literal path as given.
   * The value `'auto'` resolves to the agent worktree of the calling delegation. When absent, the root is `process.cwd()`.
   */
  readonly repoRoot?: string;
  /**
   * Explicit agent worktree path, which `repoRoot: 'auto'` uses first.
   * When it is absent, `'auto'` uses the latest `worktree.created` event for `taskId`.
   */
  readonly worktreePath?: string;
  readonly taskId?: string;
  readonly branch?: string;
  readonly baseBranch?: string;
  readonly skipLint?: boolean;
  readonly skipTypecheck?: boolean;
}

interface StaticAnalysisResult {
  readonly passed: boolean;
  readonly passCount: number;
  readonly failCount: number;
  readonly skipCount: number;
  readonly report: string;
  /**
   * True when the gate is inconclusive. One cause is no recognized toolchain.
   * The other cause is a constituent check that did not run, because of a missing npm script or a `--skip-*` flag.
   * `passed: false` without `skipped` is a real failure. Callers must treat a skipped gate as inconclusive, not as a pass.
   */
  readonly skipped?: boolean;
  /** Reason code when `skipped` is true ('no-toolchain' | 'constituent-skipped'). */
  readonly skipReason?: string;
  /**
   * True when the gate detected a toolchain but one or more constituent checks did not run.
   * It is distinct from a no-toolchain skip, and it is never a pass.
   */
  readonly degraded?: boolean;
}

/**
 * Adapts `runCommandSync` to the `RunCommandFn` signature of `runStaticAnalysis`.
 * A command that exits with an error gives its status and output, not a throw.
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

/**
 * Runs `runGatePreflight` first. It rejects a missing `eventStore` or `featureId`, and resolves a `repoRoot` of `'auto'`.
 * A `skip` status gives `passed: false` and `skipped: true`, because a skip is inconclusive and never a pass.
 * With this mapping, `normalizeGateVerdict` gives `indeterminate` for a skip.
 */
export async function handleStaticAnalysis(
  args: StaticAnalysisArgs,
  stateDir: string,
  eventStore: EventStore,
): Promise<ToolResult> {
  const pre = await runGatePreflight(
    {
      featureId: args.featureId,
      taskId: args.taskId,
      repoRoot: args.repoRoot,
      worktreePath: args.worktreePath,
      handlerName: 'handleStaticAnalysis',
    },
    eventStore,
  );
  if (!pre.ok) return pre.result;
  const repoRoot = pre.repoRoot;

  return runDurableGateProducer(
    {
      gateClass: 'static-analysis',
      featureId: args.featureId,
      ...(args.taskId ? { taskId: args.taskId } : {}),
      ...(args.branch ? { branch: args.branch } : {}),
      baseRef: args.baseBranch ?? 'main',
      repoRoot,
      stateDir,
      eventStore,
    },
    async () => {
      const analysisResult = runStaticAnalysis({
        repoRoot,
        skipLint: args.skipLint,
        skipTypecheck: args.skipTypecheck,
        runCommand: execCommandRunner,
      });

      if (analysisResult.status === 'error') {
        return {
          success: false,
          error: {
            code: 'SCRIPT_ERROR',
            message: analysisResult.error || 'Static analysis error',
          },
        };
      }

      const skipped = analysisResult.status === 'skip';
      const passed = analysisResult.status === 'pass';
      const degraded = skipped && analysisResult.skipReason === 'constituent-skipped';
      const { passCount, failCount, skipCount, output } = analysisResult;

      const result: StaticAnalysisResult = {
        passed,
        passCount,
        failCount,
        skipCount,
        report: output,
        ...(skipped ? { skipped: true, skipReason: analysisResult.skipReason ?? 'no-toolchain' } : {}),
        ...(degraded ? { degraded: true } : {}),
      };
      return { success: true, data: result };
    },
  );
}
