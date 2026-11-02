/**
 * Static analysis gate. It runs the checks of the verification profile through the durable gate producer, which records the gate evidence.
 * A segment reads the profile that the capsule pins. A direct call resolves the profile live at its root.
 */

import { runCommandSync, execFailureFields, outputText } from '../../utils/process.js';
import type { ToolResult } from '../../format.js';
import type { EventStore } from '../../events/store.js';
import { loadExarchosConfigOutcome, type ExarchosConfigOutcome } from '../../config/load-exarchos-config.js';
import { PROFILE_UNRESOLVED } from '../../workflow/verification/profile.js';
import { runDurableGateProducer, type GateSubjectScope } from './durable-gate-producer.js';
import {
  profileOf,
  profilePathOf,
  withProfileRoute,
  type GateCarrierVerdict,
  type ProfiledGateArgs,
} from './gate-utils.js';
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

interface StaticAnalysisArgs extends ProfiledGateArgs {
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
   * True when the gate is inconclusive. One cause is a term that the profile does not resolve.
   * The other cause is a constituent check that a skip flag skipped.
   * `passed: false` without `skipped` is a real failure. Callers must treat a skipped gate as inconclusive, not as a pass.
   */
  readonly skipped?: boolean;
  /** Reason code when `skipped` is true ('profile-unresolved' | 'constituent-skipped' | 'repo-root-missing'). */
  readonly skipReason?: string;
  /**
   * The reason code of a skip again, because the gate runner copies only `discriminant` and `reason` into the `gate.executed` row.
   * `task_complete` reads it to tell an unresolved term from a skipped check.
   */
  readonly discriminant?: StaticAnalysisSkipReason;
  /** The cause of a skip as text. It names each check that did not run, or each term that the profile does not resolve. */
  readonly reason?: string;
  /**
   * True when a check did not run or gave no verdict.
   * With `skipped: true`, a skip flag skipped a constituent check. That is distinct from a `profile-unresolved` skip, and it is never a pass.
   * Without `skipped`, an advisory check gave no verdict. `advisorySkips` names it, and `passed` is the verdict of the other checks.
   *
   * It is the older flag, and its values stay for stored rows and readers. `completeness` covers advisory checks only.
   * Thus a constituent-skipped run with no advisory skip states `degraded: true` and `completeness: 'complete'`.
   * A constituent-skipped run with an advisory skip states `completeness: 'degraded'` and names the advisory skip.
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

/** The text of a skip cause. It names each unresolved term, each check that did not run and its cause, or the missing root. */
function skipCauseText(skipReason: StaticAnalysisSkipReason, analysisResult: StaticAnalysisRun): string {
  if (skipReason === PROFILE_UNRESOLVED) {
    return analysisResult.unresolvedReason ?? 'the profile resolved no static-analysis check';
  }
  if (skipReason === 'no-toolchain') return 'no supported static-analysis toolchain in the scanned directory';
  if (skipReason === 'repo-root-missing') return 'the call named a task and no repoRoot, so the run scanned nothing';
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
  const skipReason = analysisResult.skipReason ?? PROFILE_UNRESOLVED;
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
 * The boundary scope of one config read: the `ownership.firstParty` globs of the `.exarchos.yml`.
 * No `.exarchos.yml`, or a file with no globs, gives no globs, and the boundary leg then uses the schema default.
 * A file that does not load or cannot be read gives the failure, and the boundary leg then fails with the file and the error.
 */
function boundaryScopeOf(outcome: ExarchosConfigOutcome): Pick<StaticAnalysisInput, 'firstPartyGlobs' | 'projectConfigError'> {
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
 * The run of a task call with no `repoRoot`. It is a skip that scans nothing, because no directory is known to be the
 * worktree of the task. The report names the rerun that records a verdict for the task.
 */
function repoRootMissingRun(taskId: string): StaticAnalysisRun {
  return {
    status: 'skip',
    skipReason: 'repo-root-missing',
    output: [
      '## Static Analysis Report',
      '',
      `**Result: SKIP**. The call named task '${taskId}' and no repoRoot, so the run scanned nothing.`,
      "Run check_static_analysis again with repoRoot 'auto' and the worktreePath of the task.",
    ].join('\n'),
    passCount: 0,
    failCount: 0,
    skipCount: 0,
  };
}

/**
 * Runs the checks of the profile at `repoRoot`. The worktree config gives the boundary scope, and a direct call resolves the profile with the same read.
 * Each term goes to `runStaticAnalysis` resolved or not, and that function decides the skip.
 */
function runProfiledAnalysis(args: StaticAnalysisArgs, repoRoot: string): StaticAnalysisRun {
  const outcome = loadExarchosConfigOutcome(repoRoot);
  return runStaticAnalysis({
    repoRoot,
    skipLint: args.skipLint,
    skipTypecheck: args.skipTypecheck,
    checks: profileOf(args, repoRoot, { loadConfig: () => outcome }).staticAnalysis,
    profilePath: profilePathOf(args, repoRoot),
    withRoute: (reason) => withProfileRoute(args, reason),
    ...boundaryScopeOf(outcome),
    runCommand: execCommandRunner,
  });
}

/**
 * Runs `runGatePreflight` first. It rejects a missing `eventStore` or `featureId`, and resolves a `repoRoot` of `'auto'`.
 * The provider maps the run through `staticAnalysisCarrier`.
 *
 * A call with a `taskId` and no `repoRoot` does not scan the server directory. It records the skip `repo-root-missing`
 * through the producer, and the runner row names no tree. A call with no `taskId` keeps the `process.cwd()` default.
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
  const missing = args.taskId && !args.repoRoot ? repoRootMissingRun(args.taskId) : undefined;
  const repoRoot = missing === undefined ? pre.repoRoot : '';

  return runDurableGateProducer(
    { ...staticAnalysisSubjectScope(args, repoRoot), stateDir, eventStore, unscanned: missing !== undefined },
    async () => staticAnalysisCarrier(missing ?? runProfiledAnalysis(args, repoRoot)),
  );
}
