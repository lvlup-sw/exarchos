/**
 * Static analysis gate: runs the checks of the verification profile for the
 * review workflow and reports a structured result. The caller injects the
 * command runner as a `RunCommandFn`.
 *
 * Status values:
 *   - `pass`: every check ran and passed. Warnings are allowed.
 *   - `fail`: one or more checks failed.
 *   - `skip`: the result is inconclusive. `skipReason` is `profile-unresolved`
 *     when the profile does not resolve a check, or `constituent-skipped` when
 *     a skip flag skipped a check and no check failed.
 *   - `error`: a usage error, such as a missing or invalid repo root.
 *
 * An advisory check that gives no verdict does not change the status. The
 * report names it and marks the result degraded.
 */

import * as fs from 'node:fs';
import {
  boundaryChecksAt,
  runBoundaryCheck,
  type BoundaryLintResult,
  type RawIoTaintResult,
} from '../../config/boundary-adapters.js';
import { detectToolchain } from '../../config/toolchains.js';
import { staticAnalysisSeedsAt } from '../../config/verification-profile.js';
import type { ExarchosConfigLoadFailure } from '../../config/load-exarchos-config.js';
import { PROFILE_UNRESOLVED, type VerificationProfile } from '../../workflow/verification/profile.js';
import { capFailDetail } from './fail-detail.js';

/** Result of running an external command. */
export interface CommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  /**
   * The error code of the process runner. The command did not start (ENOENT,
   * EACCES), or the runner stopped it (ENOBUFS when the output passed the
   * buffer limit, ETIMEDOUT when the run passed its time limit). Then `exitCode`
   * and `stdout` are not authoritative. The integration-suite gate reads it
   * before the exit code, so such an end cannot read as a red exit.
   */
  readonly spawnError?: string;
  /**
   * The signal that stopped the process, such as `SIGKILL`. Then `exitCode` is
   * not the exit status of the tool.
   */
  readonly signal?: string;
}

/**
 * Signature of the external command runner, so that tests can inject a fake.
 * `timeoutMs` replaces the time limit of a runner that has one. A test sets it to drive a timeout with a real process.
 */
export type RunCommandFn = (
  cmd: string,
  args: readonly string[],
  options?: { cwd?: string; timeoutMs?: number }
) => CommandResult;

/** The static-analysis term of the verification profile. */
type StaticAnalysisTerm = VerificationProfile['staticAnalysis'];

/** One check of a resolved static-analysis term. */
type ProfileCheck = Extract<StaticAnalysisTerm, { state: 'resolved' }>['checks'][number];

export interface StaticAnalysisInput {
  /** Repository root to analyze. */
  readonly repoRoot: string;
  /** Skip the check named `lint`. */
  readonly skipLint?: boolean | undefined;
  /** Skip the check named `typecheck`. */
  readonly skipTypecheck?: boolean | undefined;
  /**
   * The static-analysis term of the profile. The gate runs its checks in their order, and it runs no other check.
   * When absent, the gate takes the seeds of `repoRoot`.
   */
  readonly checks?: StaticAnalysisTerm | undefined;
  /**
   * The `boundaryChecks` term of the profile. Each entry gives one advisory leg, in list order, and no other leg runs.
   * When absent, the gate takes the seeds of `repoRoot`.
   */
  readonly boundaryChecks?: VerificationProfile['boundaryChecks'] | undefined;
  /** The words that name the source of the profile. The report names them, and the reason of a `profile-unresolved` skip starts with them. */
  readonly profilePath?: string | undefined;
  /** Adds the route of a remedy to the reason of an unresolved term. */
  readonly withRoute?: ((reason: string) => string) | undefined;
  /**
   * The `ownership.firstParty` globs of the project. The import-boundary leg
   * scans the source root of each glob that exists. A glob whose walk stops at
   * its first segment widens the scan to the repository root. The leg does not
   * apply a negated glob. When absent, the leg uses the schema default.
   */
  readonly firstPartyGlobs?: readonly string[] | undefined;
  /**
   * The reason of a pinned `firstParty` term that does not resolve. The import-boundary leg then has no scope,
   * so it fails and names the reason. It does not scan the default roots.
   */
  readonly unresolvedFirstParty?: string | undefined;
  /**
   * The `.exarchos.yml` of the project that exists and does not load or cannot
   * be read. The import-boundary leg then has no scope, so it fails and names
   * the file and the error. It does not scan the default roots.
   */
  readonly projectConfigError?: ExarchosConfigLoadFailure | undefined;
  /** External command runner (dependency injection). */
  readonly runCommand: RunCommandFn;
}

