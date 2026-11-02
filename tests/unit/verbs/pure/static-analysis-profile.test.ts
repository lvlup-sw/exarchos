/**
 * Tests for static analysis under the verification profile: the gate runs the checks of the term, in their order, and no other check.
 * A term that does not resolve gives the skip `profile-unresolved`. A segment reads the pinned term, and a direct call resolves the term at its root.
 *
 * The cases of `runStaticAnalysis` inject a stub runner. The cases of the handler replace the process call below `execCommandRunner`.
 * The durable gate producer is a stub that calls only the provider. `ladder-gate-evidence.test.ts` tests the durable evidence.
 *
 * @oracle-sources: ../../../../src/verbs/pure/static-analysis.ts, a recorded `dotnet build` output, and the argv that reaches the runner
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveVerificationProfile } from '../../../../src/config/verification-profile.js';
import { EventStore } from '../../../../src/events/store.js';
import type { ToolResult } from '../../../../src/format.js';
import { handleStaticAnalysis, staticAnalysisCarrier } from '../../../../src/verbs/gates/static-analysis.js';
import { capFailDetail, FAIL_DETAIL_MAX_LINES } from '../../../../src/verbs/pure/fail-detail.js';
import { runStaticAnalysis, type CommandResult, type RunCommandFn } from '../../../../src/verbs/pure/static-analysis.js';
import { isolatedSync } from '../../../../tools/test-helpers/spawn.js';
import { rmrf } from '../../../../tools/test-helpers/temp-dir.js';
import {
  pinnedTestProfile,
  staticAnalysisTerm,
  UNRESOLVED_LINT_REASON,
  unresolvedLintProfile,
} from '../../../helpers/verification-profile.js';

/** The command lines that reach the process call of a handler case, and the lines that exit 1 as npm does for a missing script. */
const spawns = vi.hoisted(() => {
  const ran: string[] = [];
  const failing = new Set<string>();
  return { ran, failing };
});

vi.mock('../../../../src/utils/process.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../src/utils/process.js')>();
  return {
    ...actual,
    runCommandSync: (cmd: string, args: readonly string[]): string => {
      const line = [cmd, ...args].join(' ');
      spawns.ran.push(line);
      if (spawns.failing.has(line)) {
        throw Object.assign(new Error(`${line} failed`), { status: 1, stdout: '', stderr: 'npm error Missing script' });
      }
      return '';
    },
  };
});

vi.mock('../../../../src/verbs/gates/durable-gate-producer.js', () => ({
  runDurableGateProducer: (_scope: unknown, executeProvider: () => Promise<ToolResult>) => executeProvider(),
}));

/** The output of a real `dotnet build` of a project with a package that the SDK prunes. The path is neutral. */
const NU1510_BUILD_OUTPUT = fs.readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), '__fixtures__', 'dotnet-build-nu1510.txt'),
  'utf-8',
);

/** The scripts of a Node fixture. */
const NODE_SCRIPTS = { lint: 'eslint .', typecheck: 'tsc --noEmit' };

/** The reason of a static-analysis term that does not resolve, as a config that does not load gives it. */
const UNRESOLVED_TERM_REASON = 'staticAnalysis: .exarchos.yml does not load, so its keys cannot be read. Fix the file.';

/** One call of the stub runner: the program and its arguments. */
type RunnerCall = readonly [string, readonly string[]];

/** A stub runner and the calls that it got. Each call gives the result of `respond`, and a green run by default. */
function recordingRunner(respond?: (line: string) => CommandResult | undefined): {
  readonly runner: RunCommandFn;
  readonly calls: RunnerCall[];
} {
  const calls: RunnerCall[] = [];
  const runner: RunCommandFn = (cmd, args) => {
    calls.push([cmd, [...args]]);
    return respond?.([cmd, ...args].join(' ')) ?? { exitCode: 0, stdout: '', stderr: '' };
  };
  return { runner, calls };
}

let tmpDir: string;

