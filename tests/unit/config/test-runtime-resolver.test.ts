import { describe, it, expect, afterEach, vi } from 'vitest';
import fc from 'fast-check';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  resolveRunnableCommand,
  resolveTestRuntime,
  resolveVerificationRuntime,
} from '../../../src/config/test-runtime-resolver.js';
import { loadExarchosConfig } from '../../../src/config/load-exarchos-config.js';
import { ExarchosConfigSchema } from '../../../src/config/exarchos-config-schema.js';
import { FullExarchosConfigSchema } from '../../../src/config/yaml-schema.js';
import { rmrf } from '../../../tools/test-helpers/temp-dir.js';

describe('resolveTestRuntime', () => {
  const tmpDirs: string[] = [];

  function makeTmpDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'resolver-'));
    tmpDirs.push(dir);
    return dir;
  }

  afterEach(() => {
    for (const dir of tmpDirs) {
      rmrf(dir);
    }
    tmpDirs.length = 0;
  });

  it('resolveTestRuntime_NodeProject_ReturnsNpmCommands', () => {
    const dir = makeTmpDir();
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({ scripts: { 'test:run': 'vitest run', typecheck: 'tsc --noEmit' } }),
    );

    const result = resolveTestRuntime(dir);

    expect(result).toEqual({
      test: 'npm run test:run',
      typecheck: 'npm run typecheck',
      install: 'npm install',
      source: 'detection',
    });
  });

  it('resolveTestRuntime_PythonProject_ReturnsPytestCommand', () => {
    const dir = makeTmpDir();
    writeFileSync(join(dir, 'pyproject.toml'), '[project]');

    const result = resolveTestRuntime(dir);

    expect(result).toEqual({
      test: 'pytest',
      typecheck: null,
      install: null,
      source: 'detection',
    });
  });

  it('resolveTestRuntime_RustProject_ReturnsCargoCommand', () => {
    const dir = makeTmpDir();
    writeFileSync(join(dir, 'Cargo.toml'), '[package]');

    const result = resolveTestRuntime(dir);

    expect(result).toEqual({
      test: 'cargo test',
      typecheck: null,
      install: null,
      source: 'detection',
    });
  });

  it('resolveTestRuntime_DotNetProject_ReturnsDotnetCommand', () => {
    const dir = makeTmpDir();
    writeFileSync(join(dir, 'Foo.csproj'), '<Project/>');

    const result = resolveTestRuntime(dir);

    expect(result).toEqual({
      test: 'dotnet test',
      typecheck: null,
      install: null,
      source: 'detection',
    });
  });

  it.each(['App.sln', 'App.slnx'])(
    'resolveTestRuntime_DotNetSolution_%s_ReturnsDotnetCommand (#1507)',
    (solutionFile) => {
      const dir = makeTmpDir();
      writeFileSync(join(dir, solutionFile), '');

      const result = resolveTestRuntime(dir);

      expect(result).toEqual({
        test: 'dotnet test',
        typecheck: null,
        install: null,
        source: 'detection',
      });
    },
  );

  it('resolveTestRuntime_GoProject_ReturnsGoCommand', () => {
    const dir = makeTmpDir();
    writeFileSync(join(dir, 'go.mod'), 'module example.com/x\n');

    const result = resolveTestRuntime(dir);

    expect(result).toEqual({
      test: 'go test ./...',
      typecheck: null,
      install: null,
      source: 'detection',
    });
  });

  it('resolveTestRuntime_NoMarkers_ReturnsUnresolved', () => {
    const dir = makeTmpDir();

    const result = resolveTestRuntime(dir);

    expect(result.test).toBeNull();
    expect(result.typecheck).toBeNull();
    expect(result.install).toBeNull();
    expect(result.source).toBe('unresolved');
    expect(result.remediation).toBeDefined();
    expect(result.remediation!.length).toBeGreaterThan(0);
  });

  it('resolveTestRuntime_OverrideTestProvided_ReturnsOverride', () => {
    const dir = makeTmpDir();

    const result = resolveTestRuntime(dir, { override: { test: 'bun test' } });

    expect(result.test).toBe('bun test');
    expect(result.source).toBe('override');
  });

  it('resolveTestRuntime_OverrideAllFieldsProvided_ReturnsOverrideForAll', () => {
    const dir = makeTmpDir();

    const result = resolveTestRuntime(dir, {
      override: {
        test: 'bun test',
        typecheck: 'bunx tsc --noEmit',
        install: 'bun install',
      },
    });

    expect(result).toEqual({
      test: 'bun test',
      typecheck: 'bunx tsc --noEmit',
      install: 'bun install',
      source: 'override',
    });
  });

  it('resolveTestRuntime_OverridePartial_MergesWithDetection', () => {
    const dir = makeTmpDir();
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({ scripts: { 'test:run': 'vitest run', typecheck: 'tsc --noEmit' } }),
    );

    const result = resolveTestRuntime(dir, { override: { test: 'bun test' } });

    expect(result).toEqual({
      test: 'bun test',
      typecheck: 'npm run typecheck',
      install: 'npm install',
      source: 'override',
    });
  });

  it('resolveTestRuntime_OverrideUnsafeChars_Throws', () => {
    const dir = makeTmpDir();

    expect(() => resolveTestRuntime(dir, { override: { test: 'npm test; rm -rf /' } })).toThrow();
    expect(() => resolveTestRuntime(dir, { override: { test: 'echo `whoami`' } })).toThrow();
    expect(() => resolveTestRuntime(dir, { override: { test: 'echo $HOME' } })).toThrow();
    expect(() => resolveTestRuntime(dir, { override: { typecheck: 'tsc && evil' } })).toThrow();
    expect(() => resolveTestRuntime(dir, { override: { install: 'npm i | bad' } })).toThrow();
  });

  it('resolveTestRuntime_PriorityPackageJsonWinsOverPyproject', () => {
    const dir = makeTmpDir();
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({ scripts: { 'test:run': 'vitest run', typecheck: 'tsc --noEmit' } }),
    );
    writeFileSync(join(dir, 'pyproject.toml'), '[project]');

    const result = resolveTestRuntime(dir);

    expect(result.test).toBe('npm run test:run');
    expect(result.typecheck).toBe('npm run typecheck');
    expect(result.install).toBe('npm install');
    expect(result.source).toBe('detection');
  });

  it('resolveTestRuntime_BunProject_DetectsBunLockfile', () => {
    const dir = makeTmpDir();
    writeFileSync(join(dir, 'package.json'), '{}');
    writeFileSync(join(dir, 'bun.lockb'), '');

    const result = resolveTestRuntime(dir);

    expect(result).toEqual({
      test: 'bun test',
      typecheck: 'tsc --noEmit',
      install: 'bun install',
      source: 'detection',
    });
  });

  /**
   * A project with a bun lockfile and a `test:run` script runs vitest on bun. The resolver must run
   * the script through `bun run test:run`, not through the native bun test runner.
   * `typecheck` uses its script in the same way.
   */
  it('resolveTestRuntime_BunProjectWithTestRunScript_HonorsTestRunViaBunRun', () => {
    const dir = makeTmpDir();
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({ scripts: { 'test:run': 'vitest run', typecheck: 'tsc --noEmit' } }),
    );
    writeFileSync(join(dir, 'bun.lock'), '');

    const result = resolveTestRuntime(dir);

    expect(result).toEqual({
      test: 'bun run test:run',
      typecheck: 'bun run typecheck',
      install: 'bun install',
      source: 'detection',
    });
  });

  /** A `test:run` script does not imply a `typecheck` script. Without one, typecheck falls back to `tsc --noEmit`. */
  it('resolveTestRuntime_BunProjectWithTestRunButNoTypecheck_FallsBackToTsc', () => {
    const dir = makeTmpDir();
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({ scripts: { 'test:run': 'vitest run' } }),
    );
    writeFileSync(join(dir, 'bun.lock'), '');

    const result = resolveTestRuntime(dir);

    expect(result).toEqual({
      test: 'bun run test:run',
      typecheck: 'tsc --noEmit',
      install: 'bun install',
      source: 'detection',
    });
  });

  it('resolveTestRuntime_PnpmProject_DetectsPnpmLockfile', () => {
    const dir = makeTmpDir();
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts: { test: 'vitest run' } }));
    writeFileSync(join(dir, 'pnpm-lock.yaml'), '');

    const result = resolveTestRuntime(dir);

    expect(result).toEqual({
      test: 'pnpm test',
      typecheck: 'tsc --noEmit',
      install: 'pnpm install --frozen-lockfile',
      source: 'detection',
    });
  });

  /**
   * With no Berry signal (`.yarnrc.yml`, `.yarn/releases/`, `packageManager`), the project is Yarn
   * Classic. `--immutable` is Berry-only, so Classic gets `--frozen-lockfile`.
   */
  it('resolveTestRuntime_YarnClassicProject_UsesFrozenLockfile', () => {
    const dir = makeTmpDir();
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts: { test: 'vitest run' } }));
    writeFileSync(join(dir, 'yarn.lock'), '');

    const result = resolveTestRuntime(dir);

    expect(result).toEqual({
      test: 'yarn test',
      typecheck: 'tsc --noEmit',
      install: 'yarn install --frozen-lockfile',
      source: 'detection',
    });
  });

  it('resolveTestRuntime_YarnBerryProject_UsesImmutable_ViaYarnrcYml', () => {
    const dir = makeTmpDir();
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts: { test: 'vitest run' } }));
    writeFileSync(join(dir, 'yarn.lock'), '');
    writeFileSync(join(dir, '.yarnrc.yml'), 'nodeLinker: node-modules\n');

    const result = resolveTestRuntime(dir);

    expect(result.install).toBe('yarn install --immutable');
    expect(result.source).toBe('detection');
  });

  it('resolveTestRuntime_YarnBerryProject_UsesImmutable_ViaPackageManagerField', () => {
    const dir = makeTmpDir();
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({
        scripts: { test: 'vitest run' },
        packageManager: 'yarn@3.6.0',
      }),
    );
    writeFileSync(join(dir, 'yarn.lock'), '');

    const result = resolveTestRuntime(dir);

    expect(result.install).toBe('yarn install --immutable');
  });

  it('resolveTestRuntime_NpmProject_NoAltLockfile_ReturnsNpmCommands', () => {
    const dir = makeTmpDir();
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({ scripts: { 'test:run': 'vitest run', typecheck: 'tsc --noEmit' } }),
    );
    writeFileSync(join(dir, 'package-lock.json'), '{}');

    const result = resolveTestRuntime(dir);

    expect(result).toEqual({
      test: 'npm run test:run',
      typecheck: 'npm run typecheck',
      install: 'npm install',
      source: 'detection',
    });
  });

  it('resolveTestRuntime_BunAndPnpmLockfiles_BunWins', () => {
    const dir = makeTmpDir();
    writeFileSync(join(dir, 'package.json'), '{}');
    writeFileSync(join(dir, 'bun.lockb'), '');
    writeFileSync(join(dir, 'pnpm-lock.yaml'), '');

    const result = resolveTestRuntime(dir);

    expect(result).toEqual({
      test: 'bun test',
      typecheck: 'tsc --noEmit',
      install: 'bun install',
      source: 'detection',
    });
  });

  it('resolveTestRuntime_PnpmAndYarnLockfiles_PnpmWins', () => {
    const dir = makeTmpDir();
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts: { test: 'vitest run' } }));
    writeFileSync(join(dir, 'pnpm-lock.yaml'), '');
    writeFileSync(join(dir, 'yarn.lock'), '');

    const result = resolveTestRuntime(dir);

    expect(result).toEqual({
      test: 'pnpm test',
      typecheck: 'tsc --noEmit',
      install: 'pnpm install --frozen-lockfile',
      source: 'detection',
    });
  });

  it('resolveTestRuntime_BunLockfileWithoutPackageJson_FallsThroughToUnresolved', () => {
    const dir = makeTmpDir();
    writeFileSync(join(dir, 'bun.lockb'), '');

    const result = resolveTestRuntime(dir);

    expect(result.source).toBe('unresolved');
    expect(result.test).toBeNull();
    expect(result.typecheck).toBeNull();
    expect(result.install).toBeNull();
  });

  /**
   * The remediation must name `.exarchos.yml` or the missing script. The install command stays set,
   * so a caller can still install the dependencies.
   */
  it('resolveTestRuntime_NpmProjectMissingTestRunScript_ReturnsUnresolvedTestWithRemediation', () => {
    const dir = makeTmpDir();
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({ scripts: { build: 'tsc' } }),
    );

    const result = resolveTestRuntime(dir);

    expect(result.test).toBeNull();
    expect(result.source).toBe('unresolved');
    expect(result.remediation).toBeDefined();
    expect(result.remediation!.length).toBeGreaterThan(0);
    expect(
      result.remediation!.includes('.exarchos.yml') || result.remediation!.includes('test:run'),
    ).toBe(true);
    expect(result.install).toBe('npm install');
  });

  it('resolveTestRuntime_NpmProjectWithTestRunScript_ReturnsNpmRunTestRun', () => {
    const dir = makeTmpDir();
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({ scripts: { 'test:run': 'vitest run', typecheck: 'tsc --noEmit' } }),
    );

    const result = resolveTestRuntime(dir);

    expect(result).toEqual({
      test: 'npm run test:run',
      typecheck: 'npm run typecheck',
      install: 'npm install',
      source: 'detection',
    });
  });

  it('resolveTestRuntime_NpmProjectMissingTypecheckScript_FallsBackToTscNoEmit', () => {
    const dir = makeTmpDir();
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({ scripts: { 'test:run': 'vitest run' } }),
    );

    const result = resolveTestRuntime(dir);

    expect(result).toEqual({
      test: 'npm run test:run',
      typecheck: 'tsc --noEmit',
      install: 'npm install',
      source: 'detection',
    });
  });

  it('resolveTestRuntime_PnpmProjectMissingTestScript_ReturnsUnresolvedWithRemediation', () => {
    const dir = makeTmpDir();
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts: { build: 'tsc' } }));
    writeFileSync(join(dir, 'pnpm-lock.yaml'), '');

    const result = resolveTestRuntime(dir);

    expect(result.test).toBeNull();
    expect(result.source).toBe('unresolved');
    expect(result.remediation).toBeDefined();
    expect(
      result.remediation!.includes('.exarchos.yml') || result.remediation!.includes('test'),
    ).toBe(true);
  });

  it('resolveTestRuntime_YarnProjectMissingTestScript_ReturnsUnresolvedWithRemediation', () => {
    const dir = makeTmpDir();
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts: { build: 'tsc' } }));
    writeFileSync(join(dir, 'yarn.lock'), '');

    const result = resolveTestRuntime(dir);

    expect(result.test).toBeNull();
    expect(result.source).toBe('unresolved');
    expect(result.remediation).toBeDefined();
    expect(
      result.remediation!.includes('.exarchos.yml') || result.remediation!.includes('test'),
    ).toBe(true);
  });

  it('resolveTestRuntime_BunProjectMissingTestScript_StillReturnsBunTest', () => {
    const dir = makeTmpDir();
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts: { build: 'tsc' } }));
    writeFileSync(join(dir, 'bun.lockb'), '');

    const result = resolveTestRuntime(dir);

    expect(result).toEqual({
      test: 'bun test',
      typecheck: 'tsc --noEmit',
      install: 'bun install',
      source: 'detection',
    });
  });

  it('resolveTestRuntime_NpmProjectScriptsFieldAbsent_ReturnsUnresolved', () => {
    const dir = makeTmpDir();
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'no-scripts-here' }));

    const result = resolveTestRuntime(dir);

    expect(result.test).toBeNull();
    expect(result.source).toBe('unresolved');
    expect(result.remediation).toBeDefined();
    expect(
      result.remediation!.includes('.exarchos.yml') || result.remediation!.includes('test:run'),
    ).toBe(true);
  });

  it('resolveTestRuntime_NpmProjectMalformedPackageJson_HandlesGracefully', () => {
    const dir = makeTmpDir();
    writeFileSync(join(dir, 'package.json'), '{ "name": "broken", "scripts": {');

    const result = resolveTestRuntime(dir);

    expect(result.test).toBeNull();
    expect(result.typecheck).toBeNull();
    expect(result.source).toBe('unresolved');
    expect(result.remediation).toBeDefined();
    expect(result.remediation!.toLowerCase()).toContain('package.json');
  });

  /** The config sets only `test`. `typecheck` and `install` come from detection. */
  it('resolveTestRuntime_ConfigPresentWithTest_OverridesDetection', () => {
    const dir = makeTmpDir();
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({ scripts: { 'test:run': 'vitest run', typecheck: 'tsc --noEmit' } }),
    );

    const result = resolveTestRuntime(dir, {
      loadConfig: () => ({ config: { test: 'jest' }, source: '/x/.exarchos.yml' }),
    });

    expect(result.test).toBe('jest');
    expect(result.source).toBe('config');
    expect(result.typecheck).toBe('npm run typecheck');
    expect(result.install).toBe('npm install');
  });

  it('resolveTestRuntime_ConfigPartial_FallsBackToDetectionForMissingFields', () => {
    const dir = makeTmpDir();
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({ scripts: { 'test:run': 'vitest run', typecheck: 'tsc --noEmit' } }),
    );

    const result = resolveTestRuntime(dir, {
      loadConfig: () => ({ config: { test: 'jest' }, source: '/x/.exarchos.yml' }),
    });

    expect(result.test).toBe('jest');
    expect(result.typecheck).toBe('npm run typecheck');
    expect(result.install).toBe('npm install');
    expect(result.source).toBe('config');
  });

  it('resolveTestRuntime_ConfigAbsent_FallsBackToDetection', () => {
    const dir = makeTmpDir();
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({ scripts: { 'test:run': 'vitest run', typecheck: 'tsc --noEmit' } }),
    );

    const result = resolveTestRuntime(dir, { loadConfig: () => null });

    expect(result).toEqual({
      test: 'npm run test:run',
      typecheck: 'npm run typecheck',
      install: 'npm install',
      source: 'detection',
    });
  });

  it('resolveTestRuntime_OverrideAndConfig_OverrideWins', () => {
    const dir = makeTmpDir();
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({ scripts: { 'test:run': 'vitest run', typecheck: 'tsc --noEmit' } }),
    );

    const result = resolveTestRuntime(dir, {
      override: { test: 'bun test' },
      loadConfig: () => ({ config: { test: 'jest' }, source: '/x/.exarchos.yml' }),
    });

    expect(result.test).toBe('bun test');
    expect(result.source).toBe('override');
  });

  it('resolveTestRuntime_OverrideAndConfig_PerField', () => {
    const dir = makeTmpDir();
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({ scripts: { 'test:run': 'vitest run', typecheck: 'tsc --noEmit' } }),
    );

    const result = resolveTestRuntime(dir, {
      override: { test: 'bun test' },
      loadConfig: () => ({ config: { typecheck: 'tsc --strict' }, source: '/x/.exarchos.yml' }),
    });

    expect(result.test).toBe('bun test');
    expect(result.typecheck).toBe('tsc --strict');
    expect(result.install).toBe('npm install');
    expect(result.source).toBe('override');
  });

  /**
   * The package has no `test:run` script, so detection cannot resolve the test command. The config
   * supplies `typecheck` and `install`, and the resolver must keep them, because config outranks detection.
   */
  it('resolveTestRuntime_DetectionUnresolved_PreservesConfigInstallAndTypecheck', () => {
    const dir = makeTmpDir();
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({ scripts: { build: 'tsc' } }),
    );

    const result = resolveTestRuntime(dir, {
      loadConfig: () => ({
        config: { typecheck: 'tsc --noEmit', install: 'npm ci' },
        source: '/x/.exarchos.yml',
      }),
    });

    expect(result.source).toBe('unresolved');
    expect(result.test).toBeNull();
    expect(result.typecheck).toBe('tsc --noEmit');
    expect(result.install).toBe('npm ci');
    expect(result.remediation).toBeDefined();
  });

  it('resolveTestRuntime_ConfigOnly_NoDetectionMarkers_SourceIsConfig', () => {
    const dir = makeTmpDir();

    const result = resolveTestRuntime(dir, {
      loadConfig: () => ({ config: { test: 'pytest' }, source: '/x/.exarchos.yml' }),
    });

    expect(result).toEqual({
      test: 'pytest',
      typecheck: null,
      install: null,
      source: 'config',
    });
  });

  it('resolveTestRuntime_NoConfigNoDetection_ReturnsUnresolved', () => {
    const dir = makeTmpDir();

    const result = resolveTestRuntime(dir, { loadConfig: () => null });

    expect(result.test).toBeNull();
    expect(result.typecheck).toBeNull();
    expect(result.install).toBeNull();
    expect(result.source).toBe('unresolved');
    expect(result.remediation).toBeDefined();
    expect(result.remediation!.length).toBeGreaterThan(0);
  });

  it('resolveTestRuntime_ConfigSchemaErrorPropagates', () => {
    const dir = makeTmpDir();
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({ scripts: { 'test:run': 'vitest run' } }),
    );

    expect(() =>
      resolveTestRuntime(dir, {
        loadConfig: () => {
          throw new Error('Invalid .exarchos.yml at /x/.exarchos.yml: test: contains disallowed shell metacharacters');
        },
      }),
    ).toThrow(/Invalid \.exarchos\.yml/);
  });

  /**
   * With no `eventStore` option there is no spy, so the test cannot observe an emission.
   * It proves only that resolution succeeds without a store.
   */
  it('resolveTestRuntime_NoEventStore_NoEmissions', () => {
    const dir = makeTmpDir();
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({ scripts: { 'test:run': 'vitest run' } }),
    );

    const result = resolveTestRuntime(dir);
    expect(result.source).toBe('detection');
  });

  it('resolveTestRuntime_WithEventStoreNpmDetection_EmitsThreeDetectionEvents', () => {
    const dir = makeTmpDir();
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({ scripts: { 'test:run': 'vitest run', typecheck: 'tsc --noEmit' } }),
    );
    const append = vi.fn();
    const eventStore = { append };

    const result = resolveTestRuntime(dir, { eventStore, stream: 'feat-123' });

    expect(append).toHaveBeenCalledTimes(3);
    const calls = append.mock.calls.map((c) => c[1]);
    const byField = new Map<string, { type: string; data: Record<string, unknown> }>(
      calls.map((e) => [(e.data as { field: string }).field, e as { type: string; data: Record<string, unknown> }]),
    );

    expect(byField.get('test')).toEqual({
      type: 'command.resolved',
      data: { field: 'test', command: result.test, source: 'detection', repoRoot: dir },
    });
    expect(byField.get('typecheck')).toEqual({
      type: 'command.resolved',
      data: { field: 'typecheck', command: result.typecheck, source: 'detection', repoRoot: dir },
    });
    expect(byField.get('install')).toEqual({
      type: 'command.resolved',
      data: { field: 'install', command: result.install, source: 'detection', repoRoot: dir },
    });
  });

  it('resolveTestRuntime_WithEventStoreOverride_EmitsOverrideSourcePerOverriddenField', () => {
    const dir = makeTmpDir();
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({ scripts: { 'test:run': 'vitest run' } }),
    );
    const append = vi.fn();

    resolveTestRuntime(dir, {
      override: { test: 'custom-test' },
      eventStore: { append },
      stream: 'feat-x',
    });

    const calls = append.mock.calls.map((c) => c[1]);
    const byField = new Map<string, { data: { source: string } }>(
      calls.map((e) => [(e.data as { field: string }).field, e as { data: { source: string } }]),
    );
    expect(byField.get('test')?.data.source).toBe('override');
    expect(byField.get('typecheck')?.data.source).toBe('detection');
    expect(byField.get('install')?.data.source).toBe('detection');
  });

  /** The directory has no marker, so detection resolves nothing and `install` stays unresolved. */
  it('resolveTestRuntime_WithEventStoreConfig_EmitsConfigSource', () => {
    const dir = makeTmpDir();
    const append = vi.fn();

    resolveTestRuntime(dir, {
      loadConfig: () => ({
        config: { test: 'cfg-test', typecheck: 'cfg-typecheck' },
        path: '/x/.exarchos.yml',
      }),
      eventStore: { append },
      stream: 'feat-cfg',
    });

    const calls = append.mock.calls.map((c) => c[1]);
    const byField = new Map<string, { data: { source: string; command: string | null; remediation?: string } }>(
      calls.map((e) => [
        (e.data as { field: string }).field,
        e as { data: { source: string; command: string | null; remediation?: string } },
      ]),
    );
    expect(byField.get('test')?.data.source).toBe('config');
    expect(byField.get('test')?.data.command).toBe('cfg-test');
    expect(byField.get('typecheck')?.data.source).toBe('config');
    expect(byField.get('typecheck')?.data.command).toBe('cfg-typecheck');
    expect(byField.get('install')?.data.source).toBe('unresolved');
    expect(byField.get('install')?.data.command).toBeNull();
  });

  it('resolveTestRuntime_WithEventStoreUnresolved_EmitsUnresolvedSourceWithRemediation', () => {
    const dir = makeTmpDir();
    const append = vi.fn();

    resolveTestRuntime(dir, { eventStore: { append }, stream: 'feat-u' });

    expect(append).toHaveBeenCalledTimes(3);
    const calls = append.mock.calls.map((c) => c[1]);
    for (const evt of calls) {
      const data = evt.data as { source: string; command: string | null; remediation?: string };
      expect(data.source).toBe('unresolved');
      expect(data.command).toBeNull();
      expect(typeof data.remediation).toBe('string');
      expect((data.remediation ?? '').length).toBeGreaterThan(0);
    }
  });

  /**
   * .NET detection resolves only `test`. The events for `typecheck` and `install` are `unresolved`,
   * and the event schema requires a non-empty remediation for that source.
   * Each remediation must name its own field, and `CommandResolvedEventSchema` must accept all three events.
   */
  it('resolveTestRuntime_DotNetDetection_PartialFieldsEmitUnresolvedWithRemediation', async () => {
    const dir = makeTmpDir();
    writeFileSync(join(dir, 'MyApp.csproj'), '<Project></Project>');
    const append = vi.fn();

    const result = resolveTestRuntime(dir, { eventStore: { append }, stream: 'feat-net' });

    expect(result.test).toBe('dotnet test');
    expect(result.typecheck).toBeNull();
    expect(result.install).toBeNull();
    expect(result.source).toBe('detection');

    expect(append).toHaveBeenCalledTimes(3);
    const calls = append.mock.calls.map((c) => c[1]);
    const byField = new Map<
      string,
      { data: { source: string; command: string | null; remediation?: string } }
    >(
      calls.map((e) => [
        (e.data as { field: string }).field,
        e as { data: { source: string; command: string | null; remediation?: string } },
      ]),
    );

    const testEvt = byField.get('test');
    expect(testEvt?.data.source).toBe('detection');
    expect(testEvt?.data.command).toBe('dotnet test');
    expect(testEvt?.data.remediation).toBeUndefined();

    for (const field of ['typecheck', 'install'] as const) {
      const evt = byField.get(field);
      expect(evt?.data.source).toBe('unresolved');
      expect(evt?.data.command).toBeNull();
      expect(typeof evt?.data.remediation).toBe('string');
      expect((evt?.data.remediation ?? '').length).toBeGreaterThan(0);
      expect(evt?.data.remediation).toContain(field);
    }

    const { CommandResolvedEventSchema } = await import('../../../src/events/schemas.js');
    for (const evt of calls) {
      const parsed = CommandResolvedEventSchema.safeParse(evt.data);
      expect(parsed.success).toBe(true);
    }
  });

  it('resolveTestRuntime_WithEventStoreThrows_ResolutionStillSucceeds', () => {
    const dir = makeTmpDir();
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({ scripts: { 'test:run': 'vitest run' } }),
    );
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const append = vi.fn(() => {
      throw new Error('boom');
    });

    const result = resolveTestRuntime(dir, { eventStore: { append }, stream: 'feat-y' });

    expect(result.test).toBe('npm run test:run');
    expect(result.source).toBe('detection');
    warn.mockRestore();
  });

  it('resolveTestRuntime_EventStoreWithoutStream_Throws', () => {
    const dir = makeTmpDir();
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({ scripts: { 'test:run': 'vitest run' } }),
    );
    const append = vi.fn();

    expect(() =>
      resolveTestRuntime(dir, { eventStore: { append } }),
    ).toThrow(/stream.*required.*eventStore/i);
  });

  it('resolveTestRuntime_StreamPassedToEachAppend', () => {
    const dir = makeTmpDir();
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({ scripts: { 'test:run': 'vitest run' } }),
    );
    const append = vi.fn();

    resolveTestRuntime(dir, { eventStore: { append }, stream: 'my-feat-stream' });

    expect(append).toHaveBeenCalledTimes(3);
    for (const call of append.mock.calls) {
      expect(call[0]).toBe('my-feat-stream');
    }
  });

  /**
   * The `remediation` string is the only hint that a dispatched agent gets for an unresolved runtime.
   * It must hold an inline YAML example or a link to the docs. The test accepts either form, so a
   * docs reorganization does not constrain the message.
   */
  it('testRuntimeResolver_RemediationMessage_IncludesDocLinkOrExample', () => {
    const dir = makeTmpDir();

    const result = resolveTestRuntime(dir);

    expect(result.source).toBe('unresolved');
    expect(result.remediation).toBeDefined();
    const message = result.remediation!;
    const hasInlineYamlExample = /test:\s/.test(message);
    const hasDocLink = /https?:\/\/|content\/|docs\//.test(message);
    expect(
      hasInlineYamlExample || hasDocLink,
      `remediation must include an inline YAML example (a "test:" key) or a doc link, got: ${message}`,
    ).toBe(true);
  });

  /** Tier 3 is the user `toolchains:` list. Tier 4 is the task runner. */
  describe('layered tiers', () => {
    /** Built-in detection resolves `package.json` to node. The user toolchain for the same marker wins. */
    it('tier3_UserToolchain_OverridesBuiltinDetection', () => {
      const dir = makeTmpDir();
      writeFileSync(join(dir, 'package.json'), '{}');
      const result = resolveTestRuntime(dir, {
        loadConfig: () => ({
          config: {
            toolchains: [
              { id: 'node-custom', markers: ['package.json'], commands: { test: 'just test' } },
            ],
          },
          source: '/x/.exarchos.yml',
        }),
      });
      expect(result.test).toBe('just test');
      expect(result.source).toBe('toolchain-config');
    });

    /** Built-in detection resolves `Cargo.toml` to `cargo test`. The justfile wins. */
    it('tier4_TaskRunner_BeatsBuiltinDetection', () => {
      const dir = makeTmpDir();
      writeFileSync(join(dir, 'Cargo.toml'), '[package]');
      writeFileSync(join(dir, 'justfile'), 'test:\n\techo hi\n');
      const result = resolveTestRuntime(dir);
      expect(result.test).toBe('just test');
      expect(result.source).toBe('task-runner');
    });

    it('tier4_TaskRunner_RescuesNodeMissingTestScript', () => {
      const dir = makeTmpDir();
      writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts: {} }));
      writeFileSync(join(dir, 'Taskfile.yml'), 'tasks:\n  test:\n    cmds: [echo hi]\n');
      const result = resolveTestRuntime(dir);
      expect(result.test).toBe('task test');
      expect(result.source).toBe('task-runner');
    });

    it('precedence_YmlDirectTest_BeatsUserToolchain', () => {
      const dir = makeTmpDir();
      writeFileSync(join(dir, 'build.zig'), '');
      const result = resolveTestRuntime(dir, {
        loadConfig: () => ({
          config: {
            test: 'jest',
            toolchains: [
              { id: 'zig', markers: ['build.zig'], commands: { test: 'zig build test' } },
            ],
          },
          source: '/x/.exarchos.yml',
        }),
      });
      expect(result.test).toBe('jest');
      expect(result.source).toBe('config');
    });

    /** A committed task runner is a deliberate project interface, so it wins over the `test:run` script of a node repository. */
    it('tier4_TaskRunner_BeatsNodeWithWorkingTestScript', () => {
      const dir = makeTmpDir();
      writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts: { 'test:run': 'vitest run' } }));
      writeFileSync(join(dir, 'justfile'), 'test:\n\techo hi\n');
      const result = resolveTestRuntime(dir);
      expect(result.test).toBe('just test');
      expect(result.source).toBe('task-runner');
    });

    /** With no lockfile, the installed-state markers of `INSTALL_METADATA` identify the package manager. */
    it('nodeInstallMetadataFallback_NoLockfile_ResolvesPm', () => {
      const dir = makeTmpDir();
      writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts: { test: 'vitest run' } }));
      mkdirSync(join(dir, 'node_modules', '.pnpm'), { recursive: true });
      const result = resolveTestRuntime(dir);
      expect(result.test).toBe('pnpm test');
    });

    it('precedence_UserToolchain_BeatsTaskRunner', () => {
      const dir = makeTmpDir();
      writeFileSync(join(dir, 'build.zig'), '');
      writeFileSync(join(dir, 'justfile'), 'test:\n\techo hi\n');
      const result = resolveTestRuntime(dir, {
        loadConfig: () => ({
          config: {
            toolchains: [
              { id: 'zig', markers: ['build.zig'], commands: { test: 'zig build test' } },
            ],
          },
          source: '/x/.exarchos.yml',
        }),
      });
      expect(result.test).toBe('zig build test');
      expect(result.source).toBe('toolchain-config');
    });
  });
});