/** Returns the listed names as a tuple of literal types, so one list can feed each closed type and each reader of every name. */
function closedNames<const Names extends readonly [string, ...string[]]>(...names: Names): Names {
  return names;
}

/**
 * Each cause of an advisory leg run that gave no verdict, in one list. Each cause is a fault outside the repository.
 * - `missing-tool`: the tool or its interpreter is not installed.
 * - `did-not-start`: the runner did not start the tool.
 * - `signal`: a signal stopped the tool.
 * - `out-of-memory`: the tool ran out of heap.
 * - `output-limit`: the output passed the buffer limit of the runner.
 */
export const PROCESS_NO_VERDICT_CAUSES = closedNames(
  'missing-tool',
  'did-not-start',
  'signal',
  'out-of-memory',
  'output-limit',
);

/** Why a run of an advisory leg gave no verdict. */
export type ProcessNoVerdictCause = (typeof PROCESS_NO_VERDICT_CAUSES)[number];

/**
 * Each cause of an import-boundary leg with no verdict, in one list: a cause of the run, or a scan that had nothing to check.
 * - `no-source-root`: no `ownership.firstParty` glob names an existing path.
 * - `zero-modules`: the report says that the scan checked no module.
 * A reader that needs every cause, such as a test table, reads this list.
 */
export const BOUNDARY_NO_VERDICT_CAUSES = closedNames(...PROCESS_NO_VERDICT_CAUSES, 'no-source-root', 'zero-modules');

/** Why the import-boundary leg gave no verdict. */
export type BoundaryNoVerdictCause = (typeof BOUNDARY_NO_VERDICT_CAUSES)[number];

/**
 * An advisory check that applies to the repository but gave no verdict. An
 * example is an import-boundary scan that ran out of memory.
 */
export interface AdvisorySkip {
  readonly name: string;
  /** The closed cause code of the leg. */
  readonly cause: BoundaryNoVerdictCause;
  /** The cause, for the report and the reviewer. */
  readonly detail: string;
}

/**
 * Reason code for a `skip` status.
 * - `profile-unresolved`: the profile does not resolve the static-analysis term or one of its checks.
 *   The result is inconclusive and cannot be a pass.
 * - `no-toolchain`: a code of an earlier build. The gate no longer writes it, and `task_complete` reads it as `profile-unresolved`.
 * - `constituent-skipped`: a skip flag skipped a check. The result is inconclusive and cannot be a pass.
 * - `repo-root-missing`: the call named a task and no `repoRoot`. The gate
 *   handler scans nothing, because no directory is the worktree of the task.
 */
export type StaticAnalysisSkipReason =
  | typeof PROFILE_UNRESOLVED
  | 'no-toolchain'
  | 'constituent-skipped'
  | 'repo-root-missing';

/** One check that did not run, with the cause that the report names for it. */
export interface StaticAnalysisSkippedCheck {
  /** The report label of the check, for example `Lint`. */
  readonly name: string;
  /** Why the check did not run, for example a skip flag or the reason of an unresolved term. */
  readonly detail?: string;
}

