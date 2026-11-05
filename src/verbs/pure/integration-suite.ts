/**
 * The integration suite gate logic. It runs the `integration` term of the verification profile and reads the exit code.
 * Exit 0 passes, and a red code of the term fails. Each other end gives no verdict, and it blocks.
 * A term that is not resolved gives `profile-unresolved`, and no process starts.
 *
 * A term that selects a report also reads the report of the run. The reader adds the counts and the load failures,
 * so a report with failures fails on exit 0 too. The runner calls an injected `RunCommandFn`, so a unit test starts no process.
 */

import { parseVitestResult, type IntegrationSuiteParse } from '../../config/suite-reports.js';
import { PROFILE_UNRESOLVED, type VerificationProfile } from '../../workflow/verification/profile.js';
import type { ClosedGateVerdict } from '../gates/gate-utils.js';
import type { CommandResult, RunCommandFn } from './static-analysis.js';

/** The integration term of the verification profile. */
type IntegrationTerm = VerificationProfile['integration'];

/** Why a run of the suite gave no verdict. Each cause blocks, and none reads as a red exit. */
export type IntegrationNoVerdictCause =
  | 'unknown-exit'
  | 'signal'
  | 'timeout'
  | 'overflow'
  | 'spawn-error'
  | 'shape-mismatch';

/** The exit code of a run with no exit status. No red code of a term can equal it, because a red code is from 1 to 255. */
export const NO_EXIT_STATUS = -1;

export interface RunIntegrationSuiteInput {
  /** Repository root to run the suite against (worktree-aware). */
  readonly repoRoot: string;
  /** External command runner (dependency injection). */
  readonly runCommand: RunCommandFn;
  /** The integration term of the profile, resolved or not. This function decides `profile-unresolved`. */
  readonly integration: IntegrationTerm;
}

export interface RunIntegrationSuiteResult extends IntegrationSuiteParse, ClosedGateVerdict {
  /** The cause of an `indeterminate` verdict of a run. Unset on a verdict, and on a term that is not resolved. */
  readonly noVerdictCause?: IntegrationNoVerdictCause;
  /** Set only for a term that is not resolved. */
  readonly discriminant?: typeof PROFILE_UNRESOLVED;
  /** The reason of a term that is not resolved. */
  readonly reason?: string;
  /** True when the verdict is `indeterminate`. The counts are then not authoritative. */
  readonly parseError: boolean;
  /**
   * The cause of a `parseError` that names the output of the command. `'spawn-failure'` means that the
   * command did not start. `'shape-mismatch'` means that it ran, but the report does not parse.
   */
  readonly parseFailureKind?: 'spawn-failure' | 'shape-mismatch';
  /** Raw exit code from the runner. */
  readonly exitCode: number;
  /** Structured markdown report. */
  readonly report: string;
}

/**
 * The maximum number of load-failure files that the report lists. A load
 * cascade can list hundreds of files. After the cap, one line gives the total
 * and tells the reader to run the suite locally. It is not a schema parameter.
 */
export const LOAD_FAILURE_LIST_CAP = 20;

/** The counts of an end with no verdict. They are not authoritative, and one failure keeps the count above zero. */
const NO_VERDICT_COUNTS: IntegrationSuiteParse = {
  passed: false,
  failedSuites: 1,
  failedTests: 0,
  loadFailures: 1,
  totalTests: 0,
  failCount: 1,
  loadFailureFiles: [],
};

/** The words of a report that name the repository. */
function reportHead(repoRoot: string): string[] {
  return ['## Integration Suite Report', '', `**Repository:** \`${repoRoot}\``];
}

/** The report of a run that the exit code judges. A report format adds the counts. */
function exitCodeReport(repoRoot: string, argv: readonly string[], exitCode: number): string {
  const result = exitCode === 0 ? '**Result: PASS** (exit 0)' : `**Result: FAIL** (exit ${exitCode})`;
  return [...reportHead(repoRoot), `**Command:** \`${argv.join(' ')}\``, `**Exit code:** ${exitCode}`, '', '---', '', result].join('\n');
}

