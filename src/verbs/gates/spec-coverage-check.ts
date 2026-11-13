/**
 * spec_coverage_check: checks the test files that a plan declares. At plan
 * time it checks only the shape of each declared path. After implementation,
 * each declared file must exist on disk, and its tests must run and pass.
 * The test terms of the verification profile say which path is a test and which command runs it.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_TEST_GLOBS } from '../../config/toolchains.js';
import { matchesTestName } from '../../config/verification-profile.js';
import { toPosix } from '../../utils/paths.js';
import type { ToolResult } from '../../format.js';
import type { EventStore } from '../../events/store.js';
import { matchesAnyGlob, testPathWellFormednessError as declaredTestPathError } from '../../workflow/design-record/test-path.js';
import { readValidatedDesignRecord } from '../../workflow/design-record/read.js';
import { createEvidenceSubject } from '../../workflow/admission/evidence-subject.js';
import { PROFILE_UNRESOLVED, type VerificationProfile } from '../../workflow/verification/profile.js';
import { runPhaseGateWithEvidence } from './gate-runner.js';
import { profileOf, withProfileRoute, type ProfiledGateArgs } from './gate-utils.js';
import { buildScopedTestRunner } from './test-adequacy-handler.js';
import type { RunOutcome } from './test-adequacy.js';

/**
 * The lifecycle point of a coverage check.
 * - `plan`: checks only the shape of each declared test path. A test file that
 *   does not exist yet is a valid forward declaration.
 * - `post-implementation`: each declared test file must exist on disk, and its
 *   tests must run and pass.
 */
export type SpecCoveragePhase = 'plan' | 'post-implementation';

export interface SpecCoverageCheckArgs extends ProfiledGateArgs {
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
  /** Set only when the check needs a term of the profile and the term is not resolved. */
  readonly discriminant?: typeof PROFILE_UNRESOLVED;
  /** The reason of the term that is not resolved, with the route of a remedy. */
  readonly reason?: string;
}

/** The probe term of the verification profile. */
type ProbeTerm = VerificationProfile['tests']['probe'];

/** What the test runs of one check give. */
interface TestRunsResult {
  readonly checks: readonly CheckEntry[];
  /** The reason of a probe command that is not resolved. No test ran. */
  readonly unresolvedReason?: string;
}

