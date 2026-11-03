/**
 * spec_coverage_check under the verification profile. The test terms of the profile say which path is a declared test and which command runs it.
 *
 * Each case calls the handler at a real temporary root, so the resolver reads real marker files.
 * `node:child_process` is a stub, so no process starts, and each call of the stub is one run of the probe command.
 * The evidence runner is a stub that calls only the provider.
 */

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

vi.mock('node:child_process', () => ({
  execFileSync: vi.fn(),
}));

vi.mock('../../../../src/verbs/gates/gate-runner.js', () => ({
  runPhaseGateWithEvidence: (request: { readonly executeProvider: () => Promise<ToolResult> }) => request.executeProvider(),
}));

import { execFileSync } from 'node:child_process';
import { EventStore } from '../../../../src/events/store.js';
import type { ToolResult } from '../../../../src/format.js';
import {
  extractTestFiles,
  handleSpecCoverageCheck,
  testPathWellFormednessError,
  type SpecCoverageCheckArgs,
} from '../../../../src/verbs/gates/spec-coverage-check.js';
import { rmrf } from '../../../../tools/test-helpers/temp-dir.js';
import {
  pinnedTestProfile,
  pinnedUnresolvedGlobProfile,
  UNRESOLVED_GLOBS_REASON,
  unscopedProbeTerm,
} from '../../../helpers/verification-profile.js';

/** The files of one root: the path of each file and its text. */
type Files = Readonly<Record<string, string>>;

/** The fields of the result that the cases read. The parse checks them, so no case trusts the shape of the data. */
const CoverageDataSchema = z.object({
  phase: z.string(),
  passed: z.boolean(),
  totalTests: z.number(),
  found: z.number(),
  malformed: z.array(z.string()),
  report: z.string(),
  discriminant: z.string().optional(),
  reason: z.string().optional(),
});

type CoverageData = z.infer<typeof CoverageDataSchema>;

let root: string;

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(execFileSync).mockReturnValue(Buffer.from(''));
  root = mkdtempSync(join(tmpdir(), 'spec-coverage-profile-'));
});

afterEach(() => {
  rmrf(root);
});

/** Writes each file under the root, and makes its directory first. */
function writeFiles(files: Files): void {
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), text);
  }
}

/** A `**Files:**` list that backticks each of `paths`. */
function filesList(paths: readonly string[]): string {
  return ['**Files:**', ...paths.map((file) => `- \`${file}\``)].join('\n');
}

/** Writes `plan` under the root and calls the handler. A case gives its phase, its pin and its skip in `extra`. */
async function check(plan: string, extra: Partial<SpecCoverageCheckArgs> = {}): Promise<CoverageData> {
  const planFile = join(root, 'plan.md');
  writeFileSync(planFile, plan);
  const result = await handleSpecCoverageCheck(
    { featureId: 'feat-spec-coverage-profile', planFile, repoRoot: root, ...extra },
    root,
    new EventStore(root),
  );
  expect(result.success, JSON.stringify(result)).toBe(true);
  return CoverageDataSchema.parse(result.data);
}

/** The program and the arguments of each run of the probe command. */
function runs(): readonly (readonly [string, readonly string[] | undefined])[] {
  return vi.mocked(execFileSync).mock.calls.map(([program, args]) => [program, args]);
}

