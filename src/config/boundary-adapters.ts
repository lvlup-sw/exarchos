/**
 * The boundary adapters: the two advisory legs of static analysis, one for dependency-cruiser and one for a semgrep taint ruleset.
 * This module is a registry module. It holds the config names, the seed argvs, the bin lookup, the report readers and the exit-code tables.
 * A repository overrides the seeds with `verification.boundaryChecks`, and the capsule pins the resolved checks.
 *
 * Each leg runs one check of the profile through {@link runBoundaryCheck}. The adapter of the check picks the report reader and the report label.
 * The module reads the runner types and the cause lists of static analysis as types only, so it forms no runtime cycle with that gate.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { capFailDetail } from '../verbs/pure/fail-detail.js';
import type {
  BoundaryNoVerdictCause,
  CommandResult,
  ProcessNoVerdictCause,
  RunCommandFn,
} from '../verbs/pure/static-analysis.js';
import type { VerificationProfile } from '../workflow/verification/profile.js';
import { DEFAULT_FIRST_PARTY_GLOBS } from './exarchos-config-schema.js';
import type { ExarchosConfigLoadFailure } from './load-exarchos-config.js';

/** One boundary check of the verification profile. */
type BoundaryCheck = VerificationProfile['boundaryChecks'][number];

/** Candidate config filenames for the boundary lint, in resolution order. */
const BOUNDARY_CONFIG_FILENAMES: readonly string[] = [
  '.dependency-cruiser.cjs',
  '.dependency-cruiser.js',
  '.dependency-cruiser.json',
  '.dependency-cruiser.mjs',
];

/** Report label for the boundary-lint leg. */
const BOUNDARY_LINT_NAME = 'Import boundaries';

/** The program of the seed of the boundary lint. The leg finds its bin in the repository and never fetches a package. */
const DEPCRUISE_PROGRAM = 'depcruise';

/** The flag that selects the report format of the boundary lint. The leg needs it, and a person who reruns the leg by hand does not. */
const CRUISER_OUTPUT_FLAG = '--output-type';

/** The flag that hides the messages of semgrep. A person who reruns the taint leg by hand leaves it out, to read those messages. */
const SEMGREP_QUIET_FLAG = '--quiet';

/** The seed of the boundary lint for one config name. */
function cruiserSeed(config: string): BoundaryCheck {
  return {
    adapter: 'dependency-cruiser',
    command: { state: 'resolved', argv: [DEPCRUISE_PROGRAM, '--validate', config, CRUISER_OUTPUT_FLAG, 'json'], source: 'detection' },
    config,
  };
}

/** The seed of the taint leg for one ruleset path. */
function taintSeed(config: string): BoundaryCheck {
  return {
    adapter: 'semgrep-taint',
    command: { state: 'resolved', argv: ['semgrep', '--error', SEMGREP_QUIET_FLAG, '--config', config], source: 'detection' },
    config,
  };
}

/**
 * The boundary seeds of a root: one check for each adapter whose config the root holds, the boundary lint first.
 * It reads directory listings only, so it spawns nothing. A root that cannot be read gives no check.
 */
export function boundaryChecksAt(root: string): BoundaryCheck[] {
  const cruiserConfig = findBoundaryConfig(root);
  const taintRuleset = findTaintRuleset(root);
  return [
    ...(cruiserConfig === null ? [] : [cruiserSeed(cruiserConfig)]),
    ...(taintRuleset === null ? [] : [taintSeed(taintRuleset)]),
  ];
}

/**
 * The detail of a leg whose check names a config that the root does not hold.
 * The profile names the check, so the leg fails. A pin wins over the worktree, and a deleted config cannot turn the leg off.
 */
function missingConfigDetail(check: BoundaryCheck, repoRoot: string): string {
  return (
    `the ${check.adapter} check names the config ${check.config}, and ${repoRoot} does not hold it, so the leg cannot run. ` +
    'A check of the profile cannot pass with no scan. Restore the file'
  );
}