export interface StaticAnalysisResult {
  /**
   * Overall status.
   * - `pass`: every counted check ran and passed. One skipped check prevents
   *   this value. An advisory check with no verdict does not, see `advisorySkips`.
   * - `fail`: one or more checks failed.
   * - `skip`: inconclusive, see `skipReason`. A profile that does not resolve
   *   a check, or a check that a flag skipped, is not reported as a pass.
   * - `error`: a usage error, such as a missing or invalid repo root.
   */
  readonly status: 'pass' | 'fail' | 'skip' | 'error';
  /** Structured markdown report. */
  readonly output: string;
  /** Error message when status is 'error'. */
  readonly error?: string;
  /** Reason code when status is 'skip'. */
  readonly skipReason?: StaticAnalysisSkipReason;
  /** The checks that did not run, when `skipReason` is `constituent-skipped` or `profile-unresolved`. */
  readonly skippedChecks?: readonly StaticAnalysisSkippedCheck[];
  /**
   * The cause of a `profile-unresolved` skip. It starts with the profile path when the caller gives one.
   * It then names each unresolved term and its keys, and the route of a remedy.
   */
  readonly unresolvedReason?: string;
  /** Number of checks that passed. */
  readonly passCount: number;
  /** Number of checks that failed. */
  readonly failCount: number;
  /**
   * Number of checks that did not run, because of an unresolved term or a skip
   * flag. A non-zero count prevents `pass`.
   */
  readonly skipCount: number;
  /** The registry label of the first matched toolchain (undefined if no toolchain matches). */
  readonly projectType?: string | undefined;
  /**
   * The advisory checks that apply but gave no verdict. They do not change
   * `status` and are not in `skipCount`. The report lists each one and marks
   * the result degraded. The field is absent when the list is empty.
   */
  readonly advisorySkips?: readonly AdvisorySkip[];
}

type CheckStatus = 'PASS' | 'FAIL' | 'SKIP';

interface CheckResult {
  readonly name: string;
  readonly status: CheckStatus;
  readonly detail?: string;
  /** True on the SKIP of a term that the profile does not resolve. The SKIP of a skip flag does not set it. */
  readonly unresolved?: true;
}

/** The report label of a check: its key with a first capital letter. */
function checkLabel(name: string): string {
  return `${name.charAt(0).toUpperCase()}${name.slice(1)}`;
}

/** The skip flag that skips the check of `name`, or undefined when no flag skips it. */
function skipFlagOf(name: string, input: StaticAnalysisInput): 'skipLint' | 'skipTypecheck' | undefined {
  if (name === 'lint' && input.skipLint === true) return 'skipLint';
  if (name === 'typecheck' && input.skipTypecheck === true) return 'skipTypecheck';
  return undefined;
}

/**
 * Runs one resolved argv in the repository root. Exit 0 is a PASS, and any other end is a FAIL.
 * The detail of a FAIL is the capped output of the command, and the rerun text of the cap is the argv.
 */
function runArgv(name: string, argv: readonly string[], input: StaticAnalysisInput): CheckResult {
  const [program = '', ...args] = argv;
  const rerun = argv.join(' ');
  try {
    const result = input.runCommand(program, args, { cwd: input.repoRoot });
    if (result.exitCode === 0) {
      return { name, status: 'PASS' };
    }
    const detail = capFailDetail(result.stderr.trim() || result.stdout.trim() || `${rerun} failed`, rerun);
    return { name, status: 'FAIL', detail };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { name, status: 'FAIL', detail: message };
  }
}

/**
 * Runs one check of the profile. An unresolved check is a SKIP that names its keys, also when a skip flag names it.
 * Thus a flag cannot hide a check that the profile does not resolve.
 */
function runProfileCheck(check: ProfileCheck, input: StaticAnalysisInput): CheckResult {
  const name = checkLabel(check.name);
  if (check.command.state === 'unresolved') {
    return { name, status: 'SKIP', detail: check.command.reason, unresolved: true };
  }
  const flag = skipFlagOf(check.name, input);
  if (flag !== undefined) return { name, status: 'SKIP', detail: `skipped by the ${flag} flag` };
  return runArgv(name, check.command.argv, input);
}