describe('classification of a declared test', () => {
  /** The killing assertion: the old suffix accepts a text that ends in a test name. So the command is a declared test and a well-formed path. */
  it('SpecCoverage_ACommandStringInBackticks_IsNotATestPath', () => {
    const plan = ['Run `npx vitest run src/a.test.ts` to check it.', '- `src/a.test.ts`'].join('\n');

    expect(extractTestFiles(plan)).toEqual(['src/a.test.ts']);
    expect(testPathWellFormednessError('npx vitest run src/a.test.ts')).toContain('Does not name a test file');
  });

  /** The killing assertion: the old suffix refuses a C# path, so the plan declares no test and the check fails. */
  it('SpecCoverage_ADeclaredDotnetTest_MatchesTheResolvedGlobs', async () => {
    writeFiles({ 'App.sln': '' });

    const data = await check(filesList(['Tests/FooTests.cs']), { coveragePhase: 'plan' });

    expect(data.passed).toBe(true);
    expect(data.totalTests).toBe(1);
    expect(data.found).toBe(1);
  });

  /** A snapshot and a source map match a classification glob and no test-name glob. They are not tests, so the check runs no command for them. */
  it('SpecCoverage_ASnapshotPathInAFilesList_IsNotADeclaredTest', async () => {
    const paths = ['src/a.test.ts', 'tests/migration/__snapshots__/snapshots.test.ts.snap', 'src/a.test.ts.map'];
    writeFiles(Object.fromEntries(paths.map((file) => [file, ''])));

    const data = await check(filesList(paths), { verificationProfile: pinnedTestProfile(1) });

    expect(data.passed).toBe(true);
    expect(data.totalTests).toBe(1);
    expect(runs()).toEqual([['npm', ['run', 'test:files', '--', 'src/a.test.ts']]]);
  });

  /**
   * The Python test is the one declared test. A fixture matches only a directory glob, and `tests/conftest.py` matches a glob with no `*`.
   * The killing assertion: the old suffix refuses all three paths, so the plan declares no test and the check fails.
   */
  it('SpecCoverage_AFixtureAndAConftestPathInAPythonRoot_AreNotDeclaredTests', async () => {
    const paths = ['tests/test_parse.py', 'tests/fixtures/data.json', 'tests/conftest.py'];
    writeFiles({ 'pyproject.toml': '', ...Object.fromEntries(paths.map((file) => [file, ''])) });

    const data = await check(filesList(paths));

    expect(data.passed).toBe(true);
    expect(data.totalTests).toBe(1);
    expect(runs()).toEqual([['pytest', ['--', 'tests/test_parse.py']]]);
  });

  /**
   * The row of the Rust toolchain holds a directory glob only, so a bare path names no test. An explicit declaration takes each glob of the term.
   * The killing assertion: the check passes. The old suffix refuses the path with "Does not name a test file".
   */
  it('SpecCoverage_AnExplicitRustTestDeclaration_IsWellFormed', async () => {
    writeFiles({ 'Cargo.toml': '' });

    const data = await check('**Test file:** `tests/parse.rs`', { coveragePhase: 'plan' });

    expect(data.malformed).toEqual([]);
    expect(data.passed).toBe(true);
  });

  /**
   * A text in backticks can match a test-name glob and name no file. The final `*` of a glob takes `ts:83` or a quote, and it can be empty.
   * This case is a twin of `SpecCoverage_ADeclaredDotnetTest_MatchesTheResolvedGlobs`. The old suffix refuses each such text too, so a full revert does not change the declared tests.
   * Each text holds one part of the filter and no other, so a build that drops one part declares its text.
   */
  it('SpecCoverage_ALineAnchorAndAGlobInBackticks_AreNotDeclaredTests', async () => {
    writeFiles({ 'src/a.test.ts': '' });
    const plan = filesList([
      'src/a.test.ts',
      'tests/a.test.ts b',
      'tests/a.test.ts:83',
      '**/*.test.*',
      'tests/a.test.ts?',
      'tests/a.test.ts{',
      'tests/a.test.ts}',
      "tests/a.test.ts'",
      'tests/a.test.ts"',
      'tests/a.test.ts,',
      'tests/a.test.',
      '.test.sh',
    ]);

    const data = await check(plan, { verificationProfile: pinnedTestProfile(1) });

    expect(extractTestFiles(plan)).toEqual(['src/a.test.ts']);
    expect(data.passed).toBe(true);
    expect(data.totalTests).toBe(1);
    expect(runs()).toEqual([['npm', ['run', 'test:files', '--', 'src/a.test.ts']]]);
  });

  /**
   * A route group puts parentheses in a real path, so the filter of a declared path does not refuse them.
   * The killing assertion on a full revert: the old check runs another program, and the old suffix takes this path too.
   */
  it('SpecCoverage_APathWithParentheses_IsADeclaredTest', async () => {
    const path = 'src/app/(auth)/page.test.tsx';
    writeFiles({ [path]: '' });
    const plan = filesList([path]);

    const data = await check(plan, { verificationProfile: pinnedTestProfile(1) });

    expect(extractTestFiles(plan)).toEqual([path]);
    expect(data.passed).toBe(true);
    expect(data.totalTests).toBe(1);
    expect(runs()).toEqual([['npm', ['run', 'test:files', '--', path]]]);
  });
});