describe('resolveVerificationRuntime', () => {
  const tmpDirs: string[] = [];

  function makeTmpDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'verif-'));
    tmpDirs.push(dir);
    return dir;
  }

  afterEach(() => {
    for (const dir of tmpDirs) {
      rmrf(dir);
    }
    tmpDirs.length = 0;
  });

  /**
   * The test has four cases on a Rust repository. Detection seeds `cargo mutants --in-diff`.
   * A user toolchain beats detection, and a direct config value beats detection.
   * An override beats the config value.
   */
  it('ResolveVerificationRuntime_MutationField_HonorsLayeredPrecedence', () => {
    const rust = makeTmpDir();
    writeFileSync(join(rust, 'Cargo.toml'), '[package]');
    expect(resolveVerificationRuntime(rust).mutation).toBe('cargo mutants --in-diff');

    const userTc = makeTmpDir();
    writeFileSync(join(userTc, 'Cargo.toml'), '[package]');
    const tc3 = resolveVerificationRuntime(userTc, {
      loadConfig: () => ({
        config: {
          toolchains: [
            { id: 'rust-custom', markers: ['Cargo.toml'], commands: { test: 'cargo test', mutation: 'cargo mutants --workspace' } },
          ],
        },
        source: '/x/.exarchos.yml',
      }),
    });
    expect(tc3.mutation).toBe('cargo mutants --workspace');

    const cfg = makeTmpDir();
    writeFileSync(join(cfg, 'Cargo.toml'), '[package]');
    const tc2 = resolveVerificationRuntime(cfg, {
      loadConfig: () => ({ config: { mutation: 'config-mutation' }, source: '/x/.exarchos.yml' }),
    });
    expect(tc2.mutation).toBe('config-mutation');

    const ovr = makeTmpDir();
    writeFileSync(join(ovr, 'Cargo.toml'), '[package]');
    const tc1 = resolveVerificationRuntime(ovr, {
      override: { mutation: 'override-mutation' },
      loadConfig: () => ({ config: { mutation: 'config-mutation' }, source: '/x/.exarchos.yml' }),
    });
    expect(tc1.mutation).toBe('override-mutation');
  });

  /** Go detection seeds `go vet ./...`. A direct config value beats detection, and an override beats the config value. */
  it('ResolveVerificationRuntime_LintField_HonorsLayeredPrecedence', () => {
    const go = makeTmpDir();
    writeFileSync(join(go, 'go.mod'), 'module example.com/x\n');
    expect(resolveVerificationRuntime(go).lint).toBe('go vet ./...');

    const cfg = makeTmpDir();
    writeFileSync(join(cfg, 'go.mod'), 'module example.com/x\n');
    expect(
      resolveVerificationRuntime(cfg, {
        loadConfig: () => ({ config: { lint: 'golangci-lint run' }, source: '/x/.exarchos.yml' }),
      }).lint,
    ).toBe('golangci-lint run');

    const ovr = makeTmpDir();
    writeFileSync(join(ovr, 'go.mod'), 'module example.com/x\n');
    expect(
      resolveVerificationRuntime(ovr, {
        override: { lint: 'override-lint' },
        loadConfig: () => ({ config: { lint: 'golangci-lint run' }, source: '/x/.exarchos.yml' }),
      }).lint,
    ).toBe('override-lint');
  });

  /**
   * A direct config value gives the structured `{ codegen, diff }` contract, and an override beats it.
   * A Rust marker alone gives null, because no built-in toolchain supplies a contract.
   */
  it('ResolveVerificationRuntime_ContractField_ResolvesStructured', () => {
    const dir = makeTmpDir();
    const result = resolveVerificationRuntime(dir, {
      loadConfig: () => ({
        config: { contract: { codegen: 'buf generate', diff: 'buf breaking' } },
        source: '/x/.exarchos.yml',
      }),
    });
    expect(result.contract).toEqual({ codegen: 'buf generate', diff: 'buf breaking' });

    const ovr = makeTmpDir();
    const overridden = resolveVerificationRuntime(ovr, {
      override: { contract: { codegen: 'override-codegen', diff: 'override-diff' } },
      loadConfig: () => ({
        config: { contract: { codegen: 'buf generate', diff: 'buf breaking' } },
        source: '/x/.exarchos.yml',
      }),
    });
    expect(overridden.contract).toEqual({ codegen: 'override-codegen', diff: 'override-diff' });

    const none = makeTmpDir();
    writeFileSync(join(none, 'Cargo.toml'), '[package]');
    expect(resolveVerificationRuntime(none).contract).toBeNull();
  });

  /**
   * `resolveTestRuntime` returns only `test`, `typecheck`, `install`, `source` and an optional
   * `remediation`. The result must hold no `mutation`, `lint` or `contract` field.
   * An unresolved result still carries the remediation.
   */
  it('ResolveTestRuntime_Alias_BehaviorUnchanged', () => {
    const dir = makeTmpDir();
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({ scripts: { 'test:run': 'vitest run', typecheck: 'tsc --noEmit' } }),
    );
    const legacy = resolveTestRuntime(dir);
    expect(legacy).toEqual({
      test: 'npm run test:run',
      typecheck: 'npm run typecheck',
      install: 'npm install',
      source: 'detection',
    });
    expect('mutation' in legacy).toBe(false);
    expect('lint' in legacy).toBe(false);
    expect('contract' in legacy).toBe(false);

    const empty = makeTmpDir();
    const un = resolveTestRuntime(empty);
    expect(un.source).toBe('unresolved');
    expect(un.remediation).toBeDefined();
  });

  /**
   * Property: the override wins on its own field, because the first non-null layer wins. A config
   * value on a different field survives the override. When both name the same field, the override wins.
   * `Cargo.toml` gives the detection baseline.
   */
  it('property_PerFieldIndependence_AndFirstNonNullLayerWins', () => {
    const cmd = fc.constantFrom('alpha', 'beta', 'gamma', 'delta');
    const field = fc.constantFrom('test', 'typecheck', 'install', 'mutation', 'lint');
    fc.assert(
      fc.property(
        field,
        cmd,
        field,
        cmd,
        (overrideField, overrideVal, configField, configVal) => {
          const dir = makeTmpDir();
          writeFileSync(join(dir, 'Cargo.toml'), '[package]');
          const result = resolveVerificationRuntime(dir, {
            override: { [overrideField]: overrideVal },
            loadConfig: () => ({ config: { [configField]: configVal }, source: '/x/.exarchos.yml' }),
          });
          const r = result as unknown as Record<string, string | null>;
          expect(r[overrideField]).toBe(overrideVal);
          if (configField !== overrideField) {
            expect(r[configField]).toBe(configVal);
          }
        },
      ),
      { numRuns: 60 },
    );
  });
});