/** The report of a run with a parsed report. A red exit with a clean report fails, so the result line names the exit. */
function parsedReport(repoRoot: string, parse: IntegrationSuiteParse, exitCode: number): string {
  const lines: string[] = [
    ...reportHead(repoRoot),
    `**Exit code:** ${exitCode}`,
    `**Tests collected:** ${parse.totalTests}`,
    `**Failed tests:** ${parse.failedTests}`,
    `**Failed suites:** ${parse.failedSuites}`,
    `**Load failures (folded in):** ${parse.loadFailures}`,
    '',
  ];

  if (parse.loadFailureFiles.length > 0) {
    lines.push('### Files that failed to load');
    const shownFiles = parse.loadFailureFiles.slice(0, LOAD_FAILURE_LIST_CAP);
    for (const f of shownFiles) {
      lines.push(`- \`${f}\``);
    }
    if (parse.loadFailureFiles.length > shownFiles.length) {
      const remaining = parse.loadFailureFiles.length - shownFiles.length;
      lines.push(
        `- …and ${remaining} more (${parse.loadFailureFiles.length} load failures total). ` +
          `Re-run the suite locally for the full list.`,
      );
    }
    lines.push('');
  }

  lines.push('---', '');
  if (parse.passed && exitCode === 0) {
    lines.push(`**Result: PASS** (${parse.totalTests} tests, no load failures)`);
  } else if (parse.passed) {
    lines.push(`**Result: FAIL** (exit ${exitCode}, and the report names no failure)`);
  } else {
    lines.push(
      `**Result: FAIL** (${parse.failCount} failures: ${parse.failedTests} test + ${parse.loadFailures} load)`,
    );
  }

  return lines.join('\n');
}

/** The end of a run with no verdict: its cause and the words that the report gives it. */
interface NoVerdictEnd {
  readonly cause: IntegrationNoVerdictCause;
  readonly detail: string;
}

/** The parse-failure kind of each cause that names the output of the command. */
const PARSE_FAILURE_KINDS: Partial<Record<IntegrationNoVerdictCause, NonNullable<RunIntegrationSuiteResult['parseFailureKind']>>> = {
  'spawn-error': 'spawn-failure',
  'shape-mismatch': 'shape-mismatch',
};

/** Builds the fail-closed result of an end with no verdict. The report names its cause. */
function noVerdictResult(repoRoot: string, exitCode: number, end: NoVerdictEnd): RunIntegrationSuiteResult {
  const parseFailureKind = PARSE_FAILURE_KINDS[end.cause];
  return {
    ...NO_VERDICT_COUNTS,
    verdict: 'indeterminate',
    completeness: 'complete',
    noVerdictCause: end.cause,
    parseError: true,
    ...(parseFailureKind === undefined ? {} : { parseFailureKind }),
    exitCode,
    report: [
      ...reportHead(repoRoot),
      '',
      `- **BLOCKED**: ${end.detail}; the run gave no verdict, so the gate fails closed`,
      '',
      '---',
      '',
      `**Result: NO VERDICT** (${end.cause})`,
    ].join('\n'),
  };
}

/** Builds the result of a term that is not resolved. No process starts, so the result has no exit status and no cause of a run. */
function unresolvedResult(repoRoot: string, reason: string): RunIntegrationSuiteResult {
  return {
    ...NO_VERDICT_COUNTS,
    verdict: 'indeterminate',
    completeness: 'complete',
    discriminant: PROFILE_UNRESOLVED,
    reason,
    parseError: true,
    exitCode: NO_EXIT_STATUS,
    report: [...reportHead(repoRoot), '', `- **BLOCKED**: ${reason}`, '', '---', '', `**Result: NO VERDICT** (${PROFILE_UNRESOLVED})`].join('\n'),
  };
}

