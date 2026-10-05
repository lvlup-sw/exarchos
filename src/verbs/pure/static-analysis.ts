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
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { detectToolchain, BUILTIN_TOOLCHAINS } from '../../config/toolchains.js';

/** Result of running an external command. */
export interface CommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  /**
   * Set when the command did not start (ENOENT, EACCES). The process did not
   * run, so `exitCode` and `stdout` are not authoritative. The integration-suite
   * gate uses it to tell a spawn error from a JSON-shape mismatch.
   */
  readonly spawnError?: string;
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
  /** External command runner (dependency injection). */
  readonly runCommand: RunCommandFn;
}

/**
 * Reason code for a `skip` status.
 * - `no-toolchain`: no supported project type in `repoRoot`.
 * - `constituent-skipped`: a toolchain was detected, but a check did not run.
 *   The result is inconclusive and cannot be a pass.
 */
export type StaticAnalysisSkipReason = 'no-toolchain' | 'constituent-skipped';

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
   * Source paths to validate. The default is `['.']`, because the `from` and
   * `to` rules in the config narrow the real surface.
   */
  readonly sources?: readonly string[];
}

/** Verdict of the import-boundary leg. `SKIP` is advisory and does not block. */
export interface BoundaryLintResult {
  readonly status: 'PASS' | 'FAIL' | 'SKIP';
  /** Human detail: the violation summary on FAIL, the skip reason on SKIP. */
  readonly detail?: string;
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

/**
 * Runs the import-boundary lint with `npx depcruise --validate` over
 * `repoRoot`. The leg checks the module import graph against the rules in a
 * committed dependency-cruiser config.
 * - No config: `SKIP`, and depcruise does not run.
 * - Exit 0: `PASS`.
 * - Non-zero exit: `FAIL`, with the violation summary in `detail`.
 * - The runner throws: `SKIP`, because a missing tool is not a failure.
 */
export function runBoundaryLint(input: BoundaryLintInput): BoundaryLintResult {
  const { repoRoot, runCommand, sources = ['.'] } = input;

  const configName = findBoundaryConfig(repoRoot);
  if (configName === null) {
    return {
      status: 'SKIP',
      detail: `no ${BOUNDARY_CONFIG_FILENAMES[0]} in repo root`,
    };
  }

  let result: CommandResult;
  try {
    result = runCommand(
      'npx',
      ['depcruise', '--validate', configName, ...sources],
      { cwd: repoRoot },
    );
  } catch {
    return { status: 'SKIP', detail: 'dependency-cruiser not available' };
  }

  if (result.exitCode === 0) {
    return { status: 'PASS' };
  }

  const detail =
    result.stderr.trim() ||
    result.stdout.trim() ||
    'dependency-cruiser reported a boundary violation';
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
 * - A throw, a `spawnError`, or any other exit code: `SKIP`. An engine error
 *   or a killed process is not evidence of a violation.
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
 * Runs the checks for the detected project type and builds the report. The
 * boundary-lint and taint legs join the checks only when they do not give
 * `SKIP`, so a repo without their config sees no change. A skipped check
 * counts as a result. The precedence is FAIL, then DEGRADED (`skip`), then
 * PASS, so PASS needs every check to run and pass.
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

  const boundary = runBoundaryLint({ repoRoot, runCommand });
  if (boundary.status !== 'SKIP') {
    checks.push({
      name: BOUNDARY_LINT_NAME,
      status: boundary.status,
      ...(boundary.detail ? { detail: boundary.detail } : {}),
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

  outputLines.push('');

  const total = passCount + failCount;

  outputLines.push('---');
  outputLines.push('');

  if (failCount > 0) {
    outputLines.push(`**Result: FAIL** (${failCount}/${total} checks failed)`);
  } else if (skipCount > 0) {
    outputLines.push(
      `**Result: DEGRADED** (${passCount}/${total} checks passed, ` +
        `${skipCount} skipped — inconclusive, not a pass)`,
    );
  } else {
    outputLines.push(`**Result: PASS** (${passCount}/${total} checks passed)`);
  }

  const output = outputLines.join('\n');

  const status: StaticAnalysisResult['status'] =
    failCount > 0 ? 'fail' : skipCount > 0 ? 'skip' : 'pass';

  return {
    status,
    output,
    ...(status === 'skip' ? { skipReason: 'constituent-skipped' as const } : {}),
    passCount,
    failCount,
    skipCount,
    projectType,
  };
}
