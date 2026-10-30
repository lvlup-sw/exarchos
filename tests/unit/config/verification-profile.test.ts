/**
 * The layers of the verification profile: the `verification:` keys, the top-level keys, a user toolchain and the seeds.
 * Each case calls the resolver with a loader that spawns no git, so the case reads only the files of its root.
 */

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  loadExarchosConfigOutcome,
  type ExarchosConfigOutcome,
} from '../../../src/config/load-exarchos-config.js';
import { resolveVerificationProfile } from '../../../src/config/verification-profile.js';
import { FullExarchosConfigSchema } from '../../../src/config/yaml-schema.js';
import { VerificationProfileSchema, type VerificationProfile } from '../../../src/workflow/verification/profile.js';
import { rmrf } from '../../../tools/test-helpers/temp-dir.js';
import { nodeTestProfile } from '../../helpers/verification-profile.js';

const REPO_ROOT = resolve(import.meta.dirname, '../../..');

/** The co-located test globs that every root takes. */
const CO_LOCATED = ['**/*.test.*', '**/*.spec.*', '**/__tests__/**'];

/** The scripts of a Node fixture with a scoped test script, a suite, a linter and a type check. */
const NODE_SCRIPTS = { 'test:files': 'vitest run', 'test:run': 'vitest run', lint: 'eslint .', typecheck: 'tsc --noEmit' };

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmrf(root);
});

/** Makes a root that holds `files`. A name with a directory makes that directory. */
function rootWith(files: Readonly<Record<string, string>>): string {
  const root = mkdtempSync(join(tmpdir(), 'profile-'));
  roots.push(root);
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, name)), { recursive: true });
    writeFileSync(join(root, name), text);
  }
  return root;
}

/** The text of a `package.json` with these scripts. */
function packageJson(scripts: Readonly<Record<string, string>>): string {
  return JSON.stringify({ scripts });
}

/** The text of an `.exarchos.yml`. YAML reads JSON, so the case writes the config as an object. */
function exarchosYml(config: unknown): string {
  return JSON.stringify(config);
}

/** Reads the config of a root with no git, so the case spawns nothing. */
function readWithNoGit(root: string): ExarchosConfigOutcome {
  return loadExarchosConfigOutcome(root, { findRepoRoot: () => null });
}

function profileAt(root: string): VerificationProfile {
  return resolveVerificationProfile(root, { loadConfig: readWithNoGit });
}

/** The argv of a command term, or the reason of an unresolved one. */
function argvOf(term: VerificationProfile['integration']['command']): readonly string[] | string {
  return term.state === 'resolved' ? term.argv : term.reason;
}