const TEST_FILE_PATTERN = /\*\*Test file:\*\*\s*`([^`]+)`/;
const BACKTICK_PATH_PATTERN = /`([^`]+)`/g;

/**
 * A declared path holds no whitespace and none of these characters, and it does not end in a dot.
 * A parenthesis stays legal, because `src/app/(auth)/page.test.tsx` is a real path and a quote already refuses a code text.
 * A bare name with no slash that starts with a dot is not a declared path. `.test.sh` and `.test.ts` are words in prose.
 */
const NOT_A_DECLARED_PATH = /[\s:*?{}'",]|\.$|^\.[^/]*$/;

/** The name of the check of the one run of a probe command in the `none` form. */
const UNSCOPED_RUN_CHECK = 'Tests pass: unscoped run, because the probe command takes no file list';

/**
 * Extracts the test file paths that a plan or spec declares, in first-seen
 * order with no duplicates. It reads two forms:
 * 1. The legacy `**Test file:**` declaration. It takes precedence for its line, because the author names the file as a test.
 * 2. A backticked path that a test-name glob of `globs` matches, as in a `**Files:**` list.
 *    A snapshot, a fixture or a directory that only a classification glob matches is not a declared test.
 *    A line anchor, a glob or a code text that a test-name glob matches is not a declared test. It is not a path.
 */
export function extractTestFiles(
  planContent: string,
  globs: readonly string[] = DEFAULT_TEST_GLOBS,
): readonly string[] {
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
      if (candidate !== undefined && !NOT_A_DECLARED_PATH.test(candidate) && matchesTestName(candidate, globs)) {
        add(candidate);
      }
    }
  }

  return files;
}

/** Checks the shape of a declared test path with the legacy default globs. */
export function testPathWellFormednessError(
  testPath: string,
  globs: readonly string[] = DEFAULT_TEST_GLOBS,
): string | null {
  return declaredTestPathError(testPath, globs);
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
 * can run before the worktree exists. A root that does not exist resolves the
 * co-located globs only. A glob term that is not resolved fails each phase.
 */
async function executeSpecCoverageCheck(args: SpecCoverageCheckArgs): Promise<ToolResult> {
  const { planFile, repoRoot, coveragePhase: phase = 'post-implementation' } = args;

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

  const { tests } = profileOf(args, repoRoot);
  const globTerm = tests.globs;
  if (globTerm.state === 'unresolved') {
    return unresolvedGlobsResult(phase, planFile, repoRoot, withProfileRoute(args, globTerm.reason));
  }

  const bytes = readFileSync(planFile);
  const record = readValidatedDesignRecord(bytes, planFile);
  if (record.kind === 'invalid') {
    return {
      success: false,
      error: { code: 'INVALID_DESIGN_RECORD', message: record.message },
      ...(record.findings === undefined ? {} : { data: { findings: record.findings } }),
    };
  }
  const testFiles = record.kind === 'typed'
    ? [...new Set(record.snapshot.tasks.flatMap((task) => task.testFiles))]
    : extractTestFiles(bytes.toString('utf8'), globTerm.globs);

  return phase === 'plan'
    ? runPlanSyntaxCheck(planFile, repoRoot, testFiles, globTerm.globs)
    : runImplementationCoverageCheck(args, testFiles, tests.probe, record.kind === 'typed' ? globTerm.globs : undefined);
}

/** The FAIL of a glob term that is not resolved. No path of the plan can read as a test, so the result declares none. */
function unresolvedGlobsResult(
  phase: SpecCoveragePhase,
  planFile: string,
  repoRoot: string,
  reason: string,
): ToolResult {
  const check: CheckEntry = {
    status: 'FAIL',
    name: 'Test globs resolved',
    detail: `${PROFILE_UNRESOLVED}: ${reason}`,
  };
  const result: SpecCoverageResult = {
    phase,
    passed: false,
    totalTests: 0,
    found: 0,
    missing: [],
    malformed: [],
    report: generateReport(phase, planFile, repoRoot, 0, 0, [], [], [check]),
    discriminant: PROFILE_UNRESOLVED,
    reason,
  };
  return { success: true, data: result };
}

/**
 * Plan-time check: the plan declares test files, and each declared path has a
 * valid shape. It does not look for the files on disk and runs no tests.
 */
function runPlanSyntaxCheck(
  planFile: string,
  repoRoot: string,
  testFiles: readonly string[],
  globs: readonly string[],
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
    const problem = testPathWellFormednessError(testFile, globs);
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

/** The reason of a declared test that the probe command cannot run. */
function runnerFitReason(files: readonly string[]): string {
  return (
    `the probe command cannot run the declared test files ${files.join(', ')}. ` +
    'Set verification.tests.probe to a command that runs them, or set verification.tests.globs to the test files that the probe command runs. ' +
    'In a root where more than one toolchain matches, set both keys. One probe for each toolchain is #1629.'
  );
}

/** The check of one run that started. Exit 0 passes, a red exit code fails, and any other end fails with no verdict. */
function checkOfRun(name: string, outcome: Exclude<RunOutcome, { kind: 'unresolved' }>): CheckEntry {
  if (outcome.kind === 'no-verdict') {
    return { status: 'FAIL', name, detail: `no verdict (${outcome.cause}): ${outcome.detail}` };
  }
  return { status: outcome.result === 'green' ? 'PASS' : 'FAIL', name };
}

/**
 * Runs the declared tests with the probe term, once for each file. The `none` form takes no file list, so it runs the command once.
 * A declared test that no glob of the probe term matches fails before any run. A term with no `globs` takes each file.
 * The runner of the kill probe checks the probe command at its first run. That runner gives the argv, the working directory, the limits and the scratch store.
 *
 * The check reads the probe globs only when the probe command is resolved, as the kill probe does.
 * Thus an unresolved command fails with `profile-unresolved`, not with the runner-fit reason.
 */
async function runDeclaredTests(
  args: SpecCoverageCheckArgs,
  testFiles: readonly string[],
  probe: ProbeTerm,
): Promise<TestRunsResult> {
  const probeGlobs = probe.command.state === 'resolved' ? probe.globs : undefined;
  const unfit = probeGlobs === undefined ? [] : testFiles.filter((file) => !matchesAnyGlob(file, probeGlobs));
  if (unfit.length > 0) {
    const detail = withProfileRoute(args, runnerFitReason(unfit));
    return { checks: [{ status: 'FAIL', name: 'Probe command runs each declared test', detail }] };
  }

  const { repoRoot } = args;
  const runTests = buildScopedTestRunner(probe, repoRoot);
  const unscoped = probe.files === 'none';
  const checks: CheckEntry[] = [];
  for (const files of unscoped ? [testFiles] : testFiles.map((file) => [file])) {
    const outcome = await runTests({ repoRoot, testFiles: files });
    if (outcome.kind === 'unresolved') {
      const unresolvedReason = withProfileRoute(args, outcome.reason);
      const detail = `${PROFILE_UNRESOLVED}: ${unresolvedReason}`;
      return { checks: [{ status: 'FAIL', name: 'Probe command resolved', detail }], unresolvedReason };
    }
    checks.push(checkOfRun(unscoped ? UNSCOPED_RUN_CHECK : `Test passes: ${files.join(', ')}`, outcome));
  }
  return { checks };
}

/**
 * Post-implementation check: each declared test file exists on disk. Unless
 * `skipRun` is set, each file then runs with the probe command of the profile.
 * The tests run only when no file is missing. Thus a probe command that is not
 * resolved fails the check only in a run.
 */
async function runImplementationCoverageCheck(
  args: SpecCoverageCheckArgs,
  testFiles: readonly string[],
  probe: ProbeTerm,
  typedGlobs: readonly string[] | undefined,
): Promise<ToolResult> {
  const { planFile, repoRoot, skipRun = false } = args;
  const checks: CheckEntry[] = [];
  let found = 0;
  const missingList: string[] = [];
  const malformed: string[] = [];
  let unresolvedReason: string | undefined;

  if (testFiles.length === 0) {
    checks.push({
      status: 'FAIL',
      name: 'Test files in plan',
      detail: 'No test files referenced in plan document',
    });
  }

  for (const testFile of testFiles) {
    const problem = typedGlobs === undefined ? null : testPathWellFormednessError(testFile, typedGlobs);
    if (problem !== null) {
      checks.push({ status: 'FAIL', name: `Test path well-formed: ${testFile}`, detail: problem });
      malformed.push(testFile);
      continue;
    }

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
  } else if (testFiles.length > 0 && missingList.length === 0 && malformed.length === 0) {
    const runs = await runDeclaredTests(args, testFiles, probe);
    checks.push(...runs.checks);
    unresolvedReason = runs.unresolvedReason;
  }

  const report = generateReport(
    'post-implementation',
    planFile,
    repoRoot,
    testFiles.length,
    found,
    missingList,
    malformed,
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
    malformed,
    report,
    ...(unresolvedReason === undefined ? {} : { discriminant: PROFILE_UNRESOLVED, reason: unresolvedReason }),
  };

  return { success: true, data: result };
}
