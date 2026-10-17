/**
 * Static analysis gate: runs lint, typecheck, and quality checks for the
 * review workflow and reports a structured result. The caller injects the
 * command runner as a `RunCommandFn`.
 *
 * Status values:
 *   - `pass`: every applicable check ran and passed. Warnings are allowed.
 *   - `fail`: one or more checks failed.
 *   - `skip`: the result is inconclusive. `skipReason` is `no-toolchain` when
 *     no supported project type is found, or `constituent-skipped` when a
 *     check did not run and no check failed.
 *   - `error`: a usage error, such as a missing or invalid repo root.
 *
 * An advisory check that gives no verdict does not change the status. The
 * report names it and marks the result degraded.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { detectToolchain, BUILTIN_TOOLCHAINS } from '../../config/toolchains.js';
import { DEFAULT_FIRST_PARTY_GLOBS } from '../../config/exarchos-config-schema.js';

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

export interface StaticAnalysisInput {
  /** Repository root to analyze. */
  readonly repoRoot: string;
  /** Skip lint check. */
  readonly skipLint?: boolean | undefined;
  /** Skip typecheck. */
  readonly skipTypecheck?: boolean | undefined;
  /**
   * The `ownership.firstParty` globs of the project. The import-boundary leg
   * scans only these source trees. When absent, the leg uses the schema default.
   */
  readonly firstPartyGlobs?: readonly string[] | undefined;
  /** External command runner (dependency injection). */
  readonly runCommand: RunCommandFn;
}

/**
 * An advisory check that applies to the repository but gave no verdict. An
 * example is an import-boundary scan that ran out of memory.
 */
export interface AdvisorySkip {
  readonly name: string;
  /** The cause, for the report and the reviewer. */
  readonly detail: string;
}

/**
 * Reason code for a `skip` status.
 * - `no-toolchain`: no supported project type in `repoRoot`.
 * - `constituent-skipped`: a toolchain was detected, but a check did not run.
 *   The result is inconclusive and cannot be a pass.
 */
export type StaticAnalysisSkipReason = 'no-toolchain' | 'constituent-skipped';

/** One check that did not run, with the cause that the report names for it. */
export interface StaticAnalysisSkippedCheck {
  /** The report label of the check, for example `Quality check`. */
  readonly name: string;
  /** Why the check did not run, for example a missing npm script or a skip flag. */
  readonly detail?: string;
}

export interface StaticAnalysisResult {
  /**
   * Overall status.
   * - `pass`: every applicable check ran and passed. One skipped check
   *   prevents this value.
   * - `fail`: one or more checks failed.
   * - `skip`: inconclusive, see `skipReason`. A repo with no supported
   *   toolchain, or with a check that did not run, is not reported as a pass.
   * - `error`: a usage error, such as a missing or invalid repo root.
   */
  readonly status: 'pass' | 'fail' | 'skip' | 'error';
  /** Structured markdown report. */
  readonly output: string;
  /** Error message when status is 'error'. */
  readonly error?: string;
  /** Reason code when status is 'skip'. */
  readonly skipReason?: StaticAnalysisSkipReason;
  /** The checks that did not run, when `skipReason` is `constituent-skipped`. */
  readonly skippedChecks?: readonly StaticAnalysisSkippedCheck[];
  /** Number of checks that passed. */
  readonly passCount: number;
  /** Number of checks that failed. */
  readonly failCount: number;
  /**
   * Number of checks that did not run, because of a missing script or a skip
   * flag. A non-zero count prevents `pass`.
   */
  readonly skipCount: number;
  /** Detected project type (undefined if no recognized project). */
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
   * glob that exists, not the whole checkout. When absent, the leg uses the
   * schema default.
   */
  readonly firstPartyGlobs?: readonly string[] | undefined;
}

/** Verdict of the import-boundary leg. `SKIP` is advisory and does not block. */
export interface BoundaryLintResult {
  readonly status: 'PASS' | 'FAIL' | 'SKIP';
  /** Human detail: the violation summary on FAIL, the skip reason on SKIP. */
  readonly detail?: string;
  /**
   * True on a `SKIP` when the leg applies but gave no verdict. The scan did not
   * finish, or no first-party source root exists. The report lists such a skip
   * and marks the result degraded. A `SKIP` without it means that the
   * repository has no boundary config.
   */
  readonly degraded?: boolean;
}

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

/**
 * The scan roots of the import-boundary leg: the existing roots of the
 * `ownership.firstParty` globs, sorted. The list holds no duplicate and no
 * root inside another root. A root of `.` replaces all other roots.
 */