/** Makes a scratch project with the given files. */
function projectAt(files: Readonly<Record<string, string>>): string {
  const repoRoot = fs.mkdtempSync(path.join(tmpDir, 'project-'));
  for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(repoRoot, name), content, 'utf-8');
  return repoRoot;
}

/** Makes a scratch Node project with the given scripts. */
function nodeProject(scripts: Readonly<Record<string, string>>, files: Readonly<Record<string, string>> = {}): string {
  return projectAt({ 'package.json': JSON.stringify({ name: 'fixture', scripts }), ...files });
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'static-analysis-profile-'));
  spawns.ran.splice(0);
  spawns.failing.clear();
});

afterEach(() => {
  rmrf(tmpDir);
});

describe('runStaticAnalysis — the checks of the profile', () => {
  /** The term replaces each seed of the root. The Node root seeds `npm run lint`, and that command does not run. */
  it('StaticAnalysis_TheProfileChecks_RunInTheirOrderAndNoOtherCheckRuns', () => {
    const repoRoot = nodeProject(NODE_SCRIPTS);
    const { runner, calls } = recordingRunner();
    const checks = staticAnalysisTerm({
      docs: ['vale', 'docs'],
      typecheck: ['tsc', '-p', 'tsconfig.build.json'],
      lint: ['biome', 'check'],
    });

    const result = runStaticAnalysis({ repoRoot, checks, runCommand: runner });

    expect(calls).toEqual([
      ['vale', ['docs']],
      ['tsc', ['-p', 'tsconfig.build.json']],
      ['biome', ['check']],
    ]);
    expect(result.status).toBe('pass');
    expect(result.passCount).toBe(3);
    expect(result.output).toContain('- **PASS**: Docs\n- **PASS**: Typecheck\n- **PASS**: Lint');
  });

  /**
   * The fixture is a recorded build that exits 0 with `warning NU1510` lines. The stub exits 1 for the flags of the old runner,
   * as a real build does on the same restore. The seed runs with no flag, so the strictness of the project decides.
   */
  it('StaticAnalysis_ADotnetBuildWithTheNU1510RestoreWarningOnExitZero_Passes', () => {
    expect(NU1510_BUILD_OUTPUT).toContain('warning NU1510');
    const repoRoot = projectAt({ 'App.sln': '' });
    const { runner, calls } = recordingRunner((line) =>
      line.includes('-warnaserror')
        ? { exitCode: 1, stdout: NU1510_BUILD_OUTPUT.replaceAll('warning NU1510', 'error NU1510'), stderr: '' }
        : { exitCode: 0, stdout: NU1510_BUILD_OUTPUT, stderr: '' },
    );

    const result = runStaticAnalysis({ repoRoot, runCommand: runner });

    expect(calls).toEqual([['dotnet', ['build']]]);
    expect(result.status).toBe('pass');
    expect(result.projectType).toBe('.NET');
    expect(result.output).toContain('- **PASS**: Typecheck');
    expect(result.output).toContain('**Result: PASS** (1/1 checks passed)');
  });

  /**
   * A repository that wants the strict build sets the flags in `typecheck:`. The term comes from the resolver, and the argv runs as written.
   * The old runner runs the same argv and fails on the same output, so the label of the FAIL line kills this case on revert.
   */
  it('StaticAnalysis_ARepositoryWarnAsErrorTypecheck_RunsVerbatimAndFailsOnTheSameOutput', async () => {
    const repoRoot = projectAt({ 'App.sln': '', '.exarchos.yml': 'typecheck: dotnet build --no-restore -warnaserror\n' });
    const { staticAnalysis } = await isolatedSync(() => resolveVerificationProfile(repoRoot));
    const { runner, calls } = recordingRunner((line) =>
      line === 'dotnet build --no-restore -warnaserror' ? { exitCode: 1, stdout: NU1510_BUILD_OUTPUT, stderr: '' } : undefined,
    );

    const result = runStaticAnalysis({ repoRoot, checks: staticAnalysis, runCommand: runner });

    expect(calls).toEqual([['dotnet', ['build', '--no-restore', '-warnaserror']]]);
    expect(result.status).toBe('fail');
    expect(result.output).toContain('- **FAIL**: Typecheck — ');
    expect(result.output).not.toContain('- **FAIL**: Build');
  });

  it('StaticAnalysis_APnpmRepository_RunsPnpmRunLintAndTypecheck', () => {
    const repoRoot = nodeProject(NODE_SCRIPTS, { 'pnpm-lock.yaml': '' });
    const { runner, calls } = recordingRunner();

    const result = runStaticAnalysis({ repoRoot, runCommand: runner });

    expect(calls).toEqual([
      ['pnpm', ['run', 'lint']],
      ['pnpm', ['run', 'typecheck']],
    ]);
    expect(result.status).toBe('pass');
  });

  /** A FAIL names the argv as its rerun, so a pnpm repository gets a rerun that it can run. */
  it('StaticAnalysis_APnpmRepository_NamesThePnpmRerunOfACappedFail', () => {
    const repoRoot = nodeProject(NODE_SCRIPTS, { 'pnpm-lock.yaml': '' });
    const longOutput = Array.from({ length: FAIL_DETAIL_MAX_LINES + 1 }, (_, line) => `problem ${line}`).join('\n');
    const { runner } = recordingRunner((line) =>
      line === 'pnpm run lint' ? { exitCode: 1, stdout: '', stderr: longOutput } : undefined,
    );

    const result = runStaticAnalysis({ repoRoot, runCommand: runner });

    expect(result.output).toContain('Re-run `pnpm run lint` for the full output.');
  });

  it('StaticAnalysis_APythonRepository_RunsRuffCheck', () => {
    const repoRoot = projectAt({ 'pyproject.toml': '[project]\nname = "fixture"\n' });
    const { runner, calls } = recordingRunner();

    const result = runStaticAnalysis({ repoRoot, runCommand: runner });

    expect(calls).toEqual([['ruff', ['check']]]);
    expect(result.status).toBe('pass');
    expect(result.projectType).toBe('Python');
    expect(result.output).toContain('- **PASS**: Lint');
  });

  it('StaticAnalysis_ANodeRepositoryWithAQualityCheckScript_RunsOnlyLintAndTypecheck', () => {
    const repoRoot = nodeProject({ ...NODE_SCRIPTS, 'quality-check': 'echo q' });
    const { runner, calls } = recordingRunner();

    const result = runStaticAnalysis({ repoRoot, runCommand: runner });

    expect(calls).toEqual([
      ['npm', ['run', 'lint']],
      ['npm', ['run', 'typecheck']],
    ]);
    expect(result.passCount).toBe(2);
    expect(result.output).not.toContain('Quality check');
  });

  it('StaticAnalysis_TheRustSeed_RunsCargoCheckThenCargoClippyWithNoFlag', () => {
    const repoRoot = projectAt({ 'Cargo.toml': '[package]\nname = "fixture"\n' });
    const { runner, calls } = recordingRunner();

    const result = runStaticAnalysis({ repoRoot, runCommand: runner });

    expect(calls).toEqual([
      ['cargo', ['check']],
      ['cargo', ['clippy']],
    ]);
    expect(result.status).toBe('pass');
    expect(result.output).toContain('- **PASS**: Typecheck\n- **PASS**: Lint');
  });
});

