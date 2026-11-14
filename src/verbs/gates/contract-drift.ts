/**
 * The core of the check_contract_drift gate. It checks that the schema-boundary
 * changes of a task do not break the contract. It runs codegen, then a
 * typecheck of the output, then a breaking-change diff.
 *
 * The gate reports findings. It does not change the working tree or hold a
 * lock. Git and the command runner are injected, so unit tests run no shell
 * command. When no contract command resolves, the gate gives an advisory pass
 * with `skipped: true`, not a fail. When only one of codegen and diff resolves,
 * the gate runs it and names the other leg with its reason.
 */

import type { GitExec } from '../pure/execute-merge.js';
import { PROFILE_UNRESOLVED, type VerificationProfile } from '../../workflow/verification/profile.js';

/** Result of running a single contract leg (codegen / typecheck / diff). */
export interface CommandRunResult {
  readonly exitCode: number;
  readonly stdout: string;
}

/**
 * Injected runner that runs the argv of one contract leg in the repo and
 * returns its exit code + combined output. Async to match real shell-outs.
 * The argv comes from the profile, so no runner splits a string.
 */
export type CommandRunFn = (input: {
  readonly repoRoot: string;
  readonly argv: readonly string[];
}) => Promise<CommandRunResult>;

export interface ContractDriftArgs {
  readonly repoRoot: string;
  /** Base ref the branch diverged from — the merge-base is computed against this. */
  readonly baseRef: string;
  readonly coordinate?: { readonly diffBaseCommit: string; readonly observedHeadCommit: string } | undefined;
  /**
   * The `contract` term of the verification profile. An unresolved `codegen` or `diff` skips that leg.
   * An unresolved `typecheck` skips the typecheck leg. When both `codegen` and `diff` are unresolved, the gate skips.
   */
  readonly contract: VerificationProfile['contract'];
  /** Git executor (injected). */
  readonly gitExec: GitExec;
  /** Command runner (injected). */
  readonly runCommand: CommandRunFn;
}

export interface ContractDriftResult {
  /**
   * The gate verdict. PASS means: every wired leg succeeded and the breaking-
   * diff reported no breakage. A skipped gate (no tool) also passes (advisory).
   */
  readonly passed: boolean;
  /** True when the breaking-diff reported breaking changes. */
  readonly drift: boolean;
  /** The breaking-change lines surfaced by the diff tool (empty when none). */
  readonly breaking: string[];
  /** Human-readable summary of what the gate did and found. */
  readonly report: string;
  /** True when no contract command resolved, which gives an advisory pass. */
  readonly skipped?: boolean;
  /**
   * The discriminant of a skip, or of a pass that did not run the `codegen` or the `diff` leg.
   * In each case the profile does not resolve the term of a leg.
   */
  readonly discriminant?: typeof PROFILE_UNRESOLVED | 'PROFILE_DIFF_COORDINATE_UNBOUND';
  /**
   * The reason of a skip, or of a pass that did not run a leg. It holds the reason of each unresolved term
   * of `contract.codegen` and `contract.diff`.
   */
  readonly reason?: string;
  /** The merge-base sha, when git computes it. The report shows it, but the diff command does not use it. */
  readonly baseline?: string;
}

/**
 * Extracts the breaking-change lines from the stdout of a diff tool. A line
 * that starts with `breaking`, `err`, or `error`, in any case, matches. A clean
 * line such as "no breaking changes" does not match.
 */
function extractBreaking(stdout: string): string[] {
  return stdout
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && /^(breaking\b|err\b|error\b)/i.test(l));
}

/**
 * Computes `git merge-base <baseRef> HEAD`. It returns null when git fails,
 * and the report then says that the gate cannot compute the baseline.
 */
function computeMergeBase(gitExec: GitExec, repoRoot: string, baseRef: string): string | null {
  const result = gitExec(repoRoot, ['merge-base', baseRef, 'HEAD']);
  if (result.exitCode !== 0) return null;
  const sha = result.stdout.trim();
  return sha.length > 0 ? sha : null;
}

/** The leg of the contract term whose term is not resolved, with the reason of that term. */
interface LegNotRun {
  readonly leg: 'codegen' | 'diff';
  readonly reason: string;
}

/** The `codegen` and `diff` legs whose terms are not resolved, in the order of the gate. */
function legsNotRun(contract: VerificationProfile['contract']): readonly LegNotRun[] {
  const legs: LegNotRun[] = [];
  if (contract.codegen.state === 'unresolved') legs.push({ leg: 'codegen', reason: contract.codegen.reason });
  if (contract.diff.state === 'unresolved') legs.push({ leg: 'diff', reason: contract.diff.reason });
  return legs;
}

/** The report line of a leg that did not run. It names the leg and the reason of its term. */
function notRunLine({ leg, reason }: LegNotRun): string {
  return `${leg} not run: ${reason}`;
}