/** Runs the term of the profile. An unresolved term is one SKIP that names its keys. */
function runProfileTerm(term: StaticAnalysisTerm, input: StaticAnalysisInput): CheckResult[] {
  if (term.state === 'unresolved') {
    return [{ name: 'Static analysis', status: 'SKIP', detail: term.reason, unresolved: true }];
  }
  return term.checks.map((check) => runProfileCheck(check, input));
}

/**
 * The note that the result line gets when advisory checks gave no verdict.
 * It is empty when every advisory check that applies gave a verdict.
 */
function advisorySkipNote(advisorySkips: readonly AdvisorySkip[]): string {
  const count = advisorySkips.length;
  if (count === 0) return '';
  return `, degraded: ${count} advisory ${count === 1 ? 'check' : 'checks'} gave no verdict`;
}

/**
 * Adds the result of an advisory leg to the report. `PASS` and `FAIL` are counted checks. `NO_VERDICT` goes to
 * `advisorySkips`, and the status does not change. `NOT_CONFIGURED` adds nothing, so a repo without the config
 * of the leg sees no change. The switch is exhaustive, so a new member of a leg result is a compile error here.
 */
function foldAdvisoryLeg(
  name: string,
  leg: BoundaryLintResult | RawIoTaintResult,
  checks: CheckResult[],
  advisorySkips: AdvisorySkip[],
): void {
  switch (leg.status) {
    case 'PASS':
      checks.push('detail' in leg ? { name, status: 'PASS', detail: leg.detail } : { name, status: 'PASS' });
      return;
    case 'FAIL':
      checks.push({ name, status: 'FAIL', detail: leg.detail });
      return;
    case 'NO_VERDICT':
      advisorySkips.push({ name, cause: leg.cause, detail: leg.detail });
      return;
    case 'NOT_CONFIGURED':
      return;
    default: {
      const unhandled: never = leg;
      return unhandled;
    }
  }
}

/** The reason of an unresolved term for the report: the profile path, the reason, then the route of a remedy. */
function reportedReason(reason: string, input: StaticAnalysisInput): string {
  const routed = input.withRoute?.(reason) ?? reason;
  return input.profilePath === undefined ? routed : `${input.profilePath}. ${routed}`;
}

/**
 * The fields of a `skip` result. An unresolved term gives `profile-unresolved`, also beside a check that a flag skipped.
 * Else a flag skipped a check, which gives `constituent-skipped`.
 */
function skipFields(
  checks: readonly CheckResult[],
  input: StaticAnalysisInput,
): Pick<StaticAnalysisResult, 'skipReason' | 'skippedChecks' | 'unresolvedReason'> {
  const skippedChecks = checks
    .filter((check) => check.status === 'SKIP')
    .map(({ name, detail }): StaticAnalysisSkippedCheck => (detail === undefined ? { name } : { name, detail }));
  const unresolved = checks.filter((check) => check.unresolved === true);
  if (unresolved.length === 0) return { skipReason: 'constituent-skipped', skippedChecks };
  const reasons = unresolved.map((check) => check.detail ?? check.name).join(' ');
  return { skipReason: PROFILE_UNRESOLVED, skippedChecks, unresolvedReason: reportedReason(reasons, input) };
}

/**
 * Runs the checks of the profile and builds the report. Each boundary check joins
 * as an advisory leg through `foldAdvisoryLeg`. An unresolved check stops neither the
 * other checks nor the legs.
 *
 * A skipped check counts as a result. The precedence is FAIL, then an unresolved
 * term (`skip`, `**Result: SKIP**`), then a check that a flag skipped (`skip`,
 * `**Result: DEGRADED**`), then PASS. Thus PASS needs every counted check to run
 * and pass. An advisory leg with no verdict is not a counted check, so a PASS can
 * carry `advisorySkips`, and the result line then says `degraded`.
 */