/**
 * The toolchain loader validates `.exarchos.yml` against `FullExarchosConfigSchema`, the strict
 * merge of `ExarchosConfigSchema` and `ProjectConfigSchema`. Project keys such as `review:` and
 * `verification:` live in `ProjectConfigSchema`, so the merged schema accepts them.
 * The bare `ExarchosConfigSchema` rejects them.
 */
describe('ExarchosConfigSchema verification-key tolerance', () => {
  /**
   * A config with a toolchain key and a `verification:` block must parse under the merged schema, as
   * one with a `review:` block does. The toolchain key survives next to the project key.
   * The bare `ExarchosConfigSchema` rejects both blocks, so the loader uses the merged schema.
   */
  it('ExarchosConfigSchema_ForeignVerificationKey_ToleratedOnToolchainPath', () => {
    const withVerification = {
      test: 'bun test',
      verification: { policy: { low: ['check_static_analysis'] } },
    };
    const withReview = {
      test: 'bun test',
      review: { routing: { 'coderabbit-threshold': 0.4 } },
    };

    const verifResult = FullExarchosConfigSchema.safeParse(withVerification);
    const reviewResult = FullExarchosConfigSchema.safeParse(withReview);

    expect(verifResult.success).toBe(true);
    expect(reviewResult.success).toBe(true);
    expect(verifResult.success).toBe(reviewResult.success);

    if (verifResult.success) {
      expect(verifResult.data.test).toBe('bun test');
      expect(verifResult.data.verification?.policy?.low).toEqual(['check_static_analysis']);
    }

    expect(ExarchosConfigSchema.safeParse(withVerification).success).toBe(false);
    expect(ExarchosConfigSchema.safeParse(withReview).success).toBe(false);
  });
});