describe('the run of the declared tests', () => {
  /** The run takes the argv of the term and the root as its working directory. The killing assertion: the old check runs a fixed program and sets no `cwd`. */
  it('SpecCoverage_PostImplementation_RunsTheProbeCommandForEachFile', async () => {
    writeFiles({ 'src/a.test.ts': '', 'src/b.test.ts': '' });

    const data = await check(filesList(['src/a.test.ts', 'src/b.test.ts']), { verificationProfile: pinnedTestProfile(1) });

    expect(data.passed).toBe(true);
    expect(runs()).toEqual([
      ['npm', ['run', 'test:files', '--', 'src/a.test.ts']],
      ['npm', ['run', 'test:files', '--', 'src/b.test.ts']],
    ]);
    expect(vi.mocked(execFileSync).mock.calls[0]?.[2]).toMatchObject({ cwd: root });
  });

  /** The `none` form takes no file list, so one run covers each declared test, and the report says so. */
  it('SpecCoverage_TheNoneForm_RunsTheCommandOnceAndSaysTheRunIsUnscoped', async () => {
    writeFiles({ 'src/a.test.ts': '', 'src/b.test.ts': '' });

    const data = await check(filesList(['src/a.test.ts', 'src/b.test.ts']), {
      verificationProfile: pinnedTestProfile(1, { probe: unscopedProbeTerm(['dotnet', 'test']) }),
    });

    expect(data.passed).toBe(true);
    expect(runs()).toEqual([['dotnet', ['test']]]);
    expect(data.report).toContain('unscoped run');
  });

  /** An exit code outside the red codes gives no verdict. The killing assertion: the report text. The old check also fails here, and it names no end of the run. */
  it('SpecCoverage_AnUnknownExitCode_FailsWithNoVerdict', async () => {
    writeFiles({ 'src/a.test.ts': '' });
    vi.mocked(execFileSync).mockImplementation(() => {
      throw Object.assign(new Error('exit 7'), { status: 7 });
    });

    const data = await check(filesList(['src/a.test.ts']), { verificationProfile: pinnedTestProfile(1) });

    expect(data.passed).toBe(false);
    expect(data.report).toContain('no verdict (unknown-exit-code)');
    expect(data.report).toContain('the command exited 7');
  });

  /** The term holds C# globs, and the probe runs the co-located globs. The killing assertion: the report names both keys. The old suffix also fails the plan, and it names no key. */
  it('SpecCoverage_ADeclaredTestThatTheProbeCannotRun_FailsAndNamesBothKeys', async () => {
    writeFiles({ 'Tests/FooTests.cs': '' });
    const pin = pinnedTestProfile(3, { globs: { state: 'resolved', globs: ['**/*.test.*', '**/*Tests.cs'], source: 'detection' } });

    const data = await check(filesList(['Tests/FooTests.cs']), { verificationProfile: pin });

    expect(data.passed).toBe(false);
    expect(data.report).toContain('Tests/FooTests.cs');
    expect(data.report).toContain('verification.tests.probe');
    expect(data.report).toContain('verification.tests.globs');
    expect(data.report).toContain('#1629');
    expect(data.report).toContain('Capsule v3 pins this term');
    expect(runs()).toEqual([]);
  });

  /**
   * The root seeds `dotnet test`, whose globs do not hold a co-located test. The test is in `tests.globs`, so the plan declares it.
   * The killing assertion: no command runs. The old check runs a fixed command for the file, and the exit 0 of the stub passes it.
   */
  it('SpecCoverage_ACoLocatedTestInASolutionRoot_FailsAndRunsNoCommand', async () => {
    writeFiles({ 'App.sln': '', 'ClientApp/package.json': '{}', 'ClientApp/src/app.test.ts': '' });

    const data = await check(filesList(['ClientApp/src/app.test.ts']));

    expect(data.passed).toBe(false);
    expect(data.report).toContain('verification.tests.probe');
    expect(data.report).toContain('verification.tests.globs');
    expect(runs()).toEqual([]);
  });
});

describe('a term that is not resolved', () => {
  /** A root with no marker has no test command. The killing assertion: the old check runs a fixed command, and the exit 0 of the stub passes it. */
  it('SpecCoverage_AnUnresolvedProbe_FailsWithProfileUnresolved', async () => {
    writeFiles({ 'src/a.test.ts': '' });

    const data = await check(filesList(['src/a.test.ts']));

    expect(data.passed).toBe(false);
    expect(data.discriminant).toBe('profile-unresolved');
    expect(data.reason).toContain('tests.probe.command');
    expect(data.report).toContain('profile-unresolved');
    expect(runs()).toEqual([]);
  });

  /** The check runs no test in the plan phase or with `skipRun`, so the same root passes in each. */
  it('SpecCoverage_AnUnresolvedProbeInThePlanPhase_DoesNotFail', async () => {
    writeFiles({ 'src/a.test.ts': '' });
    const plan = filesList(['src/a.test.ts']);

    const planPhase = await check(plan, { coveragePhase: 'plan' });
    const skipped = await check(plan, { skipRun: true });

    for (const data of [planPhase, skipped]) {
      expect(data.passed).toBe(true);
      expect(data.discriminant).toBeUndefined();
    }
    expect(runs()).toEqual([]);
  });

  /** Each phase needs the glob term. The killing assertion: the old check reads no term, so the plan phase passes and no discriminant exists. */
  it('SpecCoverage_AnUnresolvedGlobTerm_FailsInEachPhaseWithProfileUnresolved', async () => {
    writeFiles({ 'src/a.test.ts': '' });
    const plan = filesList(['src/a.test.ts']);
    const verificationProfile = pinnedUnresolvedGlobProfile(4);

    const planPhase = await check(plan, { coveragePhase: 'plan', verificationProfile });
    const afterImplementation = await check(plan, { coveragePhase: 'post-implementation', verificationProfile });

    expect(planPhase.phase).toBe('plan');
    expect(afterImplementation.phase).toBe('post-implementation');
    for (const data of [planPhase, afterImplementation]) {
      expect(data.passed).toBe(false);
      expect(data.discriminant).toBe('profile-unresolved');
      expect(data.reason).toContain(UNRESOLVED_GLOBS_REASON);
      expect(data.reason).toContain('Capsule v4 pins this term');
    }
    expect(runs()).toEqual([]);
  });
});