describe('the layers of the verification profile', () => {
  /** This repository sets no new key, so its profile repeats the commands of the old gates, less the quality-check leg. */
  it('ResolveProfile_ThisRepository_ReproducesTheCommandsOfTheOldGatesLessQualityCheck', () => {
    const profile = profileAt(REPO_ROOT);

    expect(profile.toolchains).toEqual(['node']);
    expect(profile.tests.globs).toEqual({ state: 'resolved', globs: CO_LOCATED, source: 'detection' });
    expect(profile.tests.probe).toEqual({
      command: { state: 'resolved', argv: ['npm', 'run', 'test:files'], source: 'detection' },
      files: 'after-separator',
      failureExitCodes: { codes: [1], source: 'detection' },
      globs: CO_LOCATED,
    });
    expect(profile.staticAnalysis.state === 'resolved' && profile.staticAnalysis.checks).toEqual([
      { name: 'lint', command: { state: 'resolved', argv: ['npm', 'run', 'lint'], source: 'detection' } },
      { name: 'typecheck', command: { state: 'resolved', argv: ['npm', 'run', 'typecheck'], source: 'detection' } },
    ]);
    expect(profile.integration).toEqual({
      command: { state: 'resolved', argv: ['npm', 'run', 'test:run'], source: 'detection' },
      report: 'exit-code',
      failureExitCodes: { codes: [1], source: 'detection' },
    });
    expect(profile.contract.codegen.state).toBe('unresolved');
    expect(profile.contract.diff.state).toBe('unresolved');
    expect(argvOf(profile.contract.typecheck)).toEqual(['npm', 'run', 'typecheck']);
    expect(profile.firstParty).toEqual({ state: 'resolved', globs: ['src/**', 'servers/*/src/**'], source: 'detection' });
    expect({ ...profile, boundaryChecks: [] }).toEqual(nodeTestProfile());
  });

  /** A second toolchain adds only its test-name globs, so the dotnet directory globs claim no file of a Node root. */
  it('ResolveProfile_ARootPackageJsonBesideASolution_UnionsTheDotnetTestGlobs', () => {
    const root = rootWith({ 'package.json': packageJson(NODE_SCRIPTS), 'App.sln': '' });

    const profile = profileAt(root);

    expect(profile.toolchains).toEqual(['node', 'dotnet']);
    expect(profile.tests.globs).toEqual({
      state: 'resolved',
      globs: [...CO_LOCATED, '**/*Tests.cs', '**/*Test.cs'],
      source: 'detection',
    });
    expect(profile.tests.probe.globs).toEqual(CO_LOCATED);
    expect(profile.tests.globs.state === 'resolved' && profile.tests.globs.globs).not.toContain('**/*Tests/**');
    expect(profile.tests.globs.state === 'resolved' && profile.tests.globs.globs).not.toContain('**/*.Tests/**');
  });

  /**
   * In a root with `package.json` and `requirements.txt`, the Python directory glob and the conftest glob claim no file.
   * A configured co-located glob set keeps only the test-name globs of the seeds as replaced seeds.
   */
  it('ResolveProfile_APackageJsonBesideARequirementsFile_SeedsAndReplacesOnlyThePythonTestNameGlobs', () => {
    const seeded = profileAt(rootWith({ 'package.json': packageJson(NODE_SCRIPTS), 'requirements.txt': '' }));
    const configured = profileAt(
      rootWith({
        'package.json': packageJson(NODE_SCRIPTS),
        'requirements.txt': '',
        '.exarchos.yml': exarchosYml({ verification: { tests: { globs: CO_LOCATED } } }),
      }),
    );

    expect(seeded.tests.globs).toEqual({
      state: 'resolved',
      globs: [...CO_LOCATED, '**/test_*.py', '**/*_test.py'],
      source: 'detection',
    });
    expect(seeded.tests.probe.globs).toEqual(CO_LOCATED);
    expect(configured.tests.globs).toEqual({
      state: 'resolved',
      globs: CO_LOCATED,
      source: 'config',
      replacedSeeds: ['**/*.test.*', '**/*.spec.*', '**/test_*.py', '**/*_test.py'],
    });
    for (const term of [seeded.tests.globs, configured.tests.globs]) {
      const claimed = term.state === 'resolved' ? [...term.globs, ...(term.replacedSeeds ?? [])] : [];
      expect(claimed).not.toContain('tests/**');
      expect(claimed).not.toContain('**/conftest.py');
    }
    expect(configured.tests.globs.state === 'resolved' && configured.tests.globs.replacedSeeds).not.toContain('**/__tests__/**');
  });

  it('ResolveProfile_AConfiguredEmptyGlobSet_IsUnresolved', () => {
    const root = rootWith({
      'package.json': packageJson(NODE_SCRIPTS),
      '.exarchos.yml': exarchosYml({ verification: { tests: { globs: [] } } }),
    });

    const globs = profileAt(root).tests.globs;

    expect(globs.state).toBe('unresolved');
    expect(globs.state === 'unresolved' && globs.reason).toMatch(/^tests\.globs: verification\.tests\.globs is empty/);
  });

  /** On a direct call, a config that does not load leaves each command term and each glob term with the load error. */
  it('ResolveProfile_AConfigThatDoesNotLoad_GivesEveryCommandTermUnresolved', () => {
    const root = rootWith({ 'package.json': packageJson(NODE_SCRIPTS), '.exarchos.yml': 'bogusKey: 1\n' });

    const profile = profileAt(root);
    const terms = [
      profile.tests.globs,
      profile.tests.probe.command,
      profile.staticAnalysis,
      profile.integration.command,
      profile.contract.codegen,
      profile.contract.diff,
      profile.contract.typecheck,
      profile.firstParty,
    ];

    expect(VerificationProfileSchema.safeParse(profile).success).toBe(true);
    for (const term of terms) {
      expect(term.state).toBe('unresolved');
      expect(term.state === 'unresolved' && term.reason).toMatch(/does not load/);
      expect(term.state === 'unresolved' && term.reason).toMatch(/bogusKey/);
    }
  });

  it('ResolveProfile_ARepositoryTypecheckKey_ReplacesTheSeededCheck', () => {
    const root = rootWith({
      'App.sln': '',
      '.exarchos.yml': exarchosYml({ typecheck: 'dotnet build --no-restore -warnaserror' }),
    });

    const term = profileAt(root).staticAnalysis;

    expect(term).toEqual({
      state: 'resolved',
      checks: [
        {
          name: 'typecheck',
          command: { state: 'resolved', argv: ['dotnet', 'build', '--no-restore', '-warnaserror'], source: 'config' },
        },
      ],
      source: 'config',
    });
  });

  /** The block names its checks. A check that the block does not name does not run, also when a seed sets it. */
  it('ResolveProfile_AStaticAnalysisBlock_ReplacesEverySeededCheckInKeyOrder', () => {
    const root = rootWith({
      'package.json': packageJson({ ...NODE_SCRIPTS, 'quality-check': 'npm run lint:invariants' }),
      '.exarchos.yml': exarchosYml({
        verification: { staticAnalysis: { 'quality-check': 'npm run quality-check', lint: 'npm run lint' } },
      }),
    });

    const term = profileAt(root).staticAnalysis;

    expect(term).toEqual({
      state: 'resolved',
      checks: [
        { name: 'quality-check', command: { state: 'resolved', argv: ['npm', 'run', 'quality-check'], source: 'config' } },
        { name: 'lint', command: { state: 'resolved', argv: ['npm', 'run', 'lint'], source: 'config' } },
      ],
      source: 'config',
    });
  });

  it('ResolveProfile_ANodeRepositoryWithNoLintScript_GivesAnUnresolvedCheckThatNamesBothKeys', () => {
    const root = rootWith({ 'package.json': packageJson({ 'test:run': 'vitest run', typecheck: 'tsc --noEmit' }) });

    const term = profileAt(root).staticAnalysis;
    const checks = term.state === 'resolved' ? term.checks : [];
    const lint = checks.find((check) => check.name === 'lint')?.command;

    expect(checks.map((check) => check.name)).toEqual(['lint', 'typecheck']);
    expect(lint?.state).toBe('unresolved');
    expect(lint?.state === 'unresolved' && lint.reason).toMatch(/^staticAnalysis\.lint: no 'lint' script in package\.json/);
    expect(lint?.state === 'unresolved' && lint.reason).toContain('verification.staticAnalysis.lint');
    expect(lint?.state === 'unresolved' && lint.reason).toContain('lint: key');
    expect(checks[1]?.command).toEqual({ state: 'resolved', argv: ['npm', 'run', 'typecheck'], source: 'detection' });
  });

  /** A user toolchain with no built-in marker gives its own checks, in the default order. */
  it('ResolveProfile_AUserToolchain_GivesItsLintAndTypecheckChecks', () => {
    const root = rootWith({
      'build.zig': '',
      '.exarchos.yml': exarchosYml({
        toolchains: [
          {
            id: 'zig',
            markers: ['build.zig'],
            commands: { test: 'zig build test', lint: 'zig fmt --check .', typecheck: 'zig build check' },
          },
        ],
      }),
    });

    const profile = profileAt(root);

    expect(profile.toolchains).toEqual(['zig']);
    expect(profile.staticAnalysis).toEqual({
      state: 'resolved',
      checks: [
        { name: 'lint', command: { state: 'resolved', argv: ['zig', 'fmt', '--check', '.'], source: 'toolchain-config' } },
        { name: 'typecheck', command: { state: 'resolved', argv: ['zig', 'build', 'check'], source: 'toolchain-config' } },
      ],
      source: 'toolchain-config',
    });
  });

  it('ResolveProfile_ALintKeyInADotnetRepository_AddsALintCheckAfterTheTypecheckSeed', () => {
    const root = rootWith({ 'App.sln': '', '.exarchos.yml': exarchosYml({ lint: 'dotnet format --verify-no-changes' }) });

    const term = profileAt(root).staticAnalysis;

    expect(term).toEqual({
      state: 'resolved',
      checks: [
        { name: 'typecheck', command: { state: 'resolved', argv: ['dotnet', 'build'], source: 'detection' } },
        { name: 'lint', command: { state: 'resolved', argv: ['dotnet', 'format', '--verify-no-changes'], source: 'config' } },
      ],
      source: 'config',
    });
  });

  /** A repository where no layer sets a check fails closed, and the reason names each key that sets one. */
  it('ResolveProfile_AJavaRepositoryWithNoKey_GivesAnUnresolvedStaticAnalysisTerm', () => {
    const root = rootWith({ 'pom.xml': '<project/>' });

    const term = profileAt(root).staticAnalysis;

    expect(term.state).toBe('unresolved');
    expect(term.state === 'unresolved' && term.reason).toMatch(/^staticAnalysis: /);
    expect(term.state === 'unresolved' && term.reason).toContain('verification.staticAnalysis');
    expect(term.state === 'unresolved' && term.reason).toContain('lint:');
    expect(term.state === 'unresolved' && term.reason).toContain('typecheck:');
  });

  it('ResolveProfile_AConfiguredGlobSet_GivesAProbeWithNoGlobs', () => {
    const root = rootWith({
      'package.json': packageJson(NODE_SCRIPTS),
      '.exarchos.yml': exarchosYml({ verification: { tests: { globs: ['checks/**/*.check.mjs'] } } }),
    });

    const profile = profileAt(root);

    expect(profile.tests.globs).toEqual({ state: 'resolved', globs: ['checks/**/*.check.mjs'], source: 'config' });
    expect('globs' in profile.tests.probe).toBe(false);
    expect(argvOf(profile.tests.probe.command)).toEqual(['npm', 'run', 'test:files']);
  });

  /** A program with no seed row takes the globs of the first matched toolchain. A Node root has no glob row, so the probe takes the co-located globs. */
  it('ResolveProfile_AConfiguredProbe_KeepsItsFileFormAndItsExitCodesAndTakesTheGlobsOfItsRow', () => {
    const root = rootWith({
      'package.json': packageJson(NODE_SCRIPTS),
      '.exarchos.yml': exarchosYml({
        verification: { tests: { probe: { command: 'npx vitest run', files: 'as-arguments', failureExitCodes: [1] } } },
      }),
    });

    expect(profileAt(root).tests.probe).toEqual({
      command: { state: 'resolved', argv: ['npx', 'vitest', 'run'], source: 'config' },
      files: 'as-arguments',
      failureExitCodes: { codes: [1], source: 'config' },
      globs: CO_LOCATED,
    });
  });

  it('ResolveProfile_AConfiguredProbeInAPolyglotRootWithNoGlobs_IsUnresolvedAndNamesBothKeys', () => {
    const root = rootWith({
      'package.json': packageJson(NODE_SCRIPTS),
      'App.sln': '',
      '.exarchos.yml': exarchosYml({ verification: { tests: { probe: { command: 'dotnet test App.slnx' } } } }),
    });

    const command = profileAt(root).tests.probe.command;

    expect(command.state).toBe('unresolved');
    expect(command.state === 'unresolved' && command.reason).toMatch(/^tests\.probe\.command: /);
    expect(command.state === 'unresolved' && command.reason).toContain('verification.tests.globs');
    expect(command.state === 'unresolved' && command.reason).toContain('verification.tests.probe');
    expect(command.state === 'unresolved' && command.reason).toContain('#1629');
  });

  /** The configured globs name the C# tests that the probe runs. The test-name globs of the seeds stay as replaced seeds. */
  it('ResolveProfile_AConfiguredProbeInAPolyglotRootWithConfiguredGlobs_IsResolved', () => {
    const root = rootWith({
      'package.json': packageJson(NODE_SCRIPTS),
      'App.sln': '',
      '.exarchos.yml': exarchosYml({
        verification: { tests: { globs: ['**/*Tests.cs'], probe: { command: 'dotnet test App.slnx' } } },
      }),
    });

    const profile = profileAt(root);

    expect(profile.tests.probe).toEqual({
      command: { state: 'resolved', argv: ['dotnet', 'test', 'App.slnx'], source: 'config' },
      files: 'none',
      failureExitCodes: { codes: [1, 2], source: 'detection' },
    });
    expect(profile.tests.globs).toEqual({
      state: 'resolved',
      globs: ['**/*Tests.cs'],
      source: 'config',
      replacedSeeds: ['**/*.test.*', '**/*.spec.*', '**/*Tests.cs', '**/*Test.cs'],
    });
  });

  /**
   * A user toolchain beside a built-in toolchain gives two matched toolchains, so the rules of a polyglot root hold.
   * The configured probe needs configured globs, and the configured globs keep the test-name globs of the seeds.
   */
  it('ResolveProfile_AUserToolchainBesideABuiltInToolchain_HoldsTheRulesOfAPolyglotRoot', () => {
    const toolchains = [{ id: 'zig', markers: ['build.zig'], commands: { test: 'zig build test' } }];
    const probe = { command: 'zig build test' };
    const files = { 'package.json': packageJson(NODE_SCRIPTS), 'build.zig': '' };

    const noGlobs = profileAt(rootWith({ ...files, '.exarchos.yml': exarchosYml({ toolchains, verification: { tests: { probe } } }) }));
    const configured = profileAt(
      rootWith({ ...files, '.exarchos.yml': exarchosYml({ toolchains, verification: { tests: { globs: ['**/*_test.zig'], probe } } }) }),
    );

    expect(noGlobs.toolchains).toEqual(['zig', 'node']);
    expect(noGlobs.tests.probe.command.state).toBe('unresolved');
    expect(noGlobs.tests.probe.command.state === 'unresolved' && noGlobs.tests.probe.command.reason).toContain('#1629');
    expect(configured.tests.probe.command).toEqual({ state: 'resolved', argv: ['zig', 'build', 'test'], source: 'config' });
    expect(configured.tests.globs).toEqual({
      state: 'resolved',
      globs: ['**/*_test.zig'],
      source: 'config',
      replacedSeeds: ['**/*.test.*', '**/*.spec.*'],
    });
  });

  /** The loader runs once, and its config reaches each resolver below the profile resolver. The root holds no config file. */
  it('ResolveProfile_ACallThatPassesALoader_ReadsTheConfigOnce', () => {
    const root = rootWith({ 'pyproject.toml': '' });
    const config = FullExarchosConfigSchema.parse({ test: 'pytest -q', typecheck: 'pyright' });
    let calls = 0;
    const loadConfig = (): ExarchosConfigOutcome => {
      calls += 1;
      return { kind: 'loaded', result: { config, source: join(root, '.exarchos.yml'), deprecations: [] } };
    };

    const profile = resolveVerificationProfile(root, { loadConfig });

    expect(calls).toBe(1);
    expect(profile.tests.probe.command).toEqual({ state: 'resolved', argv: ['pytest', '-q'], source: 'config' });
    expect(profile.integration.command).toEqual({ state: 'resolved', argv: ['pytest', '-q'], source: 'config' });
    expect(profile.contract.typecheck).toEqual({ state: 'resolved', argv: ['pyright'], source: 'config' });
  });

  it('ResolveProfile_AnEmptyFirstPartyList_ResolvesToNoGlob', () => {
    const root = rootWith({ '.exarchos.yml': exarchosYml({ ownership: { firstParty: [] } }) });

    expect(profileAt(root).firstParty).toEqual({ state: 'resolved', globs: [], source: 'config' });
  });

  it('ResolveProfile_AFirstPartyGlobThatLeavesTheRoot_GivesAnUnresolvedFirstPartyTerm', () => {
    const root = rootWith({ '.exarchos.yml': exarchosYml({ ownership: { firstParty: ['src/**', '../shared/src/**'] } }) });

    const term = profileAt(root).firstParty;

    expect(term.state).toBe('unresolved');
    expect(term.state === 'unresolved' && term.reason).toMatch(/^firstParty: ownership\.firstParty/);
    expect(term.state === 'unresolved' && term.reason).toContain("'../shared/src/**'");
    expect(term.state === 'unresolved' && term.reason).toContain("no '..' segment");
  });

  /** A key that loads today keeps its schema. A value past the bound of its term gives an unresolved term, so the profile still parses. */
  it('ResolveProfile_AValueOfAnOlderKeyPastItsBound_GivesAProfileThatParses', () => {
    const longLint = profileAt(rootWith({ '.exarchos.yml': exarchosYml({ lint: Array.from({ length: 65 }, () => 'x').join(' ') }) }));
    const userToolchains = Array.from({ length: 17 }, (_, i) => ({ id: `tc${i}`, markers: ['marker.txt'], commands: { test: 'run-tests' } }));
    const manyToolchains = profileAt(rootWith({ 'marker.txt': '', '.exarchos.yml': exarchosYml({ toolchains: userToolchains }) }));
    const manyGlobs = profileAt(
      rootWith({ '.exarchos.yml': exarchosYml({ ownership: { firstParty: Array.from({ length: 65 }, (_, i) => `src${i}/**`) } }) }),
    );
    const longError = resolveVerificationProfile(rootWith({}), {
      loadConfig: () => ({ kind: 'invalid', source: '/r/.exarchos.yml', message: 'e'.repeat(2000) }),
    });

    for (const profile of [longLint, manyToolchains, manyGlobs, longError]) {
      expect(VerificationProfileSchema.safeParse(profile).success).toBe(true);
    }
    const lint = longLint.staticAnalysis.state === 'resolved' ? longLint.staticAnalysis.checks[0] : undefined;
    expect(lint?.name).toBe('lint');
    expect(lint?.command.state === 'unresolved' && lint.command.reason).toMatch(/lint: has 65 tokens, more than the bound of 64/);
    expect(manyToolchains.toolchains).toEqual(userToolchains.slice(0, 16).map((toolchain) => toolchain.id));
    expect(manyGlobs.firstParty.state === 'unresolved' && manyGlobs.firstParty.reason).toMatch(
      /ownership\.firstParty holds 65 globs, more than the bound of 64/,
    );
    const head = 'integration.command: .exarchos.yml does not load, so its keys cannot be read. Fix the file. ';
    expect(longError.integration.command).toEqual({
      state: 'unresolved',
      reason: `${head}${'e'.repeat(317 - head.length)}...`,
    });
  });
});
