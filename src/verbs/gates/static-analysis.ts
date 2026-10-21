/**
 * Static analysis gate. It runs lint and typecheck through the durable gate producer, which records the gate evidence.
 */

import { runCommandSync, execFailureFields, outputText } from '../../utils/process.js';
import type { ToolResult } from '../../format.js';
import type { EventStore } from '../../events/store.js';
import { loadExarchosConfigOutcome } from '../../config/load-exarchos-config.js';
import { runDurableGateProducer, type GateSubjectScope } from './durable-gate-producer.js';
import type { GateCarrierVerdict } from './gate-utils.js';
import { runGatePreflight } from '../pure/gate-preflight.js';
import { runStaticAnalysis } from '../pure/static-analysis.js';
import type {
  AdvisorySkip,
  RunCommandFn,
  CommandResult,
  StaticAnalysisInput,
  StaticAnalysisResult as StaticAnalysisRun,
  StaticAnalysisSkipReason,
} from '../pure/static-analysis.js';

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

/**
 * The completeness of a static-analysis carrier. A `degraded` carrier names each advisory check that gave no verdict.
 * A `complete` carrier has no such check, so it carries no list.
 */
export type StaticAnalysisCompleteness =
  | { readonly completeness: 'complete'; readonly advisorySkips?: never }
  | { readonly completeness: 'degraded'; readonly advisorySkips: readonly [AdvisorySkip, ...AdvisorySkip[]] };

/**
 * The fields of the static-analysis carrier beside its completeness.
 * `verdict` is the closed gate verdict: `pass`, `fail`, or `indeterminate` for a skip. It has the shape of the adequacy carrier.
 */
interface StaticAnalysisCarrierFields {
  readonly verdict: GateCarrierVerdict;
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
   * The reason code of a skip again, because the gate runner copies only `discriminant` and `reason` into the `gate.executed` row.
   * `task_complete` reads it to tell a missing toolchain from a skipped check.
   */
  readonly discriminant?: StaticAnalysisSkipReason;
  /** The cause of a skip as text. It names each check that did not run, or the missing toolchain. */
  readonly reason?: string;
  /**
   * True when a check did not run or gave no verdict.
   * With `skipped: true`, a constituent check did not run. That is distinct from a no-toolchain skip, and it is never a pass.
   * Without `skipped`, an advisory check gave no verdict. `advisorySkips` names it, and `passed` is the verdict of the other checks.
   *
   * It is the older flag, and its values stay for stored rows and readers. `completeness` covers advisory checks only.
   * Thus a constituent-skipped run states `degraded: true` and `completeness: 'complete'`.
   */
  readonly degraded?: boolean;
}

/**
 * The carrier of the static-analysis gate. It states the closed verdict and the completeness, as the adequacy carrier does.
 * The runner copies the completeness and the advisory skips into the `gate.executed` row, so settle and other readers see them.
 */
export type StaticAnalysisCarrier = StaticAnalysisCarrierFields & StaticAnalysisCompleteness;

/** The output limit of one command. A boundary JSON report of this repository is about 2 MB, more than the default of 1 MiB. */
const MAX_COMMAND_OUTPUT_BYTES = 64 * 1024 * 1024;

/**
 * Adapts `runCommandSync` to the `RunCommandFn` signature of `runStaticAnalysis`.
 * A command that exits with an error gives its status and output, not a throw.
 * A process with no exit status, because it did not start or a signal stopped it, gives exit 1.
 * The result also carries the signal, and the error code of the runner as `spawnError`, such as `ENOENT` or `ENOBUFS`.
 *
 * @internal Exported so that a test can run real processes through it.
 */
export const execCommandRunner: RunCommandFn = (
  cmd: string,
  args: readonly string[],
  options?: { cwd?: string },
): CommandResult => {
  try {
    const output = runCommandSync(cmd, args, {
      encoding: 'utf-8',
      cwd: options?.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      maxBuffer: MAX_COMMAND_OUTPUT_BYTES,
    });
    return { exitCode: 0, stdout: outputText(output), stderr: '' };
  } catch (err: unknown) {
    const failure = execFailureFields(err);
    return {
      exitCode: typeof failure.status === 'number' ? failure.status : 1,
      stdout: outputText(failure.stdout),
      stderr: outputText(failure.stderr),
      ...(typeof failure.signal === 'string' ? { signal: failure.signal } : {}),
      ...(typeof failure.code === 'string' ? { spawnError: failure.code } : {}),
    };
  }
};

/**
 * The fields of one static-analysis run that select its evidence subject. The base defaults to `main`.
 *
 * The task_complete reader uses it to tell a run of the runbook step from other runs.
 * The static-analysis seed of the tests derives its subject from it.
 */