describe('runStaticAnalysis — a term that does not resolve', () => {
  /** The SKIP line names the keys, and the other check still runs. The carrier is a skip with no `degraded` mark, so it never passes. */
  it('StaticAnalysis_AnUnresolvedCheck_SkipsWithProfileUnresolvedAndNamesItsKeys', () => {
    const repoRoot = nodeProject(NODE_SCRIPTS);
    const { runner, calls } = recordingRunner();

    const result = runStaticAnalysis({ repoRoot, checks: unresolvedLintProfile().staticAnalysis, runCommand: runner });

    expect(calls).toEqual([['npm', ['run', 'typecheck']]]);
    expect(result).toMatchObject({ status: 'skip', skipReason: 'profile-unresolved', passCount: 1, failCount: 0, skipCount: 1 });
    expect(result.unresolvedReason).toBe(UNRESOLVED_LINT_REASON);
    expect(result.output).toContain(`- **SKIP**: Lint — ${UNRESOLVED_LINT_REASON}`);
    expect(result.output).toContain('**Result: SKIP** (1/1 checks passed, 1 skipped — inconclusive, not a pass)');
    const carrier = staticAnalysisCarrier(result).data;
    expect(carrier).toMatchObject({
      passed: false,
      skipped: true,
      verdict: 'indeterminate',
      discriminant: 'profile-unresolved',
      reason: UNRESOLVED_LINT_REASON,
    });
    expect(carrier).not.toHaveProperty('degraded');
  });

  /** The reason starts with the profile path and ends with the route of a remedy, and the report names the path. */
  it('StaticAnalysis_AnUnresolvedCheck_ReasonStartsWithTheProfilePathAndEndsWithTheRoute', () => {
    const repoRoot = nodeProject(NODE_SCRIPTS);

    const result = runStaticAnalysis({
      repoRoot,
      checks: unresolvedLintProfile().staticAnalysis,
      profilePath: 'pinned by capsule v3',
      withRoute: (reason) => `${reason} Prepare again.`,
      runCommand: recordingRunner().runner,
    });

    expect(result.unresolvedReason).toBe(`pinned by capsule v3. ${UNRESOLVED_LINT_REASON} Prepare again.`);
    expect(result.output).toContain('**Profile:** pinned by capsule v3');
  });

  /** A skip flag cannot hide a check that the profile does not resolve, so the skip stays `profile-unresolved` beside a flag. */
  it('StaticAnalysis_ASkipFlagOnAnUnresolvedCheck_StaysProfileUnresolved', () => {
    const repoRoot = nodeProject(NODE_SCRIPTS);
    const { runner, calls } = recordingRunner();

    const result = runStaticAnalysis({
      repoRoot,
      skipLint: true,
      skipTypecheck: true,
      checks: unresolvedLintProfile().staticAnalysis,
      runCommand: runner,
    });

    expect(calls).toEqual([]);
    expect(result).toMatchObject({ status: 'skip', skipReason: 'profile-unresolved', skipCount: 2 });
    expect(result.output).toContain('- **SKIP**: Typecheck — skipped by the skipTypecheck flag');
    expect(result.output).toContain('**Result: SKIP**');
  });

  /** An unresolved term is one SKIP line, and one count. */
  it('StaticAnalysis_AnUnresolvedTerm_IsOneSkipLine', () => {
    const repoRoot = projectAt({ 'README.md': '# fixture\n' });

    const result = runStaticAnalysis({
      repoRoot,
      checks: { state: 'unresolved', reason: UNRESOLVED_TERM_REASON },
      runCommand: recordingRunner().runner,
    });

    expect(result).toMatchObject({ status: 'skip', skipReason: 'profile-unresolved', passCount: 0, skipCount: 1 });
    expect(result.output).toContain(`- **SKIP**: Static analysis — ${UNRESOLVED_TERM_REASON}`);
    expect(result.output).not.toContain('**Project type:**');
  });

  /** An unresolved term stops no advisory leg, so the FAIL of a boundary leg on a config that does not load still gives FAIL. */
  it('StaticAnalysis_AnUnresolvedTermBesideABoundaryFail_GivesFail', () => {
    const repoRoot = projectAt({ '.dependency-cruiser.cjs': 'module.exports = {};\n' });
    const source = path.join(repoRoot, '.exarchos.yml');

    const result = runStaticAnalysis({
      repoRoot,
      checks: { state: 'unresolved', reason: UNRESOLVED_TERM_REASON },
      projectConfigError: { source, message: 'bad indentation' },
      runCommand: recordingRunner().runner,
    });

    expect(result).toMatchObject({ status: 'fail', failCount: 1, skipCount: 1 });
    expect(result.output).toContain(`- **FAIL**: Import boundaries — the project config ${source} does not load`);
    expect(result.output).toContain(`- **SKIP**: Static analysis — ${UNRESOLVED_TERM_REASON}`);
  });
});

