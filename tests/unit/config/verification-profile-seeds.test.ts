/**
 * The registry seeds of the verification profile: the static-analysis checks of each row, and the probe row of each command.
 * A probe command takes its file form, its red exit codes and its globs from the seed row of its program.
 * The file also covers the test-name rule, the argument form of a probe run and the detection of each matched toolchain.
 */

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  loadExarchosConfigOutcome,
  type ExarchosConfigOutcome,
} from '../../../src/config/load-exarchos-config.js';
import { detectToolchain, detectToolchains, toolchainFromConfig } from '../../../src/config/toolchains.js';
import {
  isTestNameGlob,
  matchesTestName,
  probeArgv,
  resolveVerificationProfile,
  staticAnalysisSeedsAt,
} from '../../../src/config/verification-profile.js';
import type { VerificationProfile } from '../../../src/workflow/verification/profile.js';
import { rmrf } from '../../../tools/test-helpers/temp-dir.js';

/** The co-located test globs that every root takes. */
const CO_LOCATED = ['**/*.test.*', '**/*.spec.*', '**/__tests__/**'];

/** The glob row of the dotnet toolchain. */
const DOTNET_GLOBS = ['**/*Tests/**', '**/*.Tests/**', '**/*Tests.cs', '**/*Test.cs'];

/** The glob row of the python toolchain. */
const PYTHON_GLOBS = ['tests/**', '**/test_*.py', '**/*_test.py', '**/conftest.py'];

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmrf(root);
});

/** Makes a root that holds `files`. A name with a directory makes that directory. */
function rootWith(files: Readonly<Record<string, string>>): string {
  const root = mkdtempSync(join(tmpdir(), 'profile-seeds-'));
  roots.push(root);
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, name)), { recursive: true });
    writeFileSync(join(root, name), text);
  }
  return root;
}

/** The text of an `.exarchos.yml`. YAML reads JSON, so the case writes the config as an object. */
function exarchosYml(config: unknown): string {
  return JSON.stringify(config);
}

/** Reads the config of a root with no git, so the case spawns nothing. */
function readWithNoGit(root: string): ExarchosConfigOutcome {
  return loadExarchosConfigOutcome(root, { findRepoRoot: () => null });
}

function probeAt(root: string): VerificationProfile['tests']['probe'] {
  return resolveVerificationProfile(root, { loadConfig: readWithNoGit }).tests.probe;
}

function checksAt(root: string): VerificationProfile['staticAnalysis'] {
  return resolveVerificationProfile(root, { loadConfig: readWithNoGit }).staticAnalysis;
}