export function staticAnalysisSubjectScope(
  args: Pick<StaticAnalysisArgs, 'featureId' | 'taskId' | 'branch' | 'baseBranch'>,
  repoRoot: string,
): GateSubjectScope {
  return {
    gateClass: 'static-analysis',
    featureId: args.featureId,
    ...(args.taskId ? { taskId: args.taskId } : {}),
    ...(args.branch ? { branch: args.branch } : {}),
    baseRef: args.baseBranch ?? 'main',
    repoRoot,
  };
}

/** The text of a skip cause. It names each check that did not run and its cause, or the missing toolchain. */
function skipCauseText(skipReason: StaticAnalysisSkipReason, analysisResult: StaticAnalysisRun): string {
  if (skipReason === 'no-toolchain') return 'no supported static-analysis toolchain in the scanned directory';
  const checks = (analysisResult.skippedChecks ?? []).map(({ name, detail }) =>
    detail === undefined ? `${name} did not run` : `${name} did not run (${detail})`,
  );
  return checks.length === 0 ? 'a check did not run' : checks.join(', ');
}

/** The closed verdict of a run status. A skip gives no proof and no finding, so it is `indeterminate`. */
function verdictOfStatus(status: 'pass' | 'fail' | 'skip'): GateCarrierVerdict {
  switch (status) {
    case 'pass':
      return 'pass';
    case 'fail':
      return 'fail';
    case 'skip':
      return 'indeterminate';
  }
}

/** The completeness of a run. Each advisory check that gave no verdict makes the run `degraded`. */
function completenessOf(advisorySkips: readonly AdvisorySkip[] | undefined): StaticAnalysisCompleteness {
  const [first, ...rest] = advisorySkips ?? [];
  return first === undefined
    ? { completeness: 'complete' }
    : { completeness: 'degraded', advisorySkips: [first, ...rest] };
}

/**
 * Maps one run of `runStaticAnalysis` to the carrier of the gate. An `error` status gives `SCRIPT_ERROR`.
 * A `skip` status gives `passed: false`, `skipped: true` and the verdict `indeterminate`, because a skip is never a pass.
 * A skip also sets `discriminant` and `reason`, which the gate runner copies into the `gate.executed` row.
 * An advisory check with no verdict gives the completeness `degraded` with its cause, which the runner copies too.
 * The handler and the static-analysis seed of the tests both call this function, so the two carriers agree.
 */
export function staticAnalysisCarrier(analysisResult: StaticAnalysisRun): ToolResult {
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
  const skipReason = analysisResult.skipReason ?? 'no-toolchain';
  const { passCount, failCount, skipCount, output } = analysisResult;
  const completeness = completenessOf(analysisResult.advisorySkips);
  const degraded = (skipped && skipReason === 'constituent-skipped') || completeness.completeness === 'degraded';

  const result: StaticAnalysisCarrier = {
    verdict: verdictOfStatus(analysisResult.status),
    passed,
    passCount,
    failCount,
    skipCount,
    report: output,
    ...(skipped
      ? { skipped: true, skipReason, discriminant: skipReason, reason: skipCauseText(skipReason, analysisResult) }
      : {}),
    ...(degraded ? { degraded: true } : {}),
    ...completeness,
  };
  return { success: true, data: result };
}

/**
 * Reads the boundary scope of the project at `repoRoot`: the `ownership.firstParty` globs of its `.exarchos.yml`.
 * No `.exarchos.yml`, or a file with no globs, gives no globs, and the boundary leg then uses the schema default.
 * A file that does not load or cannot be read gives the failure, and the boundary leg then fails with the file and the error.
 */
function readBoundaryScope(repoRoot: string): Pick<StaticAnalysisInput, 'firstPartyGlobs' | 'projectConfigError'> {
  const outcome = loadExarchosConfigOutcome(repoRoot);
  switch (outcome.kind) {
    case 'absent':
      return {};
    case 'loaded':
      return { firstPartyGlobs: outcome.result.config.ownership?.firstParty };
    case 'invalid':
      return { projectConfigError: { source: outcome.source, message: outcome.message } };
  }
}

/**
 * Runs `runGatePreflight` first. It rejects a missing `eventStore` or `featureId`, and resolves a `repoRoot` of `'auto'`.
 * The provider maps the run through `staticAnalysisCarrier`.
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
    { ...staticAnalysisSubjectScope(args, repoRoot), stateDir, eventStore },
    async () =>
      staticAnalysisCarrier(
        runStaticAnalysis({
          repoRoot,
          skipLint: args.skipLint,
          skipTypecheck: args.skipTypecheck,
          ...readBoundaryScope(repoRoot),
          runCommand: execCommandRunner,
        }),
      ),
  );
}