describe('handleStaticAnalysis — the profile of a call', () => {
  /**
   * The pin holds `npm run lint`, and the worktree deleted the script. The run does not read the worktree, so the check runs and fails as npm does.
   * The old gate reads the worktree, runs no `lint` and gives the skip `constituent-skipped`.
   */
  it('StaticAnalysis_InASegment_AWorktreeThatDeletesAPinnedScript_FailsThatCheck', async () => {
    const worktree = nodeProject({ typecheck: 'tsc --noEmit' });
    spawns.failing.add('npm run lint');

    const result = await handleStaticAnalysis(
      { featureId: 'feat-segment', repoRoot: worktree, verificationProfile: pinnedTestProfile(4) },
      tmpDir,
      new EventStore(tmpDir),
    );

    expect(spawns.ran).toEqual(['npm run lint', 'npm run typecheck']);
    expect(result.data).toMatchObject({ passed: false, verdict: 'fail', failCount: 1, passCount: 1, skipCount: 0 });
    expect(result.data).toMatchObject({ report: expect.stringContaining('- **FAIL**: Lint — npm error Missing script') });
    expect(result.data).toMatchObject({ report: expect.stringContaining('**Profile:** pinned by capsule v4') });
  });

  /** The term of the pin reaches the gate unchanged. So a check that the worktree holds does not replace an unresolved check of the pin. */
  it('StaticAnalysis_InASegment_AnUnresolvedPinnedCheck_NamesTheCheckoutRoute', async () => {
    const worktree = nodeProject(NODE_SCRIPTS);

    const result = await handleStaticAnalysis(
      {
        featureId: 'feat-segment',
        repoRoot: worktree,
        verificationProfile: { capsuleVersion: 4, profile: unresolvedLintProfile() },
      },
      tmpDir,
      new EventStore(tmpDir),
    );

    expect(spawns.ran).toEqual(['npm run typecheck']);
    expect(result.data).toMatchObject({ passed: false, skipped: true, discriminant: 'profile-unresolved' });
    expect(result.data).toMatchObject({ reason: expect.stringMatching(/^pinned by capsule v4\. staticAnalysis\.lint: /) });
    expect(result.data).toMatchObject({ reason: expect.stringContaining('A rerun under capsule v4 gives the same verdict.') });
  });

  /** A direct call has no pin, so the resolved keys of its root decide. The old gate reads no `lint:` key and runs the script. */
  it('StaticAnalysis_ADirectCall_RunsTheKeysOfItsRootAndNamesTheRoot', async () => {
    const repoRoot = nodeProject(NODE_SCRIPTS, { '.exarchos.yml': 'lint: npm run lint:strict\n' });

    const result = await handleStaticAnalysis({ featureId: 'feat-direct', repoRoot }, tmpDir, new EventStore(tmpDir));

    expect(spawns.ran).toEqual(['npm run lint:strict', 'npm run typecheck']);
    expect(result.data).toMatchObject({ passed: true, verdict: 'pass', passCount: 2 });
    expect(result.data).toMatchObject({ report: expect.stringContaining(`**Profile:** resolved at ${repoRoot}`) });
  });
});

describe('capFailDetail — the file list', () => {
  /** `.rb` and `.java` are outside the list of the old regex, so the file list of the old cap counts neither. A version is not a file. */
  it('CapFailDetail_AFilePathOfAnyExtension_IsCounted', () => {
    const lines = Array.from({ length: FAIL_DETAIL_MAX_LINES }, (_, index) =>
      index % 2 === 0 ? `lib/a.rb:${index}: syntax error` : `src/A.java:${index}: error: cannot find symbol`,
    );

    const detail = capFailDetail([...lines, 'rubocop 1.2.3 stopped'].join('\n'), 'rake lint');

    expect(detail).toContain('Failing files (2):');
    expect(detail).toContain(`lib/a.rb: ${FAIL_DETAIL_MAX_LINES / 2}`);
    expect(detail).toContain(`src/A.java: ${FAIL_DETAIL_MAX_LINES / 2}`);
  });
});
