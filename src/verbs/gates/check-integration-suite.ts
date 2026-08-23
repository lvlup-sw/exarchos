// ─── Integration Suite Gate (#1329) ──────────────────────────────────────────
//
// Runs the governed repository's whole test suite against the integration tip
// (worktree-aware repoRoot, #1330 resolver), using the command the LAYERED test
// runtime resolver lands on for that repository — override, `.exarchos.yml`, a
// user-declared toolchain, a committed task runner, then the built-in registry —
// and reading the result through the carrier that repository's runner produces.
//
// On a runner that reports per-suite counts, file-LOAD failures are folded into
// the failure count: a file that fails at IMPORT is counted by vitest as "1
// failed suite / 0 failed tests" — invisible to per-task gates that only inspect
// failed tests — and this gate makes that cascade a hard FAIL. On a runner whose
// only output is an exit code, that code is the verdict, and the carrier says so
// rather than reporting counts nobody measured.
//
// A repository for which no test command resolves gets neither, and neither does
// a run whose process never started or never finished: the gate reports that it
// could not conclude. It never invents a verdict to fill the gap.
// ─────────────────────────────────────────────────────────────────────────────

import { runCommandSync } from '../../utils/process.js';
import type { ToolResult } from '../../format.js';
import type { EventStore } from '../../events/store.js';
import { runDurableGateProducer } from './durable-gate-producer.js';
import { resolveDiffBase } from '../../vcs/resolve-base-branch.js';
import { runGatePreflight } from '../pure/gate-preflight.js';
import {
  runIntegrationSuite,
  type IntegrationCommandResult,
  type IntegrationRunCommandFn,
  type IntegrationSuiteRun,
  type IntegrationSuiteSkipReason,
} from '../pure/integration-suite.js';
import { assertNever } from '../../contract/error-families.js';

// ─── Argument & Result Types ─────────────────────────────────────────────────

interface CheckIntegrationSuiteArgs {
  readonly featureId: string;
  /**
   * Repository root to run the suite against. A literal path is used verbatim;
   * the special value `'auto'` resolves to the calling delegation's agent
   * worktree (#1330, reusing the shared worktree resolver); omitting it falls back to
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
  /**
   * An npm script that emits vitest JSON, for a repository whose script name
   * the resolver cannot know. When absent — the normal case — the command comes
   * from the layered resolver. There is no default: a script name this
   * repository happens to use is not one a governed repository has.
   */
  readonly testScript?: string;
}

/** The carrier for a runner that reports per-suite counts. */
interface CountedSuiteCarrier {
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
   * True when the runner RAN and produced no parseable vitest JSON. The gate
   * fails closed in this case (passed=false, failCount>=1); the flag tells
   * callers the failure stems from unparseable output rather than authoritative
   * counts. A runner that never started does not reach this carrier at all — it
   * is indeterminate, not a failed suite.
   */
  readonly parseError: boolean;
}

/**
 * The carrier for a runner whose only output is an exit code — the majority of
 * the declared toolchains. It carries NO counts, because none were measured;
 * stamping zeros would be the false green the counted carrier exists to stop.
 */
interface ExitCodeSuiteCarrier {
  readonly passed: boolean;
  readonly exitCode: number;
  readonly report: string;
}

/**
 * The carrier for a run that reached no verdict: no test command could be
 * resolved, or the runner never ran to a conclusion.
 *
 * `passed` is ABSENT, deliberately — `false` would name a failure nothing
 * observed and `true` would mint proof nothing produced. `skipped` is the same
 * marker the static-analysis gate stamps, so `normalizeGateVerdict` reads this
 * as `indeterminate` and the durable evidence row records that verdict with its
 * reason.
 *
 * What that row does NOT do, for this gate class, is stop anything: the
 * projection folds it for audit/shadow visibility only, and the admission
 * evaluator that would deny on an indeterminate verdict never adjudicates a
 * `verification-ladder:*` requirement because no edge obligation claims one. The
 * reader that acts is the caller, on the `report` — see the survey on
 * `runIntegrationSuite`, which is where that claim is kept honest.
 */
