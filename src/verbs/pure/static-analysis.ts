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
import * as path from 'node:path';
import { detectToolchain } from '../../config/toolchains.js';
import { staticAnalysisSeedsAt } from '../../config/verification-profile.js';
import { DEFAULT_FIRST_PARTY_GLOBS } from '../../config/exarchos-config-schema.js';
import type { ExarchosConfigLoadFailure } from '../../config/load-exarchos-config.js';
import { PROFILE_UNRESOLVED, type VerificationProfile } from '../../workflow/verification/profile.js';

/** Result of running an external command. */
export interface CommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  /**
   * The error code of the process runner. The command did not start (ENOENT,
   * EACCES), or the runner stopped it (ENOBUFS when the output passed the
   * buffer limit). Then `exitCode` and `stdout` are not authoritative. The
   * integration-suite gate uses it to tell a spawn error from a JSON-shape
   * mismatch.
   */
  readonly spawnError?: string;
  /**
   * The signal that stopped the process, such as `SIGKILL`. Then `exitCode` is
   * not the exit status of the tool.
   */
  readonly signal?: string;
}

/** Signature of the external command runner, so that tests can inject a fake. */
export type RunCommandFn = (
  cmd: string,
  args: readonly string[],
  options?: { cwd?: string }
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

/** Candidate config filenames for the boundary lint, in resolution order. */
const BOUNDARY_CONFIG_FILENAMES: readonly string[] = [
  '.dependency-cruiser.cjs',
  '.dependency-cruiser.js',
  '.dependency-cruiser.json',
  '.dependency-cruiser.mjs',
];

/** Report label for the boundary-lint leg. */
const BOUNDARY_LINT_NAME = 'Import boundaries';

export interface BoundaryLintInput {
  /** Repository root to scan for a `.dependency-cruiser.*` config. */
  readonly repoRoot: string;
  /** External command runner (dependency injection). */
  readonly runCommand: RunCommandFn;
  /**
   * The `ownership.firstParty` globs. The leg scans the source root of each
   * glob that exists. A glob whose walk stops at its first segment widens the
   * scan to the repository root, which takes in nested worktrees and build
   * output. The leg does not apply a negated glob. When absent, the leg uses
   * the schema default.
   */
  readonly firstPartyGlobs?: readonly string[] | undefined;
  /** The project config that does not load or cannot be read. When it is present, the leg fails and does not scan. */
  readonly projectConfigError?: ExarchosConfigLoadFailure | undefined;
  /**
   * Finds the dependency-cruiser bin for `repoRoot`. The default is {@link findLocalDepcruise}.
   * A test injects a lookup to run a chosen bin.
   */
  readonly findDepcruise?: ((repoRoot: string) => string | undefined) | undefined;
}

/** A count of modules above zero. Only {@link positiveCount} gives one, so a value of this type is never 0. */
export type PositiveCount = number & { readonly positiveCountBrand: true };

/** True when `value` is a whole number above zero. */
function isPositiveCount(value: number): value is PositiveCount {
  return Number.isInteger(value) && value > 0;
}

/**
 * Gives `value` as a {@link PositiveCount}, or `undefined` for 0, a negative number or a fraction.
 * A literal 0 is a compile error, and a runtime 0 gives `undefined`.
 */
export function positiveCount<N extends number>(
  value: N & (N extends 0 ? never : unknown),
): PositiveCount | undefined {
  return isPositiveCount(value) ? value : undefined;
}

/** The leg result for a repository without the config of the leg. The leg does not run, and the report does not name it. */
export interface LegNotConfigured {
  readonly status: 'NOT_CONFIGURED';
  readonly detail: string;
}

/** The leg result for a run with no verdict. The report lists it as an advisory skip, and the status does not change. */
export interface LegNoVerdict<Cause extends BoundaryNoVerdictCause> {
  readonly status: 'NO_VERDICT';
  readonly cause: Cause;
  readonly detail: string;
}

/**
 * The verdict of the import-boundary leg. Each member is a closed state.
 * - `PASS`: no `error` violation, and the scan checked at least one module.
 * - `FAIL`: `error` violations, or a fault inside the repository. The faults are a broken boundary config, a usage
 *   error, and a project `.exarchos.yml` that does not load or cannot be read (`project-config`).
 * - `NO_VERDICT`: a fault outside the repository, or a scan with nothing to check. The gate does not fail on it.
 * - `NOT_CONFIGURED`: the repository has no boundary config.
 */
export type BoundaryLintResult =
  | { readonly status: 'PASS'; readonly cruised: PositiveCount; readonly detail: string }
  | {
      readonly status: 'FAIL';
      readonly cause: 'violations' | 'config-or-usage' | 'project-config';
      readonly detail: string;
    }
  | LegNoVerdict<BoundaryNoVerdictCause>
  | LegNotConfigured;

/**
 * Finds a dependency-cruiser config in `repoRoot` and returns its file name,
 * or null. It uses one directory listing, so a test that stubs `readdirSync`
 * to `[]` gets "no config" even when `existsSync` always returns true.
 */
function findBoundaryConfig(repoRoot: string): string | null {
  let entries: string[];
  try {
    entries = fs.readdirSync(repoRoot);
  } catch {
    return null;
  }
  const present = new Set(entries);
  return BOUNDARY_CONFIG_FILENAMES.find((name) => present.has(name)) ?? null;
}

/** Glob syntax in one path segment. */
const GLOB_SEGMENT = /[*?[\]{}()!]/;

/** Glob syntax that the segment matcher does not read. The matcher reads only `*` and `?`. */
const UNREAD_GLOB_SEGMENT = /[[\]{}()!]/;

/** The kind of a path in the repository, or `undefined` when the path does not exist. */
function pathKind(repoRoot: string, rel: string): 'directory' | 'file' | undefined {
  try {
    return fs.statSync(path.join(repoRoot, rel)).isDirectory() ? 'directory' : 'file';
  } catch {
    return undefined;
  }
}

/** The entry names of a directory in the repository, or an empty list when it cannot be read. */
function directoryEntries(repoRoot: string, rel: string): string[] {
  try {
    return fs.readdirSync(path.join(repoRoot, rel));
  } catch {
    return [];
  }
}

/** Compiles a glob segment that holds only `*` and `?` to an anchored matcher for one entry name. */
function segmentMatcher(segment: string): RegExp {
  let source = '';
  for (const ch of segment) {
    if (ch === '*') source += '[^/]*';
    else if (ch === '?') source += '[^/]';
    else source += ch.replace(/[.+^$|\\]/g, '\\$&');
  }
  return new RegExp(`^${source}$`);
}

/**
 * Resolves one `ownership.firstParty` glob to the existing repository paths
 * that hold its files. The walk stops at the first `**` segment, or at glob
 * syntax that the matcher does not read. Thus a root can be wider than its
 * glob. A negated, absolute or parent-relative glob gives no root.
 */
function scanRootsOfGlob(repoRoot: string, glob: string): string[] {
  const trimmed = glob.trim();
  if (trimmed.startsWith('!') || path.isAbsolute(trimmed)) return [];
  const segments = trimmed.split('/').filter((segment) => segment.length > 0 && segment !== '.');
  if (segments.includes('..')) return [];

  let candidates: string[] = [''];
  for (const [index, segment] of segments.entries()) {
    if (segment === '**' || UNREAD_GLOB_SEGMENT.test(segment)) break;
    const last = index === segments.length - 1;
    const matcher = GLOB_SEGMENT.test(segment) ? segmentMatcher(segment) : undefined;
    candidates = candidates.flatMap((parent) =>
      (matcher === undefined
        ? [segment]
        : directoryEntries(repoRoot, parent).filter((name) => matcher.test(name))
      )
        .map((name) => path.posix.join(parent, name))
        .filter((rel) => {
          const kind = pathKind(repoRoot, rel);
          return kind === 'directory' || (last && kind === 'file');
        }),
    );
  }
  return candidates.map((rel) => (rel === '' ? '.' : rel));
}

/** The scan scope of the import-boundary leg, with the globs that the scan did not take as written. */
interface BoundaryScanScope {
  /** The existing roots, sorted, with no duplicate and no root inside another root. */
  readonly roots: readonly string[];
  /** The globs that name no existing path and are not negated. The scan drops them. */
  readonly dropped: readonly string[];
  /**
   * The negated globs. The leg does not apply them, so it scans their paths when the root of another glob holds
   * those paths.
   */
  readonly excluded: readonly string[];
  /** The globs whose walk stops at the first segment. The scan widens them to the repository root. */
  readonly widened: readonly string[];
}

/** True when a glob is negated, that is, when it starts with `!`. */
function isNegatedGlob(glob: string): boolean {
  return glob.trim().startsWith('!');
}

/**
 * The scan scope of the import-boundary leg: the existing roots of the
 * `ownership.firstParty` globs. A root of `.` replaces all other roots.
 * The scope also names each dropped glob, each negated glob and each glob widened to `.`.
 */
function firstPartyScanRoots(repoRoot: string, globs: readonly string[]): BoundaryScanScope {
  const rootsByGlob = globs.map((glob) => ({ glob, roots: scanRootsOfGlob(repoRoot, glob) }));
  const excluded = globs.filter(isNegatedGlob);
  const dropped = rootsByGlob
    .filter((entry) => entry.roots.length === 0 && !isNegatedGlob(entry.glob))
    .map((entry) => entry.glob);
  const widened = rootsByGlob.filter((entry) => entry.roots.includes('.')).map((entry) => entry.glob);
  const roots = [...new Set(rootsByGlob.flatMap((entry) => entry.roots))].sort();
  if (roots.includes('.')) return { roots: ['.'], dropped, excluded, widened };
  return {
    roots: roots.filter((root) => !roots.some((other) => other !== root && root.startsWith(`${other}/`))),
    dropped,
    excluded,
    widened,
  };
}

/**
 * The sentence of the leg detail that names the dropped, the negated and the widened globs. It is `undefined` when
 * the scan took each glob as written. The leg adds it to each verdict, a PASS too.
 */
function scopeNote(scope: BoundaryScanScope): string | undefined {
  const parts: string[] = [];
  if (scope.dropped.length > 0) {
    parts.push(`ownership.firstParty globs that name no path, not scanned: ${scope.dropped.join(', ')}`);
  }
  if (scope.excluded.length > 0) {
    parts.push(`ownership.firstParty exclusions not applied: ${scope.excluded.join(', ')}`);
  }
  if (scope.widened.length > 0) {
    parts.push(`ownership.firstParty globs widened to the repository root: ${scope.widened.join(', ')}`);
  }
  return parts.length === 0 ? undefined : `${parts.join('. ')}.`;
}

/** Adds the scope note to a leg detail as a sentence of its own. */
function withScopeNote(detail: string, note: string | undefined): string {
  return note === undefined ? detail : `${detail}. ${note}`;
}

/** The parts of a complete dependency-cruiser JSON report that the leg reads. */
interface CruiseSummary {
  /** The number of violations of `error` severity, from `summary.error`. */
  readonly errorCount: number;
  /** The number of modules that the scan checked, from `summary.totalCruised`. */
  readonly totalCruised: number;
  /** One line for each `error` violation, in the form of the text reporter. */
  readonly errorLines: readonly string[];
}

/** Formats one violation of a JSON report as a text-reporter line, or gives none for another severity. */
function errorViolationLine(violation: unknown): string[] {
  if (typeof violation !== 'object' || violation === null) return [];
  if (!('rule' in violation) || !('from' in violation) || !('to' in violation)) return [];
  const { rule, from, to } = violation;
  if (typeof rule !== 'object' || rule === null) return [];
  if (!('name' in rule) || !('severity' in rule) || rule.severity !== 'error') return [];
  if (typeof rule.name !== 'string' || typeof from !== 'string' || typeof to !== 'string') return [];
  return [`error ${rule.name}: ${from} → ${to}`];
}

/** True when `value` is a whole number of zero or more. */
function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

/**
 * Reads `summary.error`, `summary.totalCruised` and the `error` violations from the stdout of
 * `depcruise --output-type json`. A complete report holds both counts. Other output gives `undefined`.
 */
function readCruiseSummary(stdout: string): CruiseSummary | undefined {
  let report: unknown;
  try {
    report = JSON.parse(stdout);
  } catch {
    return undefined;
  }
  if (typeof report !== 'object' || report === null || !('summary' in report)) return undefined;
  const summary = report.summary;
  if (typeof summary !== 'object' || summary === null) return undefined;
  if (!('error' in summary) || !('totalCruised' in summary)) return undefined;
  const errorCount = summary.error;
  const totalCruised = summary.totalCruised;
  if (!isCount(errorCount) || !isCount(totalCruised)) return undefined;
  const violations: unknown = 'violations' in summary ? summary.violations : undefined;
  const errorLines = Array.isArray(violations)
    ? violations.flatMap((violation: unknown) => errorViolationLine(violation))
    : [];
  return { errorCount, totalCruised, errorLines };
}

/** Text on stderr that shows that the Node heap was exhausted. */
const OUT_OF_MEMORY = /heap out of memory|allocation failed/i;

/** The most stderr lines that a leg detail quotes. */
const DETAIL_STDERR_LINES = 3;

/** A shell gives the exit status 128 plus the signal number for a process that a signal stopped. */
const SIGNAL_EXIT_BASE = 128;

/** The highest signal number that the exit-status hint names. */
const MAX_SIGNAL_NUMBER = 64;

/** The exit status of a POSIX shell, and of `env` in a shebang line, for a command that it did not find. */
const COMMAND_NOT_FOUND_EXIT = 127;

/** The exit status of `cmd.exe` for a command that it did not find. */
const WINDOWS_COMMAND_NOT_FOUND_EXIT = 9009;

/** A fault outside the repository that gave no verdict, with the words that name it. */
interface ProcessFault {
  readonly cause: ProcessNoVerdictCause;
  readonly text: string;
}

/**
 * Names the fault when the runner or a signal stopped a run. Both void the exit status and the output,
 * so a leg reads them first. It gives `undefined` for a run that ended by itself.
 */
function processFault(result: CommandResult): ProcessFault | undefined {
  if (result.spawnError === 'ENOBUFS') {
    return { cause: 'output-limit', text: 'its output passed the output limit of the runner (ENOBUFS)' };
  }
  if (result.spawnError === 'ENOENT') return { cause: 'missing-tool', text: 'the runner reported ENOENT' };
  if (result.spawnError) return { cause: 'did-not-start', text: `the runner reported ${result.spawnError}` };
  if (OUT_OF_MEMORY.test(result.stderr) && result.signal) {
    return { cause: 'out-of-memory', text: 'it ran out of memory' };
  }
  if (result.signal) return { cause: 'signal', text: `it was stopped by ${result.signal}` };
  return undefined;
}

/**
 * Names the fault outside the repository that the stderr or the exit status of a run with no verdict shows.
 * The faults are a heap exhaustion, a shell status of a signal stop, and a command that was not found.
 * It gives `undefined` otherwise, and the leg then reads the run as a fault inside the repository.
 */
function noVerdictFault(result: CommandResult): ProcessFault | undefined {
  if (OUT_OF_MEMORY.test(result.stderr)) return { cause: 'out-of-memory', text: 'it ran out of memory' };
  const code = result.exitCode;
  const signalNumber = code - SIGNAL_EXIT_BASE;
  if (signalNumber > 0 && signalNumber <= MAX_SIGNAL_NUMBER) {
    return { cause: 'signal', text: `exit ${code}, the status of a process stopped by signal ${signalNumber}` };
  }
  if (code === COMMAND_NOT_FOUND_EXIT || code === WINDOWS_COMMAND_NOT_FOUND_EXIT) {
    const stderr = stderrExcerpt(result.stderr);
    const quoted = stderr ? `: ${stderr}` : '';
    return { cause: 'missing-tool', text: `exit ${code}, the status of a command that was not found${quoted}` };
  }
  return undefined;
}

/** The first non-empty lines of stderr on one line, for a leg detail. */
function stderrExcerpt(stderr: string): string {
  return stderr
    .trim()
    .split('\n')
    .slice(0, DETAIL_STDERR_LINES)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join(' ');
}

/** A `NO_VERDICT` of the boundary leg, with the cause and the scope note in its detail. */
function boundaryNoVerdict(
  cause: BoundaryNoVerdictCause,
  text: string,
  note: string | undefined,
): BoundaryLintResult {
  return { status: 'NO_VERDICT', cause, detail: withScopeNote(`dependency-cruiser gave no verdict: ${text}`, note) };
}

/** The file name of the dependency-cruiser bin in `node_modules/.bin`. npm writes a `.cmd` shim on win32. */
function depcruiseBinName(platform: NodeJS.Platform): string {
  return platform === 'win32' ? 'depcruise.cmd' : 'depcruise';
}

/** True when `candidate` is a file. A symbolic link counts when its target is a file. */
function isFile(candidate: string): boolean {
  try {
    return fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
}

/**
 * Finds the dependency-cruiser bin that the repository installed. It walks up from `repoRoot` as npm does,
 * and gives the first `node_modules/.bin/depcruise` that is a file. On win32 the bin is `depcruise.cmd`.
 * It gives `undefined` when no directory on the walk holds the bin.
 */
export function findLocalDepcruise(
  repoRoot: string,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  const name = depcruiseBinName(platform);
  let dir = path.resolve(repoRoot);
  for (;;) {
    const candidate = path.join(dir, 'node_modules', '.bin', name);
    if (isFile(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/**
 * Runs the installed `node_modules/.bin/depcruise --validate <config> --output-type json` over the roots of the `ownership.firstParty`
 * globs. The leg never runs `npx`, so a missing install never fetches a package from the registry. A glob whose walk stops at its
 * first segment widens the scan to the repository root, which takes in nested worktrees and build output. The detail of each verdict
 * names such a glob, each glob with no path and each negated glob, which the leg does not apply. The verdict comes from the JSON report, not from the exit code, because 256 errors wrap to exit 0.
 * - No config: `NOT_CONFIGURED`, and depcruise does not run.
 * - A project `.exarchos.yml` that does not load or cannot be read: `FAIL` with the file and the error, and depcruise does not run.
 * - `summary.error` above 0: `FAIL` with the violations. 0 with modules checked: `PASS` with the count.
 * - No complete report and no fault outside the repository, such as a config error with exit 1: `FAIL`.
 * - No source root, no installed bin, a runner fault, a signal, a heap exhaustion, or zero modules checked: `NO_VERDICT` with its cause.
 */
export function runBoundaryLint(input: BoundaryLintInput): BoundaryLintResult {
  const {
    repoRoot,
    runCommand,
    firstPartyGlobs = DEFAULT_FIRST_PARTY_GLOBS,
    findDepcruise = findLocalDepcruise,
    projectConfigError,
  } = input;

  const configName = findBoundaryConfig(repoRoot);
  if (configName === null) {
    return { status: 'NOT_CONFIGURED', detail: `no ${BOUNDARY_CONFIG_FILENAMES[0]} in repo root` };
  }

  if (projectConfigError !== undefined) {
    return {
      status: 'FAIL',
      cause: 'project-config',
      detail:
        `the project config ${projectConfigError.source} does not load or cannot be read, so the leg has no ` +
        'ownership.firstParty scope and does not scan the default roots in its place. ' +
        `The load or read error: ${projectConfigError.message}. ` +
        'Correct the file or the cause of the read error, then run the gate again',
    };
  }

  const scope = firstPartyScanRoots(repoRoot, firstPartyGlobs);
  if (scope.roots.length === 0) {
    return boundaryNoVerdict(
      'no-source-root',
      `no ownership.firstParty source root exists (${firstPartyGlobs.join(', ')})`,
      undefined,
    );
  }
  const note = scopeNote(scope);

  const bin = findDepcruise(repoRoot);
  if (bin === undefined) {
    return boundaryNoVerdict(
      'missing-tool',
      `no node_modules/.bin/${depcruiseBinName(process.platform)} in ${repoRoot} or in a parent directory. ` +
        'Install dependency-cruiser in the repository, for example with npm install --save-dev dependency-cruiser. ' +
        'The gate does not fetch it from the registry',
      note,
    );
  }

  const args = ['--validate', configName, '--output-type', 'json', ...scope.roots];
  const rerun = `${path.relative(repoRoot, bin) || bin} --validate ${configName} ${scope.roots.join(' ')}`;
  let result: CommandResult;
  try {
    result = runCommand(bin, args, { cwd: repoRoot });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return boundaryNoVerdict('did-not-start', `the tool did not start (${message})`, note);
  }

  const fault = processFault(result);
  if (fault !== undefined) return boundaryNoVerdict(fault.cause, fault.text, note);

  const summary = readCruiseSummary(result.stdout);
  if (summary === undefined) {
    const exitFault = noVerdictFault(result);
    if (exitFault !== undefined) return boundaryNoVerdict(exitFault.cause, exitFault.text, note);
    const stderr = stderrExcerpt(result.stderr);
    const header =
      `dependency-cruiser gave no complete report (exit ${result.exitCode})${stderr ? `: ${stderr}` : ''}. ` +
      'A broken config, a usage error or an installed version with another report shape fails the leg';
    return {
      status: 'FAIL',
      cause: 'config-or-usage',
      detail: withScopeNote(`${header}. Re-run \`${rerun}\` for the full output`, note),
    };
  }

  if (summary.errorCount > 0) {
    const count = summary.errorCount;
    const header = `dependency-cruiser found ${count} ${count === 1 ? 'violation' : 'violations'} of error severity`;
    const detail = capFailDetail(
      [header, ...(note === undefined ? [] : [note]), ...summary.errorLines].join('\n'),
      rerun,
    );
    return { status: 'FAIL', cause: 'violations', detail };
  }

  const cruised = positiveCount(summary.totalCruised);
  if (cruised === undefined) {
    return boundaryNoVerdict(
      'zero-modules',
      'the scan checked no module (summary.totalCruised is 0). The roots hold no module that the config scans',
      note,
    );
  }
  return {
    status: 'PASS',
    cruised,
    detail: withScopeNote(`${cruised} ${cruised === 1 ? 'module' : 'modules'} checked`, note),
  };
}

/** Candidate taint-ruleset filenames, in resolution order. */
const TAINT_RULESET_FILENAMES: readonly string[] = [
  '.semgrep/no-raw-io-into-core.yml',
  '.semgrep/no-raw-io-into-core.yaml',
];

/** Report label for the boundary-parse taint leg. */
const BOUNDARY_TAINT_NAME = 'Boundary IO taint';

export interface RawIoTaintInput {
  /** Repository root to scan for a taint ruleset. */
  readonly repoRoot: string;
  /** External command runner (dependency injection). */
  readonly runCommand: RunCommandFn;
  /**
   * Core source paths to scan. The default is `['.']`, because the `paths`
   * filters in the ruleset narrow the real surface.
   */
  readonly coreSources?: readonly string[];
}

/**
 * The verdict of the boundary-parse taint leg. Each member is a closed state.
 * - `PASS`: exit 0.
 * - `FAIL`: findings (exit 1), a ruleset or a usage error, or an exit that the leg cannot read as a fault outside
 *   the repository.
 * - `NO_VERDICT`: a known fault outside the repository. The gate does not fail on it.
 * - `NOT_CONFIGURED`: the repository has no ruleset.
 */
export type RawIoTaintResult =
  | { readonly status: 'PASS' }
  | {
      readonly status: 'FAIL';
      readonly cause: 'findings' | 'ruleset-or-usage' | 'unknown-exit';
      readonly detail: string;
    }
  | LegNoVerdict<ProcessNoVerdictCause>
  | LegNotConfigured;

/** A `NO_VERDICT` of the taint leg, with the cause in its detail. */
function taintNoVerdict(cause: ProcessNoVerdictCause, text: string): RawIoTaintResult {
  return { status: 'NO_VERDICT', cause, detail: `semgrep gave no verdict: ${text}` };
}

/** The fatal exit status of semgrep. A killed engine, an install with no engine and some config faults share it. */
const SEMGREP_FATAL_EXIT = 2;

/** The exit statuses of semgrep for a ruleset or a usage error, with the fault that each status names. */
const SEMGREP_RULESET_EXITS: ReadonlyMap<number, string> = new Map([
  [4, 'a rule that does not parse'],
  [5, 'a config that is not valid YAML'],
  [7, 'a config that it did not find'],
  [8, 'a language that it does not know'],
]);

/** The text of semgrep for an engine that ran out of memory, or that a limit of the system stopped. */
const SEMGREP_OUT_OF_RESOURCES = /exceeded system resources|engine was killed|too much memory|out of memory/i;

/** The text of the semgrep launcher for an install that has no engine binary. */
const SEMGREP_MISSING_ENGINE = /failed to find semgrep-core/i;

/**
 * Names the fault outside the repository that the stderr of a fatal semgrep exit shows. The faults are an engine
 * that ran out of resources and an install with no engine. It gives `undefined` for each other run.
 */
function semgrepFatalFault(result: CommandResult): ProcessFault | undefined {
  if (result.exitCode !== SEMGREP_FATAL_EXIT) return undefined;
  const stderr = stderrExcerpt(result.stderr);
  if (SEMGREP_OUT_OF_RESOURCES.test(result.stderr)) {
    return { cause: 'out-of-memory', text: `exit 2, the engine ran out of system resources: ${stderr}` };
  }
  if (SEMGREP_MISSING_ENGINE.test(result.stderr)) {
    return { cause: 'missing-tool', text: `exit 2, the semgrep install has no engine: ${stderr}` };
  }
  return undefined;
}

/**
 * Finds a taint ruleset in `repoRoot` and returns its relative path, or null.
 * Like `findBoundaryConfig`, it lists the `.semgrep` directory, so a test that
 * stubs `readdirSync` gets "no ruleset" and the engine does not run.
 */
function findTaintRuleset(repoRoot: string): string | null {
  for (const rel of TAINT_RULESET_FILENAMES) {
    let entries: string[];
    try {
      entries = fs.readdirSync(path.join(repoRoot, path.dirname(rel)));
    } catch {
      continue;
    }
    if (new Set(entries).has(path.basename(rel))) return rel;
  }
  return null;
}

/**
 * Runs the boundary-parse taint leg with `semgrep --error --quiet --config <ruleset> <coreSources...>`. The ruleset
 * checks that untrusted input passes a registered parser before it enters the core. Import rules cannot see that flow.
 * No ruleset gives `NOT_CONFIGURED`, and the engine does not run. Exit 0 is `PASS`, and exit 1 is `FAIL` with findings.
 * - `NO_VERDICT`: a throw, a runner error, a signal, a heap exhaustion, or the exit status of a signal stop or of a
 *   missing command. Exit 2 with the text of an engine out of resources or of a missing engine is `NO_VERDICT` too.
 * - `FAIL` with `ruleset-or-usage`: exit 4, 5, 7 or 8, the statuses of semgrep for a ruleset or a usage error.
 * - `FAIL` with `unknown-exit`: each other exit, exit 2 without that text included. Only a known fault outside the
 *   repository gives no verdict. The `--quiet` flag hides the messages of semgrep, so an engine fault can come here.
 */
export function runRawIoTaint(input: RawIoTaintInput): RawIoTaintResult {
  const { repoRoot, runCommand, coreSources = ['.'] } = input;

  const ruleset = findTaintRuleset(repoRoot);
  if (ruleset === null) {
    return { status: 'NOT_CONFIGURED', detail: `no ${TAINT_RULESET_FILENAMES[0]} in repo` };
  }

  let result: CommandResult;
  try {
    result = runCommand(
      'semgrep',
      ['--error', '--quiet', '--config', ruleset, ...coreSources],
      { cwd: repoRoot },
    );
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return taintNoVerdict('did-not-start', `semgrep not available (${message})`);
  }

  const fault = processFault(result);
  if (fault !== undefined) return taintNoVerdict(fault.cause, fault.text);

  if (result.exitCode === 0) {
    return { status: 'PASS' };
  }

  if (result.exitCode === 1) {
    const detail =
      result.stdout.trim() ||
      result.stderr.trim() ||
      'semgrep reported a boundary-parse violation';
    return { status: 'FAIL', cause: 'findings', detail };
  }

  const exitFault = noVerdictFault(result) ?? semgrepFatalFault(result);
  if (exitFault !== undefined) return taintNoVerdict(exitFault.cause, exitFault.text);

  const stderr = stderrExcerpt(result.stderr);
  const output = stderr ? `: ${stderr}` : ' with no stderr';
  const command = `semgrep --error --config ${ruleset} ${coreSources.join(' ')}`;
  const rerun = `Re-run \`${command}\` without --quiet to read its message`;
  const rulesetFault = SEMGREP_RULESET_EXITS.get(result.exitCode);
  if (rulesetFault !== undefined) {
    return {
      status: 'FAIL',
      cause: 'ruleset-or-usage',
      detail:
        `semgrep exited ${result.exitCode}, its status for ${rulesetFault}${output}. ` +
        `A ruleset or a usage error fails the leg. ${rerun}`,
    };
  }
  return {
    status: 'FAIL',
    cause: 'unknown-exit',
    detail:
      `semgrep exited ${result.exitCode}${output}. The leg cannot tell a ruleset fault from an engine fault, ` +
      `so it fails. ${rerun}`,
  };
}

type CheckStatus = 'PASS' | 'FAIL' | 'SKIP';

interface CheckResult {
  readonly name: string;
  readonly status: CheckStatus;
  readonly detail?: string;
  /** True on the SKIP of a term that the profile does not resolve. The SKIP of a skip flag does not set it. */
  readonly unresolved?: true;
}

/** Maximum raw transcript lines kept in a FAIL detail before the cap engages. */
export const FAIL_DETAIL_MAX_LINES = 50;

/**
 * Maximum distinct failing files in the per-file list. Without this cap, a
 * large cascade adds one line for each file, and the capped detail can still
 * exceed the response budget.
 */
export const FAIL_DETAIL_MAX_FILES = 20;

/**
 * A path-like token that ends in an extension of any name. It attributes each
 * transcript line to a file. It matches tsc (`src/foo.ts(12,5):`), eslint
 * stylish headers (`/abs/src/foo.ts`), eslint unix output (`src/foo.ts:12:5:`),
 * and bare file names (`foo.ts`). An extension starts with a letter, so a
 * version such as `1.2.3` is not a file.
 */
const FILE_TOKEN_RE = /(?:\.{0,2}\/)?(?:[\w.-]+\/)*[\w.-]+\.[A-Za-z][A-Za-z0-9]*\b/;

/** Extract the first file-path token on a transcript line, or null if none. */
function extractFileToken(line: string): string | null {
  const m = FILE_TOKEN_RE.exec(line);
  return m ? m[0] : null;
}

/** Counts the transcript lines for each failing file. The map keeps first-seen order. */
function fileFailureCounts(lines: readonly string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const line of lines) {
    const file = extractFileToken(line);
    if (file) counts.set(file, (counts.get(file) ?? 0) + 1);
  }
  return counts;
}

/**
 * Caps a long FAIL `detail` (a raw lint or typecheck transcript). It keeps the
 * first `FAIL_DETAIL_MAX_LINES` lines and adds the total line count, the
 * failing files, and a re-run hint. The file list comes from the full output,
 * sorted by line count with ties in first-seen order, and is capped at
 * `FAIL_DETAIL_MAX_FILES`. A detail that fits is returned unchanged.
 *
 * @param rawDetail    the full (already-trimmed) tool transcript
 * @param rerunCommand the command the reviewer re-runs for the uncapped output
 */
export function capFailDetail(rawDetail: string, rerunCommand: string): string {
  const lines = rawDetail.split('\n');
  const total = lines.length;
  if (total <= FAIL_DETAIL_MAX_LINES) {
    return rawDetail;
  }

  const fileCounts = fileFailureCounts(lines);
  const parts: string[] = lines.slice(0, FAIL_DETAIL_MAX_LINES);

  parts.push('');
  parts.push(
    `… output capped at ${FAIL_DETAIL_MAX_LINES} of ${total} lines (${total - FAIL_DETAIL_MAX_LINES} more elided).`,
  );

  if (fileCounts.size > 0) {
    const ordered = [...fileCounts.entries()].sort((a, b) => b[1] - a[1]);
    parts.push(`Failing files (${fileCounts.size}):`);
    const shown = ordered.slice(0, FAIL_DETAIL_MAX_FILES);
    for (const [file, count] of shown) {
      parts.push(`  ${file}: ${count}`);
    }
    if (ordered.length > shown.length) {
      parts.push(`  …and ${ordered.length - shown.length} more files.`);
    }
  }

  parts.push(`Re-run \`${rerunCommand}\` for the full output.`);
  return parts.join('\n');
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
  const routed = input.withRoute?.(reasons) ?? reasons;
  const unresolvedReason = input.profilePath === undefined ? routed : `${input.profilePath}. ${routed}`;
  return { skipReason: PROFILE_UNRESOLVED, skippedChecks, unresolvedReason };
}

/**
 * Runs the checks of the profile and builds the report. The boundary-lint and
 * taint legs join through `foldAdvisoryLeg`. An unresolved check stops neither the
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
  foldAdvisoryLeg(
    BOUNDARY_LINT_NAME,
    runBoundaryLint({
      repoRoot,
      runCommand,
      firstPartyGlobs: input.firstPartyGlobs,
      projectConfigError: input.projectConfigError,
    }),
    checks,
    advisorySkips,
  );
  foldAdvisoryLeg(BOUNDARY_TAINT_NAME, runRawIoTaint({ repoRoot, runCommand }), checks, advisorySkips);

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
