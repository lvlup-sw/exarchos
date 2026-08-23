// ─── Spec Coverage Check Handler ────────────────────────────────────────────
//
// Pure TypeScript port of scripts/spec-coverage-check.sh.
// Verifies test coverage for spec compliance by checking plan references
// against on-disk test files and, optionally, exercising them by running the
// governed repository's own resolved test suite.
//
// ── What the execution leg does and does not establish ──────────────────────
// It runs the resolved test command WHOLE, once, and reports that. It does not
// hand the runner a declared test path: which argv form selects a single file
// is per-runner knowledge that the toolchain source of truth does not carry,
// and the naive form is wrong in the dangerous direction — `cargo test <path>`
// reads its argument as a test-NAME substring, matches nothing, and exits
// zero, which is a green verdict over an unexecuted file. Running the suite is
// the claim this check can actually back on every toolchain the resolver
// resolves, and it strictly covers the declared files it collects. The one
// thing it cannot see is a declared file the suite does not collect at all;
// per-file selection returns here when the registry carries a selector form.
// ────────────────────────────────────────────────────────────────────────────

import { existsSync, readFileSync } from 'node:fs';
import { runCommandSync } from '../../utils/process.js';
import { join } from 'node:path';
import { toPosix } from '../../utils/paths.js';
import type { ToolResult } from '../../format.js';
import { resolveTestRuntime, type ResolvedRuntime } from '../../config/test-runtime-resolver.js';
import { splitCommand } from '../../config/tokenize-command.js';
import { classifyCommandFailure, inconclusiveReason } from '../pure/command-outcome.js';

// ─── Types ──────────────────────────────────────────────────────────────────

/**
 * The lifecycle point a coverage check runs at (WFQ-010):
 * - `plan`: plan-syntax + traceability validation. Declared test paths are
 *   validated for well-formedness only — a not-yet-created test file is a valid
 *   forward declaration and does NOT fail the check. Nothing touches disk.
 * - `post-implementation`: implementation-coverage validation. Declared test
 *   files must exist on disk AND their tests must actually run and pass.
 */
export type SpecCoveragePhase = 'plan' | 'post-implementation';

export interface SpecCoverageCheckArgs {
  readonly planFile: string;
  readonly repoRoot: string;
  readonly skipRun?: boolean;
  /**
   * Which semantics to apply (WFQ-010). Named `coveragePhase`, not `phase`:
   * the registration schema flattens field names across every action and
   * `check_test_adequacy` already owns a free-form `phase: z.string()`, so the
   * two collide on base type at server construction. See the registry entry.
   */
  readonly coveragePhase?: SpecCoveragePhase;
}

interface CheckEntry {
  /**
   * `SKIP` is a decision — the caller waived execution — and may leave a green
   * report. `INDETERMINATE` is the absence of one: the check could not be
   * performed, so the gate certifies nothing.
   */
  readonly status: 'PASS' | 'FAIL' | 'SKIP' | 'INDETERMINATE';
  readonly name: string;
  readonly detail?: string;
}

interface SpecCoverageResult {
  readonly phase: SpecCoveragePhase;
  readonly passed: boolean;
  readonly totalTests: number;
  /** plan phase: well-formed count; post-implementation phase: on-disk count. */
  readonly found: number;
  /** post-implementation phase: declared-but-absent test files. */
  readonly missing: readonly string[];
  /** plan phase: declared paths that are not valid test-path declarations. */
  readonly malformed: readonly string[];
  /**
   * Checks that could not be performed, one reason each — a peer of `missing`
   * and `malformed`, reported to whoever called this action and to nothing
   * else. It is deliberately NOT the gate runner's `skipped` descriptor: this
   * action is not registered as a gate class, so a carrier spelled in that
   * vocabulary would be read by no one while looking as though it were.
   */
  readonly indeterminate: readonly string[];
  readonly report: string;
}

// ─── Test File Extraction ───────────────────────────────────────────────────