function firstPartyScanRoots(repoRoot: string, globs: readonly string[]): string[] {
  const roots = [...new Set(globs.flatMap((glob) => scanRootsOfGlob(repoRoot, glob)))].sort();
  if (roots.includes('.')) return ['.'];
  return roots.filter(
    (root) => !roots.some((other) => other !== root && root.startsWith(`${other}/`)),
  );
}

/** The parts of a dependency-cruiser JSON report that the leg reads. */
interface CruiseSummary {
  /** The number of violations of `error` severity, from `summary.error`. */
  readonly errorCount: number;
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

/**
 * Reads `summary.error` and the `error` violations from the stdout of
 * `depcruise --output-type json`. Output that is not a complete report gives
 * `undefined`, because a partial or absent report is not a verdict.
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
  if (typeof summary !== 'object' || summary === null || !('error' in summary)) return undefined;
  const errorCount = summary.error;
  if (typeof errorCount !== 'number' || !Number.isInteger(errorCount) || errorCount < 0) {
    return undefined;
  }
  const violations: unknown = 'violations' in summary ? summary.violations : undefined;
  const errorLines = Array.isArray(violations)
    ? violations.flatMap((violation: unknown) => errorViolationLine(violation))
    : [];
  return { errorCount, errorLines };
}

/** Text on stderr that shows that the Node heap was exhausted. */
const OUT_OF_MEMORY = /heap out of memory|allocation failed/i;

/** The most stderr lines that the detail of a degraded skip quotes. */
const SKIP_DETAIL_STDERR_LINES = 3;

/** A shell gives the exit status 128 plus the signal number for a process that a signal stopped. */
const SIGNAL_EXIT_BASE = 128;

/** The highest signal number that the exit-status hint names. */
const MAX_SIGNAL_NUMBER = 64;

/**
 * Names the cause when a depcruise run gave no verdict. The cause is the runner
 * error, a heap exhaustion, the signal, or the exit status with stderr.
 */
function noVerdictCause(result: CommandResult): string {
  if (result.spawnError === 'ENOBUFS') {
    return 'its JSON report passed the output limit of the runner (ENOBUFS)';
  }
  if (result.spawnError) return `the runner reported ${result.spawnError}`;
  if (OUT_OF_MEMORY.test(result.stderr)) return 'it ran out of memory';
  if (result.signal) return `it was stopped by ${result.signal}`;
  const code = result.exitCode;
  const signalNumber = code - SIGNAL_EXIT_BASE;
  const status =
    signalNumber > 0 && signalNumber <= MAX_SIGNAL_NUMBER
      ? `exit ${code}, the status of a process stopped by signal ${signalNumber}`
      : `exit ${code}`;
  const stderr = result.stderr
    .trim()
    .split('\n')
    .slice(0, SKIP_DETAIL_STDERR_LINES)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join(' ');
  return `it gave no JSON report (${status})${stderr ? `: ${stderr}` : ''}`;
}

/** A degraded `SKIP` of the boundary leg, with the cause in its detail. */
function boundaryNoVerdict(cause: string): BoundaryLintResult {
  return { status: 'SKIP', degraded: true, detail: `dependency-cruiser gave no verdict: ${cause}` };
}

/**
 * Runs `npx depcruise --validate <config> --output-type json` over the roots of
 * `ownership.firstParty`, so nested worktrees and build output stay out. The
 * verdict is `summary.error` of the JSON report. The leg does not read the
 * exit code, because 256 errors wrap to exit 0.
 * - No config: `SKIP`, and depcruise does not run.
 * - `summary.error` is 0: `PASS`. Above 0: `FAIL`, with the violations in `detail`.
 * - No first-party root, a throw, a runner error, a signal, or no complete
 *   report: a degraded `SKIP` that names the cause.
 */
export function runBoundaryLint(input: BoundaryLintInput): BoundaryLintResult {
  const { repoRoot, runCommand, firstPartyGlobs = DEFAULT_FIRST_PARTY_GLOBS } = input;

  const configName = findBoundaryConfig(repoRoot);
  if (configName === null) {
    return {
      status: 'SKIP',
      detail: `no ${BOUNDARY_CONFIG_FILENAMES[0]} in repo root`,
    };
  }

  const roots = firstPartyScanRoots(repoRoot, firstPartyGlobs);
  if (roots.length === 0) {
    return boundaryNoVerdict(
      `no ownership.firstParty source root exists (${firstPartyGlobs.join(', ')})`,
    );
  }

  let result: CommandResult;
  try {
    result = runCommand(
      'npx',
      ['depcruise', '--validate', configName, '--output-type', 'json', ...roots],
      { cwd: repoRoot },
    );
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return boundaryNoVerdict(`the tool is not available (${message})`);
  }

  if (result.spawnError || result.signal) return boundaryNoVerdict(noVerdictCause(result));
  const summary = readCruiseSummary(result.stdout);
  if (summary === undefined) return boundaryNoVerdict(noVerdictCause(result));
  if (summary.errorCount === 0) return { status: 'PASS' };

  const count = summary.errorCount;
  const header = `dependency-cruiser found ${count} ${count === 1 ? 'violation' : 'violations'} of error severity`;
  const detail = capFailDetail(
    [header, ...summary.errorLines].join('\n'),
    `npx depcruise --validate ${configName} ${roots.join(' ')}`,
  );
  return { status: 'FAIL', detail };
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

/** Verdict of the boundary-parse taint leg. `SKIP` is advisory and does not block. */
export interface RawIoTaintResult {
  readonly status: 'PASS' | 'FAIL' | 'SKIP';
  /** Human detail: the violation summary on FAIL, the skip reason on SKIP. */
  readonly detail?: string;
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
 * Runs the boundary-parse taint leg with
 * `semgrep --error --quiet --config <ruleset> <coreSources...>`. The ruleset
 * checks that untrusted input passes a registered parser before it enters the
 * core. Import rules cannot see value flow, so this leg uses a dataflow engine.
 * - No ruleset: `SKIP`, and the engine does not run.
 * - Exit 0: `PASS`. Exit 1: `FAIL`, with the findings in `detail`.
 * - A throw, a `spawnError`, a `signal`, or any other exit code: `SKIP`. An
 *   engine error or a killed process is not evidence of a violation.
 */
export function runRawIoTaint(input: RawIoTaintInput): RawIoTaintResult {
  const { repoRoot, runCommand, coreSources = ['.'] } = input;

  const ruleset = findTaintRuleset(repoRoot);
  if (ruleset === null) {
    return {
      status: 'SKIP',
      detail: `no ${TAINT_RULESET_FILENAMES[0]} in repo`,
    };
  }

  let result: CommandResult;
  try {
    result = runCommand(
      'semgrep',
      ['--error', '--quiet', '--config', ruleset, ...coreSources],
      { cwd: repoRoot },
    );
  } catch {
    return { status: 'SKIP', detail: 'semgrep not available' };
  }

  if (result.spawnError) {
    return {
      status: 'SKIP',
      detail: result.spawnError.trim() || 'semgrep not available',
    };
  }

  if (result.signal) {
    return { status: 'SKIP', detail: `semgrep was stopped by ${result.signal}` };
  }

  if (result.exitCode === 0) {
    return { status: 'PASS' };
  }

  if (result.exitCode !== 1) {
    return {
      status: 'SKIP',
      detail: result.stderr.trim() || `semgrep inconclusive (exit ${result.exitCode})`,
    };
  }

  const detail =
    result.stdout.trim() ||
    result.stderr.trim() ||
    'semgrep reported a boundary-parse violation';
  return { status: 'FAIL', detail };
}

type CheckStatus = 'PASS' | 'FAIL' | 'SKIP';

interface CheckResult {
  readonly name: string;
  readonly status: CheckStatus;
  readonly detail?: string;
}

/**
 * Check if an npm script exists in the package.json scripts field.
 */
function hasNpmScript(packageJson: Record<string, unknown>, scriptName: string): boolean {
  const scripts = packageJson['scripts'];
  if (typeof scripts !== 'object' || scripts === null) return false;
  return scriptName in (scripts as Record<string, unknown>);
}

/**
 * Read and parse package.json from a directory.
 * Returns `{ packageJson }` on success or `{ error }` on failure.
 */
function readPackageJson(
  repoRoot: string,
): { packageJson: Record<string, unknown> } | { error: string } {
  const pkgPath = path.join(repoRoot, 'package.json');
  try {
    const raw = fs.readFileSync(pkgPath, 'utf-8');
    return { packageJson: JSON.parse(raw) as Record<string, unknown> };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { error: `Failed to read ${pkgPath}: ${message}` };
  }
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
 * A path-like token that ends in a known source extension. It attributes each
 * transcript line to a file. It matches tsc (`src/foo.ts(12,5):`), eslint
 * stylish headers (`/abs/src/foo.ts`), eslint unix output (`src/foo.ts:12:5:`),
 * and bare file names (`foo.ts`).
 */
const FILE_TOKEN_RE =
  /(?:\.{0,2}\/)?(?:[\w.-]+\/)*[\w.-]+\.(?:tsx?|jsx?|mts|cts|mjs|cjs|cs|go|rs|py|json|vue|svelte)\b/;

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

function runNpmCheck(
  name: string,
  scriptName: string,
  packageJson: Record<string, unknown>,
  repoRoot: string,
  runCommand: RunCommandFn,
  skip: boolean
): CheckResult {
  if (skip) {
    return { name, status: 'SKIP', detail: `--skip-${scriptName.replace('quality-', '')}` };
  }

  if (!hasNpmScript(packageJson, scriptName)) {
    return { name, status: 'SKIP', detail: `no '${scriptName}' script in package.json` };
  }

  try {
    const result = runCommand('npm', ['run', scriptName], { cwd: repoRoot });
    if (result.exitCode === 0) {
      return { name, status: 'PASS' };
    }
    const detail = capFailDetail(
      result.stderr.trim() ||
        result.stdout.trim() ||
        `npm run ${scriptName} failed`,
      `npm run ${scriptName}`,
    );
    return { name, status: 'FAIL', detail };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { name, status: 'FAIL', detail: message };
  }
}

type ProjectType = 'Node.js' | '.NET' | 'Rust' | 'Go';

/**
 * The toolchain ids that this gate has check runners for, mapped to the report
 * label. The shared registry does the detection. A toolchain without a runner
 * here gives `skip`.
 */
const SUPPORTED_TOOLCHAINS: Readonly<Record<string, ProjectType>> = {
  node: 'Node.js',
  dotnet: '.NET',
  rust: 'Rust',
  go: 'Go',
};

/** Markers (registry-sourced) for the gate's supported toolchains, for the SKIP message. */
function supportedMarkers(): string[] {
  return Object.keys(SUPPORTED_TOOLCHAINS).flatMap(
    (id) => BUILTIN_TOOLCHAINS.find((t) => t.id === id)?.markers ?? [],
  );
}

/**
 * Detect project type via the shared toolchain registry, narrowed to the
 * toolchains this gate can actually check. Returns undefined when nothing is
 * detected or the detected toolchain has no runner here.
 */
function detectProjectType(repoRoot: string): ProjectType | undefined {
  const toolchain = detectToolchain(repoRoot);
  if (toolchain && toolchain.id in SUPPORTED_TOOLCHAINS) {
    return SUPPORTED_TOOLCHAINS[toolchain.id];
  }
  return undefined;
}

function runGenericCheck(
  name: string,
  cmd: string,
  args: readonly string[],
  repoRoot: string,
  runCommand: RunCommandFn,
  skip: boolean,
): CheckResult {
  if (skip) {
    return { name, status: 'SKIP', detail: 'skipped by flag' };
  }

  try {
    const result = runCommand(cmd, args, { cwd: repoRoot });
    if (result.exitCode === 0) {
      return { name, status: 'PASS' };
    }
    const rerun = `${cmd} ${args.join(' ')}`;
    const detail = capFailDetail(
      result.stderr.trim() || result.stdout.trim() || `${rerun} failed`,
      rerun,
    );
    return { name, status: 'FAIL', detail };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { name, status: 'FAIL', detail: message };
  }
}

function runNodeChecks(
  repoRoot: string,
  runCommand: RunCommandFn,
  skipLint: boolean,
  skipTypecheck: boolean,
): CheckResult[] {
  const pkgResult = readPackageJson(repoRoot);
  if ('error' in pkgResult) {
    return [{ name: 'package.json', status: 'FAIL', detail: pkgResult.error }];
  }
  const { packageJson } = pkgResult;

  return [
    runNpmCheck('Lint', 'lint', packageJson, repoRoot, runCommand, skipLint),
    runNpmCheck('Typecheck', 'typecheck', packageJson, repoRoot, runCommand, skipTypecheck),
    runNpmCheck('Quality check', 'quality-check', packageJson, repoRoot, runCommand, false),
  ];
}

function runDotnetChecks(
  repoRoot: string,
  runCommand: RunCommandFn,
  skipLint: boolean,
  skipTypecheck: boolean,
): CheckResult[] {
  return [
    runGenericCheck('Build', 'dotnet', ['build', '--no-restore', '-warnaserror'], repoRoot, runCommand, skipLint && skipTypecheck),
  ];
}

function runGoChecks(
  repoRoot: string,
  runCommand: RunCommandFn,
  skipLint: boolean,
  skipTypecheck: boolean,
): CheckResult[] {
  return [
    runGenericCheck('Vet', 'go', ['vet', './...'], repoRoot, runCommand, skipLint),
  ];
}

function runRustChecks(
  repoRoot: string,
  runCommand: RunCommandFn,
  skipLint: boolean,
  skipTypecheck: boolean,
): CheckResult[] {
  return [
    runGenericCheck('Check', 'cargo', ['check'], repoRoot, runCommand, skipTypecheck),
    runGenericCheck('Clippy', 'cargo', ['clippy', '--', '-D', 'warnings'], repoRoot, runCommand, skipLint),
  ];
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
 * Runs the checks for the detected project type and builds the report. The
 * boundary-lint and taint legs join the checks only when they do not give
 * `SKIP`, so a repo without their config sees no change. A degraded boundary
 * `SKIP` goes to `advisorySkips`: the report lists it and marks the result
 * degraded, and the status does not change. A skipped check counts as a
 * result. The precedence is FAIL, then DEGRADED (`skip`), then PASS, so PASS
 * needs every check to run and pass.
 */
export function runStaticAnalysis(input: StaticAnalysisInput): StaticAnalysisResult {
  const { repoRoot, skipLint = false, skipTypecheck = false, runCommand } = input;

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

  const projectType = detectProjectType(repoRoot);

  if (!projectType) {
    const output = [
      '## Static Analysis Report',
      '',
      `**Repository:** \`${repoRoot}\``,
      '',
      `- **SKIP**: No recognized project type (none of: ${supportedMarkers().join(', ')})`,
      '',
      '---',
      '',
      '**Result: SKIP** (no applicable toolchain detected)',
    ].join('\n');

    return {
      status: 'skip',
      output,
      skipReason: 'no-toolchain',
      passCount: 0,
      failCount: 0,
      skipCount: 0,
      projectType: undefined,
    };
  }

  let checks: CheckResult[];
  switch (projectType) {
    case 'Node.js':
      checks = runNodeChecks(repoRoot, runCommand, skipLint, skipTypecheck);
      break;
    case '.NET':
      checks = runDotnetChecks(repoRoot, runCommand, skipLint, skipTypecheck);
      break;
    case 'Go':
      checks = runGoChecks(repoRoot, runCommand, skipLint, skipTypecheck);
      break;
    case 'Rust':
      checks = runRustChecks(repoRoot, runCommand, skipLint, skipTypecheck);
      break;
  }

  const advisorySkips: AdvisorySkip[] = [];
  const boundary = runBoundaryLint({
    repoRoot,
    runCommand,
    firstPartyGlobs: input.firstPartyGlobs,
  });
  if (boundary.status !== 'SKIP') {
    checks.push({
      name: BOUNDARY_LINT_NAME,
      status: boundary.status,
      ...(boundary.detail ? { detail: boundary.detail } : {}),
    });
  } else if (boundary.degraded === true) {
    advisorySkips.push({
      name: BOUNDARY_LINT_NAME,
      detail: boundary.detail ?? 'dependency-cruiser gave no verdict',
    });
  }

  const taint = runRawIoTaint({ repoRoot, runCommand });
  if (taint.status !== 'SKIP') {
    checks.push({
      name: BOUNDARY_TAINT_NAME,
      status: taint.status,
      ...(taint.detail ? { detail: taint.detail } : {}),
    });
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
    `**Project type:** ${projectType}`,
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
    outputLines.push(
      `**Result: DEGRADED** (${passCount}/${total} checks passed, ` +
        `${skipCount} skipped — inconclusive, not a pass${note})`,
    );
  } else {
    outputLines.push(`**Result: PASS** (${passCount}/${total} checks passed${note})`);
  }

  const output = outputLines.join('\n');

  const status: StaticAnalysisResult['status'] =
    failCount > 0 ? 'fail' : skipCount > 0 ? 'skip' : 'pass';

  const skippedChecks = checks
    .filter((check) => check.status === 'SKIP')
    .map(({ name, detail }): StaticAnalysisSkippedCheck => (detail === undefined ? { name } : { name, detail }));

  return {
    status,
    output,
    ...(status === 'skip' ? { skipReason: 'constituent-skipped' as const, skippedChecks } : {}),
    passCount,
    failCount,
    skipCount,
    projectType,
    ...(advisorySkips.length > 0 ? { advisorySkips } : {}),
  };
}