/**
 * Runs the contract-drift gate. Each leg runs only when its command is resolved.
 *   1. With no codegen and no diff command, it gives a skipped advisory pass with `profile-unresolved` and a reason.
 *      The report names the reason of each leg.
 *   2. It writes the merge-base of `baseRef` and HEAD to the report, then one line for each codegen or diff leg that does not run.
 *   3. A non-zero codegen or typecheck exit fails the gate with `drift: false`.
 *   4. A non-zero diff exit or a breaking line is drift and fails the gate.
 *      Diff tools exit non-zero on a breaking change. With no breaking line,
 *      the raw output becomes the finding, so the finding is not empty.
 *   5. A pass that did not run a codegen or diff leg carries `profile-unresolved` and the reason of that leg.
 */
export async function runContractDrift(args: ContractDriftArgs): Promise<ContractDriftResult> {
  const { repoRoot, baseRef, contract, gitExec, runCommand } = args;
  const { codegen, typecheck, diff } = contract;
  const notRun = legsNotRun(contract);
  const coordinate = args.coordinate;
  if (coordinate !== undefined && diff.state === 'resolved'
    && (!diff.argv.slice(1).includes('@baseCommit@') || !diff.argv.slice(1).includes('@headCommit@'))) {
    return { passed: false, drift: false, breaking: [], discriminant: 'PROFILE_DIFF_COORDINATE_UNBOUND',
      report: 'The resolved diff command requires standalone @baseCommit@ and @headCommit@ arguments.' };
  }
  const diffArgv = diff.state !== 'resolved' ? [] : diff.argv.map((token, index) => coordinate === undefined || index === 0 ? token
    : token === '@baseCommit@' ? coordinate.diffBaseCommit : token === '@headCommit@' ? coordinate.observedHeadCommit : token);


  if (codegen.state === 'unresolved' && diff.state === 'unresolved') {
    return {
      passed: true,
      drift: false,
      breaking: [],
      skipped: true,
      discriminant: PROFILE_UNRESOLVED,
      reason: `${codegen.reason} ${diff.reason}`,
      report: [
        'check_contract_drift skipped: no contract codegen or diff command resolved. Advisory pass.',
        ...notRun.map(notRunLine),
      ].join('\n'),
    };
  }

  const baseline = coordinate?.diffBaseCommit ?? computeMergeBase(gitExec, repoRoot, baseRef);
  const reportLines: string[] = [];
  reportLines.push(
    baseline
      ? `baseline = merge-base(${baseRef}, HEAD) = ${baseline}`
      : `baseline = merge-base(${baseRef}, HEAD) could not be computed`,
  );
  reportLines.push(...notRun.map(notRunLine));

  if (codegen.state === 'resolved') {
    const cg = await runCommand({ repoRoot, argv: codegen.argv });
    if (cg.exitCode !== 0) {
      reportLines.push(`codegen FAILED (exit ${cg.exitCode}): ${cg.stdout.trim()}`);
      return {
        passed: false,
        drift: false,
        breaking: [],
        report: reportLines.join('\n'),
        ...(baseline ? { baseline } : {}),
      };
    }
    reportLines.push('codegen ok');
  }

  if (typecheck.state === 'resolved') {
    const tc = await runCommand({ repoRoot, argv: typecheck.argv });
    if (tc.exitCode !== 0) {
      reportLines.push(`typecheck FAILED (exit ${tc.exitCode}): ${tc.stdout.trim()}`);
      return {
        passed: false,
        drift: false,
        breaking: [],
        report: reportLines.join('\n'),
        ...(baseline ? { baseline } : {}),
      };
    }
    reportLines.push('typecheck ok');
  }

  if (diff.state === 'resolved') {
    const df = await runCommand({ repoRoot, argv: diffArgv });
    const breaking = extractBreaking(df.stdout);
    const isDrift = df.exitCode !== 0 || breaking.length > 0;
    if (isDrift) {
      const surfaced =
        breaking.length > 0
          ? breaking
          : [`breaking-diff reported drift (exit ${df.exitCode}): ${df.stdout.trim() || '<no output>'}`];
      reportLines.push(`breaking-diff DRIFT: ${surfaced.length} finding(s)`);
      return {
        passed: false,
        drift: true,
        breaking: surfaced,
        report: reportLines.join('\n'),
        ...(baseline ? { baseline } : {}),
      };
    }
    reportLines.push('breaking-diff clean');
  }

  return {
    passed: true,
    drift: false,
    breaking: [],
    report: reportLines.join('\n'),
    ...(notRun.length === 0
      ? {}
      : { discriminant: PROFILE_UNRESOLVED, reason: notRun.map((leg) => leg.reason).join(' ') }),
    ...(baseline ? { baseline } : {}),
  };
}
