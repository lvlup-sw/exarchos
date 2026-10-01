/**
 * spec_coverage_check: checks the test files that a plan declares. At plan
 * time it checks only the shape of each declared path. After implementation,
 * each declared file must exist on disk, and its tests must run and pass.
 */

import { existsSync, readFileSync } from 'node:fs';
import { runCommandSync } from '../../utils/process.js';
import { join } from 'node:path';
import { toPosix } from '../../utils/paths.js';
import type { ToolResult } from '../../format.js';
import type { EventStore } from '../../events/store.js';
import { createEvidenceSubject } from '../../workflow/admission/evidence-subject.js';
import { runPhaseGateWithEvidence } from './gate-runner.js';

/**
 * The lifecycle point of a coverage check.
 * - `plan`: checks only the shape of each declared test path. A test file that
 *   does not exist yet is a valid forward declaration.
 * - `post-implementation`: each declared test file must exist on disk, and its
 *   tests must run and pass.
 */
export type SpecCoveragePhase = 'plan' | 'post-implementation';

export interface SpecCoverageCheckArgs {
  /** The stream the gate's durable evidence is recorded against. */
  readonly featureId: string;
  readonly planFile: string;
  readonly repoRoot: string;
  readonly skipRun?: boolean;
  /**
   * Which semantics to apply. The name is not `phase`, because the registration
   * schema flattens field names across all actions. `check_test_adequacy` has a
   * free-form `phase: z.string()`, and the two types collide at server start.
   */
  readonly coveragePhase?: SpecCoveragePhase;
}

interface CheckEntry {
  readonly status: 'PASS' | 'FAIL' | 'SKIP';
  readonly name: string;
  readonly detail?: string;
}

interface SpecCoverageResult {
  readonly phase: SpecCoveragePhase;
  readonly passed: boolean;
  readonly totalTests: number;
  /** In the plan phase, the well-formed count. After implementation, the on-disk count. */
  readonly found: number;
  /** post-implementation phase: declared-but-absent test files. */
  readonly missing: readonly string[];
  /** plan phase: declared paths that are not valid test-path declarations. */
  readonly malformed: readonly string[];
  readonly report: string;
}

const TEST_FILE_PATTERN = /\*\*Test file:\*\*\s*`([^`]+)`/;
const BACKTICK_PATH_PATTERN = /`([^`]+)`/g;

/**
 * A path that names a test file, such as `foo.test.ts` or `foo.spec.tsx`. It
 * picks test paths out of a plan and checks path shape at plan time.
 */
const TEST_PATH_SUFFIX = /\.(test|spec)\.[cm]?[jt]sx?$/i;

/**
 * Extracts the test file paths that a plan or spec declares, in first-seen
 * order with no duplicates. It reads two forms:
 * 1. The legacy `**Test file:**` declaration. It takes precedence for its line.
 * 2. Any backticked path that names a test file, as in a `**Files:**` list.
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
    const explicit = TEST_FILE_PATTERN.exec(line);
    if (explicit?.[1] !== undefined) {
      add(explicit[1]);
      continue;
    }
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
 * Checks the shape of a declared test path at plan time. It returns `null` for
 * a valid forward declaration, or a reason. The path must be repo-relative,
 * must not escape with `..`, and must name a test file. It does not check that
 * the file exists.
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
  const total = passCount + failCount;

  lines.push('');
  lines.push('---');
  lines.push('');

  if (failCount === 0 && totalTests > 0) {
    lines.push(`**Result: PASS** (${passCount}/${total} checks passed)`);
  } else {
    lines.push(`**Result: FAIL** (${failCount}/${total} checks failed)`);
  }

  return lines.join('\n');
}

/**
 * Runs the check through `runPhaseGateWithEvidence`. The runner records
 * durable gate evidence before a success result returns. The action declares
 * no catalog emissions, so it appends no `gate.executed` event of its own.
 */
export async function handleSpecCoverageCheck(
  args: SpecCoverageCheckArgs,
  stateDir: string,
  eventStore: EventStore,
): Promise<ToolResult> {
  if (!args.featureId) {
    return {
      success: false,
      error: { code: 'INVALID_INPUT', message: 'featureId is required' },
    };
  }

  return runPhaseGateWithEvidence({
    streamId: args.featureId,
    gateClass: 'spec-coverage',
    requirementId: 'requirement:spec-coverage',
    stateDir,
    eventStore,
    subject: (phaseAttemptId) =>
      createEvidenceSubject(
        { kind: 'phase-attempt', phaseAttemptId },
        { gate: 'spec-coverage', phase: 'planning' },
      ),
    providerInput: args,
    executeProvider: async () => executeSpecCoverageCheck(args),
  });
}

/**
 * Reads the plan and runs the check for `coveragePhase`. Only the
 * post-implementation phase requires `repoRoot` to exist, so the plan check
 * can run before the worktree exists.
 */
function executeSpecCoverageCheck(args: SpecCoverageCheckArgs): ToolResult {
  const { planFile, repoRoot, skipRun = false, coveragePhase: phase = 'post-implementation' } = args;

  if (!existsSync(planFile)) {
    return {
      success: false,
      error: { code: 'INVALID_INPUT', message: `Plan file not found: ${planFile}` },
    };
  }

  if (phase === 'post-implementation' && !existsSync(repoRoot)) {
    return {
      success: false,
      error: { code: 'INVALID_INPUT', message: `Repo root directory not found: ${repoRoot}` },
    };
  }

  const planContent = readFileSync(planFile, 'utf-8') as string;
  const testFiles = extractTestFiles(planContent);

  return phase === 'plan'
    ? runPlanSyntaxCheck(planFile, repoRoot, testFiles)
    : runImplementationCoverageCheck(planFile, repoRoot, testFiles, skipRun);
}

/**
 * Plan-time check: the plan declares test files, and each declared path has a
 * valid shape. It does not look for the files on disk and runs no tests.
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
    report,
  };

  return { success: true, data: result };
}

/**
 * Post-implementation check: each declared test file exists on disk. Unless
 * `skipRun` is set, each file then runs with `npx vitest run`. The tests run
 * only when no file is missing.
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

  if (testFiles.length === 0) {
    checks.push({
      status: 'FAIL',
      name: 'Test files in plan',
      detail: 'No test files referenced in plan document',
    });
  }

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

  if (skipRun) {
    checks.push({ status: 'SKIP', name: 'Test execution (--skip-run)' });
  } else if (testFiles.length > 0 && missingList.length === 0) {
    for (const testFile of testFiles) {
      try {
        runCommandSync('npx', ['vitest', 'run', '--root', repoRoot, testFile], {
          stdio: 'pipe',
        });
        checks.push({ status: 'PASS', name: `Test passes: ${testFile}` });
      } catch {
        checks.push({ status: 'FAIL', name: `Test passes: ${testFile}` });
      }
    }
  }

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
  const passed = failCount === 0 && testFiles.length > 0;

  const result: SpecCoverageResult = {
    phase: 'post-implementation',
    passed,
    totalTests: testFiles.length,
    found,
    missing: missingList,
    malformed: [],
    report,
  };

  return { success: true, data: result };
}