export function runStaticAnalysis(input: StaticAnalysisInput): StaticAnalysisResult {
  const { repoRoot, runCommand } = input;

  if (!repoRoot || repoRoot.trim().length === 0) {
    return {
      status: 'error',
      output: '',
      error: 'Missing repoRoot',
      passCount: 0,
      failCount: 0,
      skipCount: 0,
    };
  }

  try {
    if (!fs.existsSync(repoRoot) || !fs.statSync(repoRoot).isDirectory()) {
      return {
        status: 'error',
        output: '',
        error: `Invalid repoRoot: ${repoRoot} does not exist or is not a directory`,
        passCount: 0,
        failCount: 0,
        skipCount: 0,
      };
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      status: 'error',
      output: '',
      error: `Invalid repoRoot: ${message}`,
      passCount: 0,
      failCount: 0,
      skipCount: 0,
    };
  }

  const projectType = detectToolchain(repoRoot)?.projectType;
  const checks = runProfileTerm(input.checks ?? staticAnalysisSeedsAt(repoRoot), input);

  const advisorySkips: AdvisorySkip[] = [];
  const unresolvedScope =
    input.unresolvedFirstParty === undefined ? undefined : reportedReason(input.unresolvedFirstParty, input);
  for (const check of input.boundaryChecks ?? boundaryChecksAt(repoRoot)) {
    const leg = runBoundaryCheck(check, {
      repoRoot,
      runCommand,
      firstPartyGlobs: input.firstPartyGlobs,
      unresolvedScope,
      projectConfigError: input.projectConfigError,
    });
    foldAdvisoryLeg(leg.name, leg.result, checks, advisorySkips);
  }

  let passCount = 0;
  let failCount = 0;
  let skipCount = 0;

  for (const check of checks) {
    if (check.status === 'PASS') passCount++;
    if (check.status === 'FAIL') failCount++;
    if (check.status === 'SKIP') skipCount++;
  }

  const outputLines: string[] = [
    '## Static Analysis Report',
    '',
    `**Repository:** \`${repoRoot}\``,
    ...(projectType === undefined ? [] : [`**Project type:** ${projectType}`]),
    ...(input.profilePath === undefined ? [] : [`**Profile:** ${input.profilePath}`]),
    '',
  ];

  for (const check of checks) {
    if (check.detail) {
      outputLines.push(`- **${check.status}**: ${check.name} — ${check.detail}`);
    } else {
      outputLines.push(`- **${check.status}**: ${check.name}`);
    }
  }

  for (const skip of advisorySkips) {
    outputLines.push(
      `- **SKIP**: ${skip.name} — ${skip.detail} (advisory: the gate does not fail on it)`,
    );
  }

  outputLines.push('');

  const total = passCount + failCount;

  outputLines.push('---');
  outputLines.push('');

  const note = advisorySkipNote(advisorySkips);
  if (failCount > 0) {
    outputLines.push(`**Result: FAIL** (${failCount}/${total} checks failed${note})`);
  } else if (skipCount > 0) {
    const label = checks.some((check) => check.unresolved === true) ? 'SKIP' : 'DEGRADED';
    outputLines.push(
      `**Result: ${label}** (${passCount}/${total} checks passed, ` +
        `${skipCount} skipped — inconclusive, not a pass${note})`,
    );
  } else {
    outputLines.push(`**Result: PASS** (${passCount}/${total} checks passed${note})`);
  }

  const output = outputLines.join('\n');

  const status: StaticAnalysisResult['status'] =
    failCount > 0 ? 'fail' : skipCount > 0 ? 'skip' : 'pass';

  return {
    status,
    output,
    ...(status === 'skip' ? skipFields(checks, input) : {}),
    passCount,
    failCount,
    skipCount,
    projectType,
    ...(advisorySkips.length > 0 ? { advisorySkips } : {}),
  };
}