interface IndeterminateSuiteCarrier {
  readonly skipped: true;
  readonly skipReason: IntegrationSuiteSkipReason;
  readonly reason: string;
  readonly report: string;
}

type CheckIntegrationSuiteResult =
  | CountedSuiteCarrier
  | ExitCodeSuiteCarrier
  | IndeterminateSuiteCarrier;

// ─── Command Runner Adapter ─────────────────────────────────────────────────

/**
 * OS-level errno codes that mean the child was NEVER created — a true spawn
 * failure (the test command is missing or unrunnable). Restricting the
 * classification to this set keeps a process that DID run from being mislabeled:
 * a non-zero exit carries a numeric `status`, and an output overflow surfaces as
 * `ERR_CHILD_PROCESS_STDIO_MAXBUFFER` (a string `code` with no `status`) even
 * though the suite ran to completion. Neither may be read as "never started".
 * Set membership — not "any string code" — is the discriminant.
 *
 * Membership is what decides whether the run is a verdict or an unknown, so a
 * missing member is a silent mis-verdict rather than a missing feature: with
 * `EINVAL` absent the gate read a launch that never happened as a suite that
 * failed.
 */
const SPAWN_ERROR_CODES: ReadonlySet<string> = new Set([
  'ENOENT', // command / file does not exist
  'EACCES', // not permitted to execute the file
  'EPERM', // operation not permitted
  'ENOTDIR', // a path component is not a directory
  'ENOMEM', // could not allocate to fork the child
  // On Windows, `execFile*` refuses to launch a `.cmd`/`.bat` shim directly
  // since the CVE-2024-27980 fix and raises EINVAL — the normal failure shape
  // for a package-manager or task-runner shim that `utils/process.ts` does not
  // recognize as needing a shell. The layered resolver can now name any of those
  // (`task test`, `just test`, `mise run test`), so this arm went from exotic to
  // routine at the same moment the command source widened.
  'EINVAL',
  'ENOEXEC', // the file exists but is not an executable image
  'EAGAIN', // the fork itself was refused (resource limit)
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
 * The wall clock the suite runner is given, in milliseconds.
 *
 * Stated here rather than left to the platform default (there is none —
 * `execFileSync` waits forever), because without a bound a wedged runner wedges
 * the gate, and a gate that never returns is worse than one that reports it
 * could not conclude. Generous on purpose: a real integration suite legitimately
 * runs for many minutes, and a bound this loose can only be reached by a hang.
 */
export const INTEGRATION_SUITE_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * The errno a runner killed for exceeding its time limit reports. It carries no
 * numeric exit `status` (the kill, not the suite, ended it), which is why it can
 * never be read as a verdict.
 */
const TIMEOUT_ERROR_CODE = 'ETIMEDOUT';

/**
 * True for an error that means the runner was killed at its time limit rather
 * than deciding anything. Exported so the classification is unit-testable.
 */
export function isTimeoutFailure(err: { status?: number; code?: string }): boolean {
  return typeof err.status !== 'number' && err.code === TIMEOUT_ERROR_CODE;
}

/**
 * Wraps execFileSync to match the runner seam. A non-zero exit (the suite
 * failed) is returned as a result, not thrown — vitest's JSON summary is still
 * on stdout in that case.
 *
 * @internal Exported so WFQ-003 can prove the real spawn → parse chain without
 * executing the repository's own suite. `timeoutMs` is overridable for the same
 * reason: the kill path is provable against a real child process without
 * waiting out the production bound.
 */
export const execCommandRunner: IntegrationRunCommandFn = (
  cmd: string,
  args: readonly string[],
  options?: { readonly cwd?: string; readonly timeoutMs?: number },
): IntegrationCommandResult => {
  try {
    const output = runCommandSync(cmd, args as string[], {
      encoding: 'utf-8',
      cwd: options?.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      // The integration suite is large; allow generous output + a bounded wall
      // clock, so "could not run" is a producible outcome instead of a hang.
      maxBuffer: 64 * 1024 * 1024,
      timeout: options?.timeoutMs ?? INTEGRATION_SUITE_TIMEOUT_MS,
    }) as string;
    return { exitCode: 0, stdout: output, stderr: '' };
  } catch (err: unknown) {
    const execErr = err as { status?: number; code?: string; stdout?: string; stderr?: string };
    // Killed at the time limit: neither the truncated stdout nor the kill's
    // status says anything about the suite, so the gate must not read either.
    if (isTimeoutFailure(execErr)) {
      return {
        exitCode: execErr.status ?? 124,
        stdout: execErr.stdout ?? '',
        stderr: execErr.stderr ?? '',
        timedOut: true,
      };
    }
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

// ─── Carrier ─────────────────────────────────────────────────────────────────

/**
 * Translate what the run established into the gate's advisory carrier by
 * switching EXHAUSTIVELY on the run's own discriminant.
 *
 * The switch is the point: "the suite could not be run here" has to be handled
 * at this boundary, so it can no longer arrive dressed as a failure with
 * invented counts. `assertNever` fails the build before a future outcome can be
 * folded silently into one of the existing verdicts.
 */
function carrierFor(suite: IntegrationSuiteRun): CheckIntegrationSuiteResult {
  switch (suite.kind) {
    case 'vitest-counts':
      return {
        passed: suite.passed,
        failCount: suite.failCount,
        loadFailures: suite.loadFailures,
        failedTests: suite.failedTests,
        failedSuites: suite.failedSuites,
        totalTests: suite.totalTests,
        report: suite.report,
        parseError: suite.parseError,
      };
    case 'exit-code':
      return { passed: suite.passed, exitCode: suite.exitCode, report: suite.report };
    case 'indeterminate':
      return {
        skipped: true,
        skipReason: suite.skipReason,
        reason: suite.reason,
        report: suite.report,
      };
    default:
      return assertNever(suite, 'IntegrationSuiteRun');
  }
}

// ─── Handler ─────────────────────────────────────────────────────────────────

/**
 * @param runCommand - Injected runner seam (defaults to execFileSync). Tests
 *   pass a stub so the gate is exercisable without running the real suite.
 */
export async function handleCheckIntegrationSuite(
  args: CheckIntegrationSuiteArgs,
  stateDir: string,
  eventStore: EventStore,
  runCommand: IntegrationRunCommandFn = execCommandRunner,
): Promise<ToolResult> {
  // Preflight: fail-fast on a miswired DispatchContext / absent
  // featureId (a missing eventStore is a wiring bug, not a transient error) and
  // resolve the worktree-aware 'auto' repoRoot (#1330). taskId is
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
  const base = await resolveDiffBase(repoRoot, args.baseBranch);

  return runDurableGateProducer(
    {
      gateClass: 'integration-suite',
      featureId: args.featureId,
      ...(args.taskId ? { taskId: args.taskId } : {}),
      ...(args.branch ? { branch: args.branch } : {}),
      // The diff base is a LABEL on the evidence subject here, not a range this
      // gate reads — it runs the whole suite in the tree it was pointed at. So an
      // unresolved base withholds the label rather than yielding Indeterminate:
      // the gate still ran, it just cannot name a base it never used.
      ...(base.kind === 'resolved' ? { baseRef: base.branch } : {}),
      repoRoot,
      stateDir,
      eventStore,
    },
    async () => {
      // Run the suite the detected toolchain declares, read the result through
      // the carrier that toolchain produces, and report only what that carrier
      // can actually establish.
      const suite = runIntegrationSuite({
        repoRoot,
        runCommand,
        testScript: args.testScript,
      });

      return { success: true, data: carrierFor(suite) };
    },
  );
}