describe('the registry seeds of the verification profile', () => {
  it('TestNameRule_TheShapeOfAGlob_DecidesATestNameGlob', () => {
    for (const glob of ['**/*.test.*', '**/*Tests.cs', '**/test_*.py', '**/*_test.go']) {
      expect(isTestNameGlob(glob), glob).toBe(true);
    }
    for (const glob of ['tests/**', 'spec/**', '**/__tests__/**', '**/conftest.py']) {
      expect(isTestNameGlob(glob), glob).toBe(false);
    }
  });

  /** A `*` at the end of the last segment matches no `.`, so a snapshot and a source map are not tests by name. */
  it('TestNameRule_AFinalStar_MatchesOneExtension', () => {
    expect(matchesTestName('src/a.test.ts', ['**/*.test.*'])).toBe(true);
    expect(matchesTestName('tests/migration/__snapshots__/snapshots.test.ts.snap', ['**/*.test.*'])).toBe(false);
    expect(matchesTestName('src/a.test.ts.map', ['**/*.test.*'])).toBe(false);
    expect(matchesTestName('Tests/FooTests.cs', ['**/*Tests.cs'])).toBe(true);
    expect(matchesTestName('src/__tests__/a.ts', ['**/__tests__/**'])).toBe(false);
  });

  /** The dotnet seed drops `-warnaserror` and `--no-restore`, so the strictness of the project decides. */
  it('ResolveProfile_TheDotnetSeed_IsDotnetBuildWithNoFlag', () => {
    const root = rootWith({ 'App.sln': '' });

    for (const term of [checksAt(root), staticAnalysisSeedsAt(root)]) {
      expect(term).toEqual({
        state: 'resolved',
        checks: [{ name: 'typecheck', command: { state: 'resolved', argv: ['dotnet', 'build'], source: 'detection' } }],
        source: 'detection',
      });
    }
  });

  it('ResolveProfile_TheRustSeed_RunsClippyWithNoDenyWarnings', () => {
    const root = rootWith({ 'Cargo.toml': '[package]\nname = "fixture"\n' });

    for (const term of [checksAt(root), staticAnalysisSeedsAt(root)]) {
      expect(term).toEqual({
        state: 'resolved',
        checks: [
          { name: 'typecheck', command: { state: 'resolved', argv: ['cargo', 'check'], source: 'detection' } },
          { name: 'lint', command: { state: 'resolved', argv: ['cargo', 'clippy'], source: 'detection' } },
        ],
        source: 'detection',
      });
    }
  });

  it('ResolveProfile_ACargoRepository_ProbesWithTheNoneFormAndExitCode101', () => {
    const root = rootWith({ 'Cargo.toml': '[package]\nname = "fixture"\n' });

    expect(probeAt(root)).toEqual({
      command: { state: 'resolved', argv: ['cargo', 'test'], source: 'detection' },
      files: 'none',
      failureExitCodes: { codes: [101], source: 'detection' },
      globs: ['tests/**'],
    });
  });

  it('ResolveProfile_APnpmRepository_SeedsPnpmRun', () => {
    const root = rootWith({
      'package.json': JSON.stringify({
        scripts: { test: 'vitest', 'test:files': 'vitest run', lint: 'eslint .', typecheck: 'tsc --noEmit' },
      }),
      'pnpm-lock.yaml': '',
    });

    const profile = resolveVerificationProfile(root, { loadConfig: readWithNoGit });

    expect(profile.staticAnalysis.state === 'resolved' && profile.staticAnalysis.checks).toEqual([
      { name: 'lint', command: { state: 'resolved', argv: ['pnpm', 'run', 'lint'], source: 'detection' } },
      { name: 'typecheck', command: { state: 'resolved', argv: ['pnpm', 'run', 'typecheck'], source: 'detection' } },
    ]);
    expect(profile.tests.probe.command).toEqual({ state: 'resolved', argv: ['pnpm', 'run', 'test:files'], source: 'detection' });
    expect(profile.tests.probe.files).toBe('after-separator');
  });

  /** A task-runner target takes the globs of the first matched toolchain and the row of its runner. */
  it('ResolveProfile_AMakefileTestTargetInAGoRoot_ProbesWithTheGoGlobsAndTheMakeRow', () => {
    const root = rootWith({ 'go.mod': 'module example.com/fixture\n', Makefile: 'test:\n\tgo test ./...\n' });

    expect(probeAt(root)).toEqual({
      command: { state: 'resolved', argv: ['make', 'test'], source: 'task-runner' },
      files: 'none',
      failureExitCodes: { codes: [2], source: 'task-runner' },
      globs: ['**/*_test.go'],
    });
  });

  it('ResolveProfile_ATestKeyInAPythonRoot_ProbesWithThePythonRow', () => {
    const root = rootWith({ 'pyproject.toml': '', '.exarchos.yml': exarchosYml({ test: 'pytest -q' }) });

    expect(probeAt(root)).toEqual({
      command: { state: 'resolved', argv: ['pytest', '-q'], source: 'config' },
      files: 'after-separator',
      failureExitCodes: { codes: [1, 2], source: 'detection' },
      globs: PYTHON_GLOBS,
    });
  });

  /** The row follows the program, not the layer, so a `test:` key of `cargo test` keeps the form `none`. */
  it('ResolveProfile_ACargoTestKey_ProbesWithTheNoneFormAndExitCode101', () => {
    const root = rootWith({
      'Cargo.toml': '[package]\nname = "fixture"\n',
      '.exarchos.yml': exarchosYml({ test: 'cargo test --workspace' }),
    });

    expect(probeAt(root)).toEqual({
      command: { state: 'resolved', argv: ['cargo', 'test', '--workspace'], source: 'config' },
      files: 'none',
      failureExitCodes: { codes: [101], source: 'detection' },
      globs: ['tests/**'],
    });
  });

  it('ResolveProfile_AConfiguredDotnetProbeWithNoFileForm_TakesTheNoneForm', () => {
    const root = rootWith({
      'App.sln': '',
      '.exarchos.yml': exarchosYml({ verification: { tests: { probe: { command: 'dotnet test App.slnx' } } } }),
    });

    expect(probeAt(root)).toEqual({
      command: { state: 'resolved', argv: ['dotnet', 'test', 'App.slnx'], source: 'config' },
      files: 'none',
      failureExitCodes: { codes: [1, 2], source: 'detection' },
      globs: DOTNET_GLOBS,
    });
  });

  it('ResolveProfile_ATestKeyOfAProgramWithNoSeedRow_ProbesWithAfterSeparatorAndExitCodeOne', () => {
    const root = rootWith({ 'go.mod': 'module example.com/fixture\n', '.exarchos.yml': exarchosYml({ test: './run-tests.sh' }) });

    expect(probeAt(root)).toEqual({
      command: { state: 'resolved', argv: ['./run-tests.sh'], source: 'config' },
      files: 'after-separator',
      failureExitCodes: { codes: [1], source: 'detection' },
      globs: ['**/*_test.go'],
    });
  });

  /** Detection reads the root only. So a nested `ClientApp/package.json` adds no toolchain, and the probe runs the dotnet globs only. */
  it('ResolveProfile_ASolutionRootWithAClientAppPackage_ProbesWithTheDotnetGlobsOnly', () => {
    const root = rootWith({ 'App.sln': '', 'ClientApp/package.json': JSON.stringify({ scripts: { test: 'vitest' } }) });

    const profile = resolveVerificationProfile(root, { loadConfig: readWithNoGit });

    expect(profile.toolchains).toEqual(['dotnet']);
    expect(profile.tests.globs).toEqual({ state: 'resolved', globs: [...CO_LOCATED, ...DOTNET_GLOBS], source: 'detection' });
    expect(profile.tests.probe.command).toEqual({ state: 'resolved', argv: ['dotnet', 'test'], source: 'detection' });
    expect(profile.tests.probe.globs).toEqual(DOTNET_GLOBS);
  });

  /** The seed row of `npm` is the node row, also when node does not match at the root. The node row has no glob row. */
  it('ResolveProfile_AConfiguredNpmProbeInASolutionRoot_TakesTheCoLocatedGlobsOfTheNodeRow', () => {
    const root = rootWith({
      'App.sln': '',
      'ClientApp/package.json': JSON.stringify({ scripts: { 'test:files': 'vitest run' } }),
      '.exarchos.yml': exarchosYml({ verification: { tests: { probe: { command: 'npm --prefix ClientApp run test:files' } } } }),
    });

    const profile = resolveVerificationProfile(root, { loadConfig: readWithNoGit });

    expect(profile.tests.probe).toEqual({
      command: { state: 'resolved', argv: ['npm', '--prefix', 'ClientApp', 'run', 'test:files'], source: 'config' },
      files: 'after-separator',
      failureExitCodes: { codes: [1], source: 'detection' },
      globs: CO_LOCATED,
    });
    expect(profile.tests.globs).toEqual({ state: 'resolved', globs: [...CO_LOCATED, ...DOTNET_GLOBS], source: 'detection' });
  });

  /** rake reads each argument after `--` as a task name, and the resolver does not read the definition of a target. */
  it('ResolveProfile_TheRubySeedAndEachTaskRunnerTarget_ProbeWithTheNoneForm', () => {
    const cases: ReadonlyArray<{ readonly files: Readonly<Record<string, string>>; readonly argv: readonly string[]; readonly codes: readonly number[] }> = [
      { files: { Gemfile: '' }, argv: ['bundle', 'exec', 'rake', 'test'], codes: [1] },
      { files: { 'Taskfile.yml': 'version: "3"\ntasks:\n  test:\n    cmds: [echo]\n' }, argv: ['task', 'test'], codes: [1] },
      { files: { justfile: 'test:\n\techo\n' }, argv: ['just', 'test'], codes: [1] },
      { files: { 'mise.toml': '[tasks.test]\nrun = "echo"\n' }, argv: ['mise', 'run', 'test'], codes: [1] },
      { files: { Makefile: 'test:\n\techo\n' }, argv: ['make', 'test'], codes: [2] },
    ];

    for (const { files, argv, codes } of cases) {
      const probe = probeAt(rootWith(files));
      expect(probe.command.state === 'resolved' && probe.command.argv, argv.join(' ')).toEqual(argv);
      expect(probe.files, argv.join(' ')).toBe('none');
      expect(probe.failureExitCodes.codes, argv.join(' ')).toEqual(codes);
    }
  });

  it('ProbeArgv_EachForm_PlacesTheFilesAsItsNameSays', () => {
    const argv = ['npm', 'run', 'test:files'];
    const files = ['src/a.test.ts', 'src/b.test.ts'];

    expect(probeArgv('after-separator', argv, files)).toEqual([...argv, '--', ...files]);
    expect(probeArgv('as-arguments', argv, files)).toEqual([...argv, ...files]);
    expect(probeArgv('none', argv, files)).toEqual(argv);
  });

  it('DetectToolchains_ARootWithTwoMarkers_GivesBothInPriorityOrder', () => {
    const root = rootWith({ 'go.mod': 'module example.com/fixture\n', 'package.json': '{}' });
    const user = toolchainFromConfig({ id: 'go-workspace', markers: ['go.mod'], commands: { test: 'go test ./... -race' } });

    expect(detectToolchains(root).map((toolchain) => toolchain.id)).toEqual(['node', 'go']);
    expect(detectToolchains(root, [user]).map((toolchain) => toolchain.id)).toEqual(['go-workspace', 'node', 'go']);
    expect(detectToolchain(root)?.id).toBe('node');
    expect(detectToolchains(rootWith({}))).toEqual([]);
  });
});