/**
 * The end of a run that gave no verdict, or undefined for an exit that the term reads.
 * A timeout and an overflow carry a code and a signal, so the code comes first. Any other code means that the command did not start.
 * An exit code outside the red codes of the term gives no verdict.
 */
function noVerdictEndOf(run: CommandResult, program: string, redCodes: readonly number[]): NoVerdictEnd | undefined {
  if (run.spawnError === 'ETIMEDOUT') return { cause: 'timeout', detail: 'the run passed its time limit' };
  if (run.spawnError === 'ENOBUFS') return { cause: 'overflow', detail: 'the run passed its output limit' };
  if (run.spawnError !== undefined) {
    return { cause: 'spawn-error', detail: `runner failed to spawn (\`${program}\`: ${run.spawnError})` };
  }
  if (run.signal !== undefined) return { cause: 'signal', detail: `the signal ${run.signal} stopped the run` };
  if (run.exitCode !== 0 && !redCodes.includes(run.exitCode)) {
    return {
      cause: 'unknown-exit',
      detail: `the command exited ${run.exitCode}, and only exit ${redCodes.join(' or ')} reads as a red run`,
    };
  }
  return undefined;
}

/** The result of an exit that the term reads, with no report. The run gives no counts, so a red exit counts as one failure. */
function exitCodeResult(repoRoot: string, argv: readonly string[], exitCode: number): RunIntegrationSuiteResult {
  const passed = exitCode === 0;
  return {
    passed,
    failedSuites: 0,
    failedTests: 0,
    loadFailures: 0,
    totalTests: 0,
    failCount: passed ? 0 : 1,
    loadFailureFiles: [],
    verdict: passed ? 'pass' : 'fail',
    completeness: 'complete',
    parseError: false,
    exitCode,
    report: exitCodeReport(repoRoot, argv, exitCode),
  };
}

/** The result of an exit that the term reads, with a parsed report. A report with failures fails on exit 0, and a red exit fails with a clean report. */
function parsedResult(repoRoot: string, parse: IntegrationSuiteParse, exitCode: number): RunIntegrationSuiteResult {
  const passed = parse.passed && exitCode === 0;
  return {
    ...parse,
    passed,
    failCount: passed ? 0 : Math.max(parse.failCount, 1),
    verdict: passed ? 'pass' : 'fail',
    completeness: 'complete',
    parseError: false,
    exitCode,
    report: parsedReport(repoRoot, parse, exitCode),
  };
}

/**
 * Runs the command of the integration term in `repoRoot` and judges the exit code.
 * It has no side effect other than the injected `runCommand`, and the runner gets exactly the argv of the term.
 * When the term selects a report, a report that does not parse gives `shape-mismatch` on each exit that the term reads.
 * A crashed reporter can exit 0, so exit 0 does not prove the run.
 */
export function runIntegrationSuite(input: RunIntegrationSuiteInput): RunIntegrationSuiteResult {
  const { repoRoot, runCommand, integration } = input;
  const { command } = integration;
  if (command.state === 'unresolved') return unresolvedResult(repoRoot, command.reason);

  const [program = '', ...args] = command.argv;
  const run = runCommand(program, args, { cwd: repoRoot });

  const end = noVerdictEndOf(run, program, integration.failureExitCodes.codes);
  if (end !== undefined) return noVerdictResult(repoRoot, run.exitCode, end);

  if (integration.report === 'exit-code') return exitCodeResult(repoRoot, command.argv, run.exitCode);

  const parse = parseVitestResult(run.stdout);
  if (parse === null) {
    return noVerdictResult(repoRoot, run.exitCode, {
      cause: 'shape-mismatch',
      detail: 'runner produced no parseable vitest JSON (ran, but the output shape was unrecognized)',
    });
  }
  return parsedResult(repoRoot, parse, run.exitCode);
}