/**
 * The fixture models two workspaces that commit the same `test:run` vitest script. One has an npm
 * lockfile and one has a bun lockfile. The resolver must send both to the `test:run` script, so they
 * run the same suite. The bun workspace must not fall through to `bun test`, the native bun runner.
 */
describe('supported-workspace test-runtime consistency (WFQ-015 / exit-proof c)', () => {
  const tmpDirs: string[] = [];
  function makeTmpDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'ws-consistency-'));
    tmpDirs.push(dir);
    return dir;
  }
  afterEach(() => {
    for (const dir of tmpDirs) rmrf(dir);
    tmpDirs.length = 0;
  });

  const pkg = JSON.stringify({
    scripts: { 'test:run': 'vitest run', typecheck: 'tsc --noEmit' },
  });

  it('npm-managed root and bun-managed mcp workspace both resolve their test:run script', () => {
    const rootLike = makeTmpDir();
    writeFileSync(join(rootLike, 'package.json'), pkg);
    writeFileSync(join(rootLike, 'package-lock.json'), '{}');

    const mcpLike = makeTmpDir();
    writeFileSync(join(mcpLike, 'package.json'), pkg);
    writeFileSync(join(mcpLike, 'bun.lock'), '');

    const rootResult = resolveTestRuntime(rootLike);
    const mcpResult = resolveTestRuntime(mcpLike);

    expect(rootResult.test).toBe('npm run test:run');
    expect(mcpResult.test).toBe('bun run test:run');
    expect(rootResult.test?.endsWith('run test:run')).toBe(true);
    expect(mcpResult.test?.endsWith('run test:run')).toBe(true);

    expect(mcpResult.test).not.toBe('bun test');
    expect(rootResult.test).not.toBe('npm test');

    expect(rootResult.source).toBe('detection');
    expect(mcpResult.source).toBe('detection');
  });
});