const TEST_FILE_PATTERN = /\*\*Test file:\*\*\s*`([^`]+)`/;
const BACKTICK_PATH_PATTERN = /`([^`]+)`/g;

/**
 * A path that names a test file: `foo.test.ts`, `foo.spec.tsx`, `foo.test.mjs`,
 * etc. Used both to pick test paths out of the unified spec's `**Files:**` list
 * and to validate plan-time path well-formedness.
 */
const TEST_PATH_SUFFIX = /\.(test|spec)\.[cm]?[jt]sx?$/i;

/**
 * Extract test file paths declared in a plan/spec markdown document.
 *
 * Recognizes two forms:
 * 1. The legacy explicit declaration: `**Test file:** `src/widget.test.ts``.
 * 2. The canonical unified spec's per-task `**Files:**` list, where test files
 *    appear as backticked paths among implementation files — any backticked
 *    path that names a test file (`*.test.*` / `*.spec.*`) is collected.
 *
 * Duplicates are collapsed, preserving first-seen order.
 */
export function extractTestFiles(planContent: string): readonly string[] {
  const files: string[] = [];
  const seen = new Set<string>();

  const add = (candidate: string): void => {
    if (!seen.has(candidate)) {
      seen.add(candidate);
      files.push(candidate);
    }
  };

  for (const line of planContent.split('\n')) {
    // Legacy explicit declaration wins for the line.
    const explicit = TEST_FILE_PATTERN.exec(line);
    if (explicit?.[1] !== undefined) {
      add(explicit[1]);
      continue;
    }
    // Unified `**Files:**` list: any backticked path naming a test file.
    for (const match of line.matchAll(BACKTICK_PATH_PATTERN)) {
      const candidate = match[1];
      if (candidate !== undefined && TEST_PATH_SUFFIX.test(candidate)) {
        add(candidate);
      }
    }
  }

  return files;
}

/**
 * Plan-time well-formedness of a declared test path (WFQ-010). Returns `null`
 * when the path is a valid forward declaration, or a human-readable reason
 * when it is not.
 *
 * Existence on disk is intentionally NOT considered here: at plan time a
 * not-yet-created test file is a legitimate declaration. Only the SHAPE of the
 * path is validated — repo-relative, no parent-escape, names a test file.
 */
export function testPathWellFormednessError(testPath: string): string | null {
  const trimmed = testPath.trim();
  if (trimmed.length === 0) {
    return 'Empty test path';
  }
  if (/^(?:[a-zA-Z]:[\\/]|[\\/])/.test(trimmed)) {
    return 'Absolute path — declare a repo-relative test path instead';
  }
  if (trimmed.split(/[\\/]/).includes('..')) {
    return 'Path escapes the repo root via a ".." segment';
  }
  if (!TEST_PATH_SUFFIX.test(trimmed)) {
    return 'Does not name a test file (expected a .test.<ext> or .spec.<ext> suffix)';
  }
  return null;
}

// ─── Report Generation ─────────────────────────────────────────────────────

function generateReport(
  phase: SpecCoveragePhase,
  planFile: string,
  repoRoot: string,
  totalTests: number,
  found: number,
  missingList: readonly string[],
  malformedList: readonly string[],
  checks: readonly CheckEntry[],
): string {
  const lines: string[] = [];
  const planTime = phase === 'plan';

  lines.push('## Spec Coverage Report');
  lines.push('');
  lines.push(
    `**Phase:** ${
      planTime
        ? 'plan (syntax + traceability declarations)'
        : 'post-implementation (existence + execution)'
    }`,
  );
  lines.push(`**Plan file:** \`${planFile}\``);
  lines.push(`**Repo root:** \`${repoRoot}\``);
  lines.push('');
  lines.push('### Coverage Summary');
  lines.push('');
  if (planTime) {
    lines.push(`- Declared test files: ${totalTests}`);
    lines.push(`- Well-formed declarations: ${found}`);
    lines.push(`- Malformed: ${malformedList.length}`);
  } else {
    lines.push(`- Planned test files: ${totalTests}`);
    lines.push(`- Found on disk: ${found}`);
    lines.push(`- Missing: ${totalTests - found}`);
  }
  lines.push('');

  if (planTime && malformedList.length > 0) {
    lines.push('### Malformed Test Paths');
    lines.push('');
    for (const f of malformedList) {
      lines.push(`- \`${f}\``);
    }
    lines.push('');
  }

  if (!planTime && missingList.length > 0) {
    lines.push('### Missing Test Files');
    lines.push('');
    for (const f of missingList) {
      lines.push(`- \`${f}\``);
    }
    lines.push('');
  }

  lines.push('### Check Results');
  lines.push('');
  for (const check of checks) {
    if (check.detail) {
      lines.push(`- **${check.status}**: ${check.name} — ${check.detail}`);
    } else {
      lines.push(`- **${check.status}**: ${check.name}`);
    }
  }

  const passCount = checks.filter((c) => c.status === 'PASS').length;
  const failCount = checks.filter((c) => c.status === 'FAIL').length;
  const unrunnable = checks.filter((c) => c.status === 'INDETERMINATE').length;
  const total = passCount + failCount;

  lines.push('');
  lines.push('---');
  lines.push('');

  if (unrunnable > 0) {
    lines.push(
      `**Result: INDETERMINATE** (${unrunnable} check(s) could not run; ` +
        `${passCount}/${total} of the rest passed)`,
    );
  } else if (failCount === 0 && totalTests > 0) {
    lines.push(`**Result: PASS** (${passCount}/${total} checks passed)`);
  } else {
    lines.push(`**Result: FAIL** (${failCount}/${total} checks failed)`);
  }

  return lines.join('\n');
}

// ─── Handler ────────────────────────────────────────────────────────────────

export function handleSpecCoverageCheck(args: SpecCoverageCheckArgs): ToolResult {
  const { planFile, repoRoot, skipRun = false, coveragePhase: phase = 'post-implementation' } = args;

  // Validate inputs
  if (!existsSync(planFile)) {
    return {
      success: false,
      error: { code: 'INVALID_INPUT', message: `Plan file not found: ${planFile}` },
    };
  }

  // Only the post-implementation phase touches the filesystem, so it is the
  // only phase that requires the repo root to exist on disk. Plan-time syntax
  // validation runs before any task (and often before the worktree is laid
  // down), so it must not depend on repoRoot existing.
  if (phase === 'post-implementation' && !existsSync(repoRoot)) {
    return {
      success: false,
      error: { code: 'INVALID_INPUT', message: `Repo root directory not found: ${repoRoot}` },
    };
  }

  // Read plan and extract test files
  const planContent = readFileSync(planFile, 'utf-8') as string;
  const testFiles = extractTestFiles(planContent);

  return phase === 'plan'
    ? runPlanSyntaxCheck(planFile, repoRoot, testFiles)
    : runImplementationCoverageCheck(planFile, repoRoot, testFiles, skipRun);
}

/**
 * Plan-time syntax + traceability validation (WFQ-010). Confirms the plan
 * declares test files and that every declared path is a well-formed forward
 * declaration. Deliberately performs NO on-disk existence check and NO test
 * execution — a test file the implementation tasks will create later is a
 * valid planning declaration, not a failure.
 */
function runPlanSyntaxCheck(
  planFile: string,
  repoRoot: string,
  testFiles: readonly string[],
): ToolResult {
  const checks: CheckEntry[] = [];
  const malformed: string[] = [];

  if (testFiles.length === 0) {
    checks.push({
      status: 'FAIL',
      name: 'Test files declared in plan',
      detail: 'No test files referenced in plan document',
    });
  }

  for (const testFile of testFiles) {
    const problem = testPathWellFormednessError(testFile);
    if (problem === null) {
      checks.push({ status: 'PASS', name: `Test path well-formed: ${testFile}` });
    } else {
      checks.push({
        status: 'FAIL',
        name: `Test path well-formed: ${testFile}`,
        detail: problem,
      });
      malformed.push(testFile);
    }
  }

  const wellFormed = testFiles.length - malformed.length;
  const passed = testFiles.length > 0 && malformed.length === 0;
  const report = generateReport(
    'plan',
    planFile,
    repoRoot,
    testFiles.length,
    wellFormed,
    [],
    malformed,
    checks,
  );

  const result: SpecCoverageResult = {
    phase: 'plan',
    passed,
    totalTests: testFiles.length,
    found: wellFormed,
    missing: [],
    malformed,
    indeterminate: [],
    report,
  };

  return { success: true, data: result };
}

// ─── Suite Runner ───────────────────────────────────────────────────────────

/**
 * Wall clock the suite is given. Generous, because a real suite legitimately
 * runs for minutes and a bound this loose can only be reached by a hang — and
 * declared, because a check with no bound is a check that can stop returning.
 */
const SUITE_TIMEOUT_MS = 15 * 60 * 1000;

type SuiteRunner =
  | {
      readonly kind: 'resolved';
      readonly command: string;
      readonly cmd: string;
      readonly args: readonly string[];
    }
  | { readonly kind: 'indeterminate'; readonly reason: string };

/**
 * The governed repository's own test command, taken from the toolchain source
 * of truth. Naming one runner here meant this check could only ever discharge
 * its obligation in a single ecosystem; a repository whose runtime does not
 * resolve now gets no verdict rather than a spawn that was never going to work.
 */
function resolveSuiteRunner(repoRoot: string): SuiteRunner {
  let runtime: ResolvedRuntime;
  try {
    runtime = resolveTestRuntime(repoRoot);
  } catch (err) {
    return { kind: 'indeterminate', reason: err instanceof Error ? err.message : String(err) };
  }
  if (runtime.source === 'unresolved' || runtime.test === null) {
    return {
      kind: 'indeterminate',
      reason:
        runtime.remediation ??
        `no test command resolves for '${repoRoot}', so declared tests could not be exercised`,
    };
  }
  try {
    const { cmd, args } = splitCommand(runtime.test);
    if (cmd === '') {
      return { kind: 'indeterminate', reason: `empty test command: '${runtime.test}'` };
    }
    return { kind: 'resolved', command: runtime.test, cmd, args };
  } catch (err) {
    return { kind: 'indeterminate', reason: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Post-implementation coverage validation (WFQ-010). Every declared test file
 * must exist on disk — checked per file — and, unless `skipRun`, the suite
 * that collects them must actually run and pass. This is the gate that must
 * remain honest: really-executed tests, not mere declarations, and no claim
 * finer-grained than what was executed.
 */
function runImplementationCoverageCheck(
  planFile: string,
  repoRoot: string,
  testFiles: readonly string[],
  skipRun: boolean,
): ToolResult {
  const checks: CheckEntry[] = [];
  let found = 0;
  const missingList: string[] = [];

  // Check: plan references test files
  if (testFiles.length === 0) {
    checks.push({
      status: 'FAIL',
      name: 'Test files in plan',
      detail: 'No test files referenced in plan document',
    });
  }

  // Check: each test file exists on disk
  for (const testFile of testFiles) {
    const fullPath = toPosix(join(repoRoot, testFile));
    if (existsSync(fullPath)) {
      checks.push({ status: 'PASS', name: `Test file exists: ${testFile}` });
      found++;
    } else {
      checks.push({
        status: 'FAIL',
        name: `Test file exists: ${testFile}`,
        detail: `Not found at ${fullPath}`,
      });
      missingList.push(testFile);
    }
  }

  // Check: the declared tests actually run and pass (unless skipRun). The
  // claim is deliberately suite-shaped — see the module header for why a
  // declared path is not appended to the resolved command.
  if (skipRun) {
    checks.push({ status: 'SKIP', name: 'Test execution (--skip-run)' });
  } else if (testFiles.length > 0 && missingList.length === 0) {
    const runner = resolveSuiteRunner(repoRoot);
    if (runner.kind === 'indeterminate') {
      checks.push({
        status: 'INDETERMINATE',
        name: 'Test execution',
        detail: runner.reason,
      });
    } else {
      const name = `Declared tests exercised by \`${runner.command}\``;
      try {
        runCommandSync(runner.cmd, runner.args, {
          cwd: repoRoot,
          timeout: SUITE_TIMEOUT_MS,
          stdio: 'pipe',
        });
        checks.push({ status: 'PASS', name });
      } catch (err: unknown) {
        // A runner that never started, or one killed at its wall clock, decided
        // nothing about these tests. Only a real non-zero exit is a failure.
        const failure = classifyCommandFailure(err);
        const reason = inconclusiveReason(runner.command, failure);
        checks.push(
          reason === null
            ? { status: 'FAIL', name, detail: `exit code ${failure.exitCode}` }
            : { status: 'INDETERMINATE', name: 'Test execution', detail: reason },
        );
      }
    }
  }

  // Build report
  const report = generateReport(
    'post-implementation',
    planFile,
    repoRoot,
    testFiles.length,
    found,
    missingList,
    [],
    checks,
  );

  const failCount = checks.filter((c) => c.status === 'FAIL').length;
  const unrunnable = checks
    .filter((c) => c.status === 'INDETERMINATE')
    .map((c) => c.detail ?? c.name);
  const passed = failCount === 0 && unrunnable.length === 0 && testFiles.length > 0;

  const result: SpecCoverageResult = {
    phase: 'post-implementation',
    passed,
    totalTests: testFiles.length,
    found,
    missing: missingList,
    malformed: [],
    indeterminate: unrunnable,
    report,
  };

  return { success: true, data: result };
}