export interface BoundaryLintInput {
  /** Repository root to scan for a `.dependency-cruiser.*` config. */
  readonly repoRoot: string;
  /** External command runner (dependency injection). */
  readonly runCommand: RunCommandFn;
  /**
   * The check of the profile. The leg runs its argv, with the scan roots after it, and a config that is absent fails the leg.
   * When absent, the leg takes the seed of the config at `repoRoot`, and a root with no config gives `NOT_CONFIGURED`.
   */
  readonly check?: BoundaryCheck | undefined;
  /**
   * The `ownership.firstParty` globs. The leg scans the source root of each
   * glob that exists. A glob whose walk stops at its first segment widens the
   * scan to the repository root, which takes in nested worktrees and build
   * output. The leg does not apply a negated glob. When absent, the leg uses
   * the schema default.
   */
  readonly firstPartyGlobs?: readonly string[] | undefined;
  /** The reason of a pinned `firstParty` term that does not resolve. When it is present, the leg fails and does not scan. */
  readonly unresolvedScope?: string | undefined;
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
 * - `FAIL`: `error` violations, or a fault inside the repository. The faults are a broken or absent boundary config, a
 *   usage error, and a scope that the leg cannot read (`project-config`). That is a project `.exarchos.yml` that does
 *   not load or cannot be read, or a pinned `firstParty` term that does not resolve.
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

/** The check that a leg with no pinned check takes: the seed of the config at `repoRoot`, or undefined when the root holds none. */
function seededCruiserCheck(repoRoot: string): BoundaryCheck | undefined {
  const configName = findBoundaryConfig(repoRoot);
  return configName === null ? undefined : cruiserSeed(configName);
}

/** The flags of a cruiser argv that a person reruns by hand: each flag but the report format that the leg reads. */
function cruiserRerunFlags(flags: readonly string[]): readonly string[] {
  const index = flags.indexOf(CRUISER_OUTPUT_FLAG);
  return index === -1 ? flags : [...flags.slice(0, index), ...flags.slice(index + 2)];
}

/**
 * Runs `node_modules/.bin/depcruise --validate <config> --output-type json`, or the argv of a check, over the `ownership.firstParty` roots.
 * The program `depcruise` resolves to the installed bin, so a missing install never fetches a package. Each other program runs as the argv names it.
 * The detail of each verdict names each glob that widens the scan, names no path, or is negated.
 * The adapter reads the JSON report, not the exit code, because 256 errors wrap to exit 0.
 * - No check and no config: `NOT_CONFIGURED`, and depcruise does not run. A check whose config is absent: `FAIL`.
 * - A project `.exarchos.yml` that does not load, or a pinned scope that does not resolve: `FAIL` with its cause, and depcruise does not run.
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
    unresolvedScope,
    projectConfigError,
  } = input;

  const check = input.check ?? seededCruiserCheck(repoRoot);
  if (check === undefined) {
    return { status: 'NOT_CONFIGURED', detail: `no ${BOUNDARY_CONFIG_FILENAMES[0]} in repo root` };
  }
  if (pathKind(repoRoot, check.config) === undefined) {
    return { status: 'FAIL', cause: 'config-or-usage', detail: missingConfigDetail(check, repoRoot) };
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

  if (unresolvedScope !== undefined) {
    return {
      status: 'FAIL',
      cause: 'project-config',
      detail: `the leg has no ownership.firstParty scope and does not scan the default roots in its place. ${unresolvedScope}`,
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

  const [program = '', ...flags] = check.command.argv;
  const installed = program === DEPCRUISE_PROGRAM;
  const bin = installed ? findDepcruise(repoRoot) : program;
  if (bin === undefined) {
    return boundaryNoVerdict(
      'missing-tool',
      `no node_modules/.bin/${depcruiseBinName(process.platform)} in ${repoRoot} or in a parent directory. ` +
        'Install dependency-cruiser in the repository, for example with npm install --save-dev dependency-cruiser. ' +
        'The gate does not fetch it from the registry',
      note,
    );
  }

  const shownProgram = installed ? path.relative(repoRoot, bin) || bin : bin;
  const rerun = [shownProgram, ...cruiserRerunFlags(flags), ...scope.roots].join(' ');
  let result: CommandResult;
  try {
    result = runCommand(bin, [...flags, ...scope.roots], { cwd: repoRoot });
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
   * The check of the profile. The leg runs its argv, with the core sources after it, and a ruleset that is absent fails the leg.
   * When absent, the leg takes the seed of the ruleset at `repoRoot`, and a root with no ruleset gives `NOT_CONFIGURED`.
   */
  readonly check?: BoundaryCheck | undefined;
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

/** The check that a leg with no pinned check takes: the seed of the ruleset at `repoRoot`, or undefined when the root holds none. */
function seededTaintCheck(repoRoot: string): BoundaryCheck | undefined {
  const ruleset = findTaintRuleset(repoRoot);
  return ruleset === null ? undefined : taintSeed(ruleset);
}

/**
 * Runs `semgrep --error --quiet --config <ruleset> <coreSources...>`, or the argv of a check, over the core sources.
 * The ruleset checks that untrusted input passes a registered parser before it enters the core.
 * The leg takes no project config error and no `firstParty` scope, because it scans the core sources.
 * No check and no ruleset gives `NOT_CONFIGURED`. A check whose ruleset is absent is `FAIL`.
 * Exit 0 is `PASS`, and exit 1 is `FAIL` with findings.
 * - `NO_VERDICT`: a throw, a runner error, a signal, a heap exhaustion, or the exit status of a signal stop or of a
 *   missing command. Exit 2 with the text of an engine out of resources or of a missing engine is `NO_VERDICT` too.
 * - `FAIL` with `ruleset-or-usage`: exit 4, 5, 7 or 8, the statuses of semgrep for a ruleset or a usage error.
 * - `FAIL` with `unknown-exit`: each other exit, exit 2 without that text included. Only a known fault outside the
 *   repository gives no verdict. The `--quiet` flag hides the messages of semgrep, so an engine fault can come here.
 */
export function runRawIoTaint(input: RawIoTaintInput): RawIoTaintResult {
  const { repoRoot, runCommand, coreSources = ['.'] } = input;

  const check = input.check ?? seededTaintCheck(repoRoot);
  if (check === undefined) {
    return { status: 'NOT_CONFIGURED', detail: `no ${TAINT_RULESET_FILENAMES[0]} in repo` };
  }
  if (pathKind(repoRoot, check.config) === undefined) {
    return { status: 'FAIL', cause: 'ruleset-or-usage', detail: missingConfigDetail(check, repoRoot) };
  }

  const [program = '', ...flags] = check.command.argv;
  let result: CommandResult;
  try {
    result = runCommand(program, [...flags, ...coreSources], { cwd: repoRoot });
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
  const command = [...check.command.argv.filter((token) => token !== SEMGREP_QUIET_FLAG), ...coreSources].join(' ');
  const rerun = `Re-run \`${command}\` without ${SEMGREP_QUIET_FLAG} to read its message`;
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

/** What one boundary check needs beside its check. Only the boundary lint reads the scope and the project config error. */
export type BoundaryCheckInput = Pick<
  BoundaryLintInput,
  'repoRoot' | 'runCommand' | 'firstPartyGlobs' | 'unresolvedScope' | 'projectConfigError'
>;

/** The result of one boundary check, with the report label of its adapter. */
export interface BoundaryLeg {
  readonly name: string;
  readonly result: BoundaryLintResult | RawIoTaintResult;
}

/**
 * Runs one check of the profile through the adapter that it names. The adapter gives the report label and the report reader.
 * The taint leg gets neither the scope nor the project config error, so a config that does not load fails only the boundary lint.
 */
export function runBoundaryCheck(check: BoundaryCheck, input: BoundaryCheckInput): BoundaryLeg {
  const { repoRoot, runCommand } = input;
  switch (check.adapter) {
    case 'dependency-cruiser':
      return { name: BOUNDARY_LINT_NAME, result: runBoundaryLint({ ...input, check }) };
    case 'semgrep-taint':
      return { name: BOUNDARY_TAINT_NAME, result: runRawIoTaint({ repoRoot, runCommand, check }) };
  }
}