describe('top-level mutation config shape (WFQ-013 / DOC-5)', () => {
  const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
  const tmpDirs: string[] = [];
  function makeTmpDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'doc5-'));
    tmpDirs.push(dir);
    return dir;
  }
  afterEach(() => {
    for (const dir of tmpDirs) rmrf(dir);
    tmpDirs.length = 0;
  });

  /**
   * `mutation` is a valid top-level key, and the committed root config declares it. The load must not
   * throw, and the value must reach `config.mutation`. The schema is strict, so a schema that does not
   * know the key rejects the committed file.
   */
  it('committed root .exarchos.yml loads clean and exposes a top-level `mutation`', () => {
    const result = loadExarchosConfig(REPO_ROOT);
    expect(result).not.toBeNull();
    expect(result!.config.mutation).toBe('node tools/audit/core/stryker-adapter.mjs');
  });

  it('resolveVerificationRuntime honors a top-level `mutation` via the config-direct tier', () => {
    const dir = makeTmpDir();
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({ scripts: { 'test:run': 'vitest run' } }),
    );
    writeFileSync(join(dir, '.exarchos.yml'), 'mutation: echo mutate\n');

    const result = resolveVerificationRuntime(dir);

    expect(result.mutation).toBe('echo mutate');
  });
});

describe('resolveRunnableCommand', () => {
  const tmpDirs: string[] = [];
  function makeTmpDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'runnable-'));
    tmpDirs.push(dir);
    return dir;
  }
  afterEach(() => {
    for (const dir of tmpDirs) rmrf(dir);
    tmpDirs.length = 0;
  });

  it('RunnableCommand_GoModule_SplitsTheDetectedTestCommand', () => {
    const dir = makeTmpDir();
    writeFileSync(join(dir, 'go.mod'), 'module example.com/fixture\n');

    expect(resolveRunnableCommand(dir, 'test')).toEqual({
      kind: 'runnable',
      command: 'go test ./...',
      bin: 'go',
      args: ['test', './...'],
    });
  });

  it('RunnableCommand_ConfiguredCommand_KeepsAQuotedArgumentWhole', () => {
    const dir = makeTmpDir();
    writeFileSync(join(dir, '.exarchos.yml'), `test: 'pytest -k "slow api"'\n`);

    expect(resolveRunnableCommand(dir, 'test')).toEqual({
      kind: 'runnable',
      command: 'pytest -k "slow api"',
      bin: 'pytest',
      args: ['-k', 'slow api'],
    });
  });

  it('RunnableCommand_NoProjectMarkers_IsUnresolvedWithTheRemediation', () => {
    const dir = makeTmpDir();

    const result = resolveRunnableCommand(dir, 'test');

    expect(result.kind).toBe('unresolved');
    expect(result.kind !== 'runnable' && result.reason).toMatch(/No project markers detected/);
  });

  it('RunnableCommand_ToolchainWithoutTypecheck_IsUnresolvedNotInvalid', () => {
    const dir = makeTmpDir();
    writeFileSync(join(dir, 'go.mod'), 'module example.com/fixture\n');

    const result = resolveRunnableCommand(dir, 'typecheck');

    expect(result.kind).toBe('unresolved');
    expect(result.kind !== 'runnable' && result.reason).toMatch(/"typecheck" entry to \.exarchos\.yml/);
  });

  it('RunnableCommand_InvalidConfig_IsInvalidAndDoesNotThrow', () => {
    const dir = makeTmpDir();
    writeFileSync(join(dir, '.exarchos.yml'), `test: 'pytest; rm -rf build'\n`);

    const result = resolveRunnableCommand(dir, 'test');

    expect(result.kind).toBe('invalid');
    expect(result.kind !== 'runnable' && result.reason).toMatch(/toolchain resolver failed/);
  });

  it('RunnableCommand_UnterminatedQuote_IsInvalid', () => {
    const dir = makeTmpDir();
    writeFileSync(join(dir, '.exarchos.yml'), `test: 'pytest -k "slow'\n`);

    const result = resolveRunnableCommand(dir, 'test');

    expect(result.kind).toBe('invalid');
    expect(result.kind !== 'runnable' && result.reason).toMatch(/cannot be parsed/);
  });
});
