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
  /** Repository root containing package.json. */
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
 * Returns null if file doesn't exist or is invalid JSON.
 */
function readPackageJson(repoRoot: string): Record<string, unknown> | null {
  const pkgPath = path.join(repoRoot, 'package.json');
  try {
    const raw = fs.readFileSync(pkgPath, 'utf-8');
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
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
    return { name, status: 'FAIL', detail: `npm run ${scriptName} failed` };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { name, status: 'FAIL', detail: message };
  }
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

  // Validate repo root
  const packageJson = readPackageJson(repoRoot);
  if (!packageJson) {
    return {
      status: 'error',
      output: '',
      error: `No package.json found at ${repoRoot}`,
      passCount: 0,
      failCount: 0,
    };
  }

  // Run checks
  const checks: CheckResult[] = [];

  checks.push(
    runNpmCheck('Lint', 'lint', packageJson, repoRoot, runCommand, skipLint)
  );
  checks.push(
    runNpmCheck('Typecheck', 'typecheck', packageJson, repoRoot, runCommand, skipTypecheck)
  );
  checks.push(
    runNpmCheck('Quality check', 'quality-check', packageJson, repoRoot, runCommand, false)
  );

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
  };
}
