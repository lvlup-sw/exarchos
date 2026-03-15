/**
 * Static Analysis Gate
 *
 * Runs static analysis tools (lint, typecheck, quality-check) with structured
 * pass/fail output for the quality-review workflow.
 *
 * Port of scripts/static-analysis-gate.sh. Retains external tool invocation
 * via a configurable RunCommandFn but moves orchestration, output parsing,
 * and result formatting to TypeScript.
 *
 * Exit code semantics (mapped to status field):
 *   'pass'  = all checks pass (warnings OK)
 *   'fail'  = errors found in one or more tools
 *   'error' = usage error (missing repo root, no package.json)
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

// ============================================================
// PUBLIC TYPES
// ============================================================

/** Result of running an external command. */
export interface CommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * Signature for the external command runner.
 *
 * Abstracted to allow mocking in tests while retaining real execFileSync
 * in production use.
 */
export type RunCommandFn = (
  cmd: string,
  args: readonly string[],
  options?: { cwd?: string }
) => CommandResult;

export interface StaticAnalysisInput {
  /** Repository root to analyze. */
  readonly repoRoot: string;
  /** Skip lint check. */
  readonly skipLint?: boolean;
  /** Skip typecheck. */
  readonly skipTypecheck?: boolean;
  /** External command runner (dependency injection). */
  readonly runCommand: RunCommandFn;
}

export interface StaticAnalysisResult {
  /** Overall status: pass, fail, or error. */
  readonly status: 'pass' | 'fail' | 'error';
  /** Structured markdown report. */
  readonly output: string;
  /** Error message when status is 'error'. */
  readonly error?: string;
  /** Number of checks that passed. */
  readonly passCount: number;
  /** Number of checks that failed. */
  readonly failCount: number;
  /** Detected project type (undefined if no recognized project). */
  readonly projectType?: string;
}

// ============================================================
// INTERNAL TYPES
// ============================================================

type CheckStatus = 'PASS' | 'FAIL' | 'SKIP';

interface CheckResult {
  readonly name: string;
  readonly status: CheckStatus;
  readonly detail?: string;
}

// ============================================================
// HELPERS
// ============================================================

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

// ============================================================
// CHECK RUNNERS
// ============================================================

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
    const detail =
      result.stderr.trim() ||
      result.stdout.trim() ||
      `npm run ${scriptName} failed`;
    return { name, status: 'FAIL', detail };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { name, status: 'FAIL', detail: message };
  }
}

// ============================================================
// PROJECT TYPE DETECTION
// ============================================================

type ProjectType = 'Node.js' | '.NET' | 'Rust' | 'Go';

/**
 * Detect project type from files present in the repository root.
 * Returns undefined if no recognized project type is found.
 */
function detectProjectType(repoRoot: string): ProjectType | undefined {
  if (fs.existsSync(path.join(repoRoot, 'package.json'))) {
    return 'Node.js';
  }

  try {
    const entries = fs.readdirSync(repoRoot);
    if (entries.some((e) => String(e).endsWith('.csproj') || String(e).endsWith('.sln'))) {
      return '.NET';
    }
  } catch {
    // readdirSync failure — fall through
  }

  if (fs.existsSync(path.join(repoRoot, 'go.mod'))) {
    return 'Go';
  }

  if (fs.existsSync(path.join(repoRoot, 'Cargo.toml'))) {
    return 'Rust';
  }

  return undefined;
}

// ============================================================
// GENERIC CHECK RUNNER
// ============================================================

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
    const detail = result.stderr.trim() || result.stdout.trim() || `${cmd} ${args.join(' ')} failed`;
    return { name, status: 'FAIL', detail };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { name, status: 'FAIL', detail: message };
  }
}

// ============================================================
// PLATFORM-SPECIFIC CHECK RUNNERS
// ============================================================

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
    runGenericCheck('Vet', 'go', ['vet', './...'], repoRoot, runCommand, skipTypecheck),
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

// ============================================================
// MAIN FUNCTION
// ============================================================

export function runStaticAnalysis(input: StaticAnalysisInput): StaticAnalysisResult {
  const { repoRoot, skipLint = false, skipTypecheck = false, runCommand } = input;

  if (!repoRoot || repoRoot.trim().length === 0) {
    return {
      status: 'error',
      output: '',
      error: 'Missing repoRoot',
      passCount: 0,
      failCount: 0,
    };
  }

  // Detect project type
  const projectType = detectProjectType(repoRoot);

  if (!projectType) {
    const output = [
      '## Static Analysis Report',
      '',
      `**Repository:** \`${repoRoot}\``,
      '',
      '- **SKIP**: No recognized project type (no package.json, *.csproj, go.mod, or Cargo.toml)',
      '',
      '---',
      '',
      '**Result: PASS** (0/0 checks — no applicable toolchain detected)',
    ].join('\n');

    return {
      status: 'pass',
      output,
      passCount: 0,
      failCount: 0,
      projectType: undefined,
    };
  }

  // Run platform-specific checks
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

  // Tally results
  let passCount = 0;
  let failCount = 0;

  for (const check of checks) {
    if (check.status === 'PASS') passCount++;
    if (check.status === 'FAIL') failCount++;
  }

  // Build structured output
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

  if (failCount === 0) {
    outputLines.push(`**Result: PASS** (${passCount}/${total} checks passed)`);
  } else {
    outputLines.push(`**Result: FAIL** (${failCount}/${total} checks failed)`);
  }

  const output = outputLines.join('\n');

  return {
    status: failCount === 0 ? 'pass' : 'fail',
    output,
    passCount,
    failCount,
    projectType,
  };
}
