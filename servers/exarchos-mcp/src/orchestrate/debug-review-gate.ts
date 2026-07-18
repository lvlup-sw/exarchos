// ─── Debug Review Gate ───────────────────────────────────────────────────────
//
// Verifies that a debug fix has proper test coverage for the bug scenario.
// Checks for new test files in the diff and optionally runs the test suite.
// ─────────────────────────────────────────────────────────────────────────────

import { execFileSync } from 'node:child_process';
import { runCommandSync } from '../utils/process.js';
import { existsSync } from 'node:fs';
import type { ToolResult } from '../format.js';
import { resolveTestRuntime } from '../config/test-runtime-resolver.js';
import { splitCommand } from '../config/tokenize-command.js';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface DebugReviewGateArgs {
  readonly repoRoot: string;
  readonly baseBranch: string;
  readonly skipRun?: boolean;
}

interface CheckCounts {
  pass: number;
  fail: number;
  skip: number;
}

// ─── Constants ──────────────────────────────────────────────────────────────

const TEST_FILE_PATTERN = /\.(test|spec)\.(ts|js|sh)$/;

// ─── Handler ────────────────────────────────────────────────────────────────

export function handleDebugReviewGate(args: DebugReviewGateArgs): ToolResult {
  // Validate required args
  if (!args.repoRoot) {
    return {
      success: false,
      error: { code: 'INVALID_INPUT', message: 'repoRoot is required' },
    };
  }

  if (!args.baseBranch) {
    return {
      success: false,
      error: { code: 'INVALID_INPUT', message: 'baseBranch is required' },
    };
  }

  if (!existsSync(args.repoRoot)) {
    return {
      success: false,
      error: {
        code: 'INVALID_INPUT',
        message: `Repository root not found: ${args.repoRoot}`,
      },
    };
  }

  const checks: CheckCounts = { pass: 0, fail: 0, skip: 0 };
  const results: string[] = [];

  // ─── Check 1: New test files added ──────────────────────────────────────

  const changedFiles = getChangedFiles(args.repoRoot, args.baseBranch);

  if (changedFiles === null) {
    return {
      success: false,
      error: {
        code: 'DIFF_FAILED',
        message: `git diff failed for base branch '${args.baseBranch}' in ${args.repoRoot}`,
      },
    };
  }

  if (changedFiles.length === 0) {
    results.push(
      `- **FAIL**: New test files added — No changed files found between ${args.baseBranch} and HEAD`,
    );
    checks.fail++;
  } else {
    const testFiles = changedFiles.filter((f) => TEST_FILE_PATTERN.test(f));

    if (testFiles.length === 0) {
      results.push(
        '- **FAIL**: New test files added — No test files found in changed files',
      );
      checks.fail++;
    } else {
      const fileList = testFiles.join(', ');
      results.push(
        `- **PASS**: New test files added (${testFiles.length} test file(s): ${fileList})`,
      );
      checks.pass++;
    }
  }

  // ─── Check 2: Tests pass ────────────────────────────────────────────────

  if (args.skipRun) {
    results.push('- **SKIP**: Tests pass (--skip-run)');
    checks.skip++;
  } else if (changedFiles.length > 0) {
    const run = runTests(args.repoRoot);
    if (run.outcome === 'skip') {
      // Graceful skip (#1174 contract): an unresolved test runtime is a SKIP
      // with remediation, never a guessed package-manager invocation.
      results.push(`- **SKIP**: Tests pass — ${run.detail}`);
      checks.skip++;
    } else if (run.outcome === 'pass') {
      results.push('- **PASS**: Tests pass');
      checks.pass++;
    } else {
      results.push(`- **FAIL**: Tests pass — ${run.detail}`);
      checks.fail++;
    }
  } else {
    results.push('- **SKIP**: Tests pass (no changed files)');
    checks.skip++;
  }

  // ─── Build report ──────────────────────────────────────────────────────

  const passed = checks.fail === 0;
  const total = checks.pass + checks.fail;
  const report = buildReport(args.repoRoot, args.baseBranch, results, checks, passed, total);

  return {
    success: true,
    data: { passed, report, checks },
  };
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function getChangedFiles(repoRoot: string, baseBranch: string): string[] | null {
  try {
    const output = execFileSync(
      'git',
      ['diff', '--name-only', `${baseBranch}...HEAD`],
      { cwd: repoRoot, encoding: 'utf-8' },
    );
    return output
      .trim()
      .split('\n')
      .filter((line) => line.length > 0);
  } catch {
    // Fallback: try two-dot diff
    try {
      const output = execFileSync(
        'git',
        ['diff', '--name-only', baseBranch, 'HEAD'],
        { cwd: repoRoot, encoding: 'utf-8' },
      );
      return output
        .trim()
        .split('\n')
        .filter((line) => line.length > 0);
    } catch {
      return null;
    }
  }
}

/** Outcome of the resolver-routed test run. `detail` carries the resolved command or remediation. */
interface RunTestsResult {
  readonly outcome: 'pass' | 'fail' | 'skip';
  readonly detail: string;
}

/**
 * DR-26: the test command resolves through the layered toolchain resolver
 * (`resolveTestRuntime`, INV-6) instead of a hardcoded `npm run test:run` —
 * so a non-node repo, a monorepo root, or a `.exarchos.yml` override all run
 * the right command (#1537 class). Unresolved → graceful SKIP (#1174).
 */
function runTests(repoRoot: string): RunTestsResult {
  let resolved: ReturnType<typeof resolveTestRuntime>;
  try {
    resolved = resolveTestRuntime(repoRoot);
  } catch (err) {
    return { outcome: 'fail', detail: err instanceof Error ? err.message : String(err) };
  }

  if (resolved.source === 'unresolved') {
    return { outcome: 'skip', detail: resolved.remediation ?? 'no test runtime resolved' };
  }
  if (resolved.test === null) {
    return { outcome: 'skip', detail: 'no test runner detected' };
  }

  const { cmd, args } = splitCommand(resolved.test);
  if (cmd === '') {
    return { outcome: 'fail', detail: 'empty test command' };
  }
  try {
    // runCommandSync (not raw execFileSync): the resolved command may be a
    // package-manager shim whose `.cmd` launcher execFile refuses to start on
    // Windows since CVE-2024-27980 (#1623).
    runCommandSync(cmd, args as string[], {
      cwd: repoRoot,
      stdio: 'pipe',
    });
    return { outcome: 'pass', detail: resolved.test };
  } catch {
    return { outcome: 'fail', detail: `${resolved.test} failed` };
  }
}

function buildReport(
  repoRoot: string,
  baseBranch: string,
  results: readonly string[],
  checks: CheckCounts,
  passed: boolean,
  total: number,
): string {
  const lines: string[] = [
    '## Debug Review Gate',
    '',
    `**Repository:** \`${repoRoot}\``,
    `**Base branch:** \`${baseBranch}\``,
    '',
    ...results,
    '',
    '---',
    '',
  ];

  if (passed) {
    lines.push(`**Result: PASS** (${checks.pass}/${total} checks passed)`);
  } else {
    lines.push(`**Result: FAIL** (${checks.fail}/${total} checks failed)`);
  }

  return lines.join('\n');
}
