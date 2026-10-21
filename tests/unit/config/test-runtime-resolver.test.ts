import { describe, it, expect, afterEach, vi } from 'vitest';
import fc from 'fast-check';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  resolveRunnableCommand,
  resolveScopedTestCommand,
  resolveTestRuntime,
  resolveVerificationRuntime,
} from '../../../src/config/test-runtime-resolver.js';
import { loadExarchosConfig } from '../../../src/config/load-exarchos-config.js';
import { ExarchosConfigSchema } from '../../../src/config/exarchos-config-schema.js';
import { FullExarchosConfigSchema } from '../../../src/config/yaml-schema.js';
import { rmrf } from '../../../tools/test-helpers/temp-dir.js';
import { isolatedSync } from '../../../tools/test-helpers/spawn.js';

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

  it('resolveTestRuntime_NodeProject_ReturnsNpmCommands', async () => {
    const dir = makeTmpDir();
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({ scripts: { 'test:run': 'vitest run', typecheck: 'tsc --noEmit' } }),
    );

    const result = await isolatedSync(() => resolveTestRuntime(dir));

    expect(result).toEqual({
      test: 'npm run test:run',
      typecheck: 'npm run typecheck',
      install: 'npm install',
      source: 'detection',
    });
  });

  it('resolveTestRuntime_PythonProject_ReturnsPytestCommand', async () => {
    const dir = makeTmpDir();
    writeFileSync(join(dir, 'pyproject.toml'), '[project]');

    const result = await isolatedSync(() => resolveTestRuntime(dir));

    expect(result).toEqual({
      test: 'pytest',
      typecheck: null,
      install: null,
      source: 'detection',
    });
  });

  it('resolveTestRuntime_RustProject_ReturnsCargoCommand', async () => {
    const dir = makeTmpDir();
    writeFileSync(join(dir, 'Cargo.toml'), '[package]');

    const result = await isolatedSync(() => resolveTestRuntime(dir));

    expect(result).toEqual({
      test: 'cargo test',
      typecheck: null,
      install: null,
      source: 'detection',
    });
  });

  it('resolveTestRuntime_DotNetProject_ReturnsDotnetCommand', async () => {
    const dir = makeTmpDir();
    writeFileSync(join(dir, 'Foo.csproj'), '<Project/>');

    const result = await isolatedSync(() => resolveTestRuntime(dir));

    expect(result).toEqual({
      test: 'dotnet test',
      typecheck: null,
      install: null,
      source: 'detection',
    });
  });

  it.each(['App.sln', 'App.slnx'])(
    'resolveTestRuntime_DotNetSolution_%s_ReturnsDotnetCommand (#1507)',
    async (solutionFile) => {
      const dir = makeTmpDir();
      writeFileSync(join(dir, solutionFile), '');

      const result = await isolatedSync(() => resolveTestRuntime(dir));

      expect(result).toEqual({
        test: 'dotnet test',
        typecheck: null,
        install: null,
        source: 'detection',
      });
    },
  );

  it('resolveTestRuntime_GoProject_ReturnsGoCommand', async () => {
    const dir = makeTmpDir();
    writeFileSync(join(dir, 'go.mod'), 'module example.com/x\n');

    const result = await isolatedSync(() => resolveTestRuntime(dir));

    expect(result).toEqual({
      test: 'go test ./...',
      typecheck: null,
      install: null,
      source: 'detection',
    });
  });

  it('resolveTestRuntime_NoMarkers_ReturnsUnresolved', async () => {
    const dir = makeTmpDir();

    const result = await isolatedSync(() => resolveTestRuntime(dir));

    expect(result.test).toBeNull();
    expect(result.typecheck).toBeNull();
    expect(result.install).toBeNull();
    expect(result.source).toBe('unresolved');
    expect(result.remediation).toBeDefined();
    expect(result.remediation!.length).toBeGreaterThan(0);
  });

  it('resolveTestRuntime_OverrideTestProvided_ReturnsOverride', async () => {
    const dir = makeTmpDir();

    const result = await isolatedSync(() => resolveTestRuntime(dir, { override: { test: 'bun test' } }));

    expect(result.test).toBe('bun test');
    expect(result.source).toBe('override');
  });

  it('resolveTestRuntime_OverrideAllFieldsProvided_ReturnsOverrideForAll', async () => {
    const dir = makeTmpDir();

    const result = await isolatedSync(() => resolveTestRuntime(dir, {
      override: {
        test: 'bun test',
        typecheck: 'bunx tsc --noEmit',
        install: 'bun install',
      },
    }));

    expect(result).toEqual({
      test: 'bun test',
      typecheck: 'bunx tsc --noEmit',
      install: 'bun install',
      source: 'override',
    });
  });

  it('resolveTestRuntime_OverridePartial_MergesWithDetection', async () => {
    const dir = makeTmpDir();
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({ scripts: { 'test:run': 'vitest run', typecheck: 'tsc --noEmit' } }),
    );

    const result = await isolatedSync(() => resolveTestRuntime(dir, { override: { test: 'bun test' } }));

    expect(result).toEqual({
      test: 'bun test',
      typecheck: 'npm run typecheck',
      install: 'npm install',
      source: 'override',
    });
  });

  it('resolveTestRuntime_OverrideUnsafeChars_Throws', async () => {
    const dir = makeTmpDir();

    await expect(isolatedSync(() => resolveTestRuntime(dir, { override: { test: 'npm test; rm -rf /' } }))).rejects.toThrow();
    await expect(isolatedSync(() => resolveTestRuntime(dir, { override: { test: 'echo `whoami`' } }))).rejects.toThrow();
    await expect(isolatedSync(() => resolveTestRuntime(dir, { override: { test: 'echo $HOME' } }))).rejects.toThrow();
    await expect(isolatedSync(() => resolveTestRuntime(dir, { override: { typecheck: 'tsc && evil' } }))).rejects.toThrow();
    await expect(isolatedSync(() => resolveTestRuntime(dir, { override: { install: 'npm i | bad' } }))).rejects.toThrow();
  });

  it('resolveTestRuntime_PriorityPackageJsonWinsOverPyproject', async () => {
    const dir = makeTmpDir();
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({ scripts: { 'test:run': 'vitest run', typecheck: 'tsc --noEmit' } }),
    );
    writeFileSync(join(dir, 'pyproject.toml'), '[project]');

    const result = await isolatedSync(() => resolveTestRuntime(dir));

    expect(result.test).toBe('npm run test:run');
    expect(result.typecheck).toBe('npm run typecheck');
    expect(result.install).toBe('npm install');
    expect(result.source).toBe('detection');
  });

  it('resolveTestRuntime_BunProject_DetectsBunLockfile', async () => {
    const dir = makeTmpDir();
    writeFileSync(join(dir, 'package.json'), '{}');
    writeFileSync(join(dir, 'bun.lockb'), '');

    const result = await isolatedSync(() => resolveTestRuntime(dir));

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
  it('resolveTestRuntime_BunProjectWithTestRunScript_HonorsTestRunViaBunRun', async () => {
    const dir = makeTmpDir();
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({ scripts: { 'test:run': 'vitest run', typecheck: 'tsc --noEmit' } }),
    );
    writeFileSync(join(dir, 'bun.lock'), '');

    const result = await isolatedSync(() => resolveTestRuntime(dir));

    expect(result).toEqual({
      test: 'bun run test:run',
      typecheck: 'bun run typecheck',
      install: 'bun install',
      source: 'detection',
    });
  });

  /** A `test:run` script does not imply a `typecheck` script. Without one, typecheck falls back to `tsc --noEmit`. */
  it('resolveTestRuntime_BunProjectWithTestRunButNoTypecheck_FallsBackToTsc', async () => {
    const dir = makeTmpDir();
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({ scripts: { 'test:run': 'vitest run' } }),
    );
    writeFileSync(join(dir, 'bun.lock'), '');

    const result = await isolatedSync(() => resolveTestRuntime(dir));

    expect(result).toEqual({
      test: 'bun run test:run',
      typecheck: 'tsc --noEmit',
      install: 'bun install',
      source: 'detection',
    });
  });

  it('resolveTestRuntime_PnpmProject_DetectsPnpmLockfile', async () => {
    const dir = makeTmpDir();
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts: { test: 'vitest run' } }));
    writeFileSync(join(dir, 'pnpm-lock.yaml'), '');

    const result = await isolatedSync(() => resolveTestRuntime(dir));

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
  it('resolveTestRuntime_YarnClassicProject_UsesFrozenLockfile', async () => {
    const dir = makeTmpDir();
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts: { test: 'vitest run' } }));
    writeFileSync(join(dir, 'yarn.lock'), '');

    const result = await isolatedSync(() => resolveTestRuntime(dir));

    expect(result).toEqual({
      test: 'yarn test',
      typecheck: 'tsc --noEmit',
      install: 'yarn install --frozen-lockfile',
      source: 'detection',
    });
  });

  it('resolveTestRuntime_YarnBerryProject_UsesImmutable_ViaYarnrcYml', async () => {
    const dir = makeTmpDir();
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts: { test: 'vitest run' } }));
    writeFileSync(join(dir, 'yarn.lock'), '');
    writeFileSync(join(dir, '.yarnrc.yml'), 'nodeLinker: node-modules\n');

    const result = await isolatedSync(() => resolveTestRuntime(dir));

    expect(result.install).toBe('yarn install --immutable');
    expect(result.source).toBe('detection');
  });

  it('resolveTestRuntime_YarnBerryProject_UsesImmutable_ViaPackageManagerField', async () => {
    const dir = makeTmpDir();
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({
        scripts: { test: 'vitest run' },
        packageManager: 'yarn@3.6.0',
      }),
    );
    writeFileSync(join(dir, 'yarn.lock'), '');

    const result = await isolatedSync(() => resolveTestRuntime(dir));

    expect(result.install).toBe('yarn install --immutable');
  });

  it('resolveTestRuntime_NpmProject_NoAltLockfile_ReturnsNpmCommands', async () => {
    const dir = makeTmpDir();
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({ scripts: { 'test:run': 'vitest run', typecheck: 'tsc --noEmit' } }),
    );
    writeFileSync(join(dir, 'package-lock.json'), '{}');

    const result = await isolatedSync(() => resolveTestRuntime(dir));

    expect(result).toEqual({
      test: 'npm run test:run',
      typecheck: 'npm run typecheck',
      install: 'npm install',
      source: 'detection',
    });
  });

  it('resolveTestRuntime_BunAndPnpmLockfiles_BunWins', async () => {
    const dir = makeTmpDir();
    writeFileSync(join(dir, 'package.json'), '{}');
    writeFileSync(join(dir, 'bun.lockb'), '');
    writeFileSync(join(dir, 'pnpm-lock.yaml'), '');

    const result = await isolatedSync(() => resolveTestRuntime(dir));

    expect(result).toEqual({
      test: 'bun test',
      typecheck: 'tsc --noEmit',
      install: 'bun install',
      source: 'detection',
    });
  });

  it('resolveTestRuntime_PnpmAndYarnLockfiles_PnpmWins', async () => {
    const dir = makeTmpDir();
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts: { test: 'vitest run' } }));
    writeFileSync(join(dir, 'pnpm-lock.yaml'), '');
    writeFileSync(join(dir, 'yarn.lock'), '');

    const result = await isolatedSync(() => resolveTestRuntime(dir));

    expect(result).toEqual({
      test: 'pnpm test',
      typecheck: 'tsc --noEmit',
      install: 'pnpm install --frozen-lockfile',
      source: 'detection',
    });
  });

  it('resolveTestRuntime_BunLockfileWithoutPackageJson_FallsThroughToUnresolved', async () => {
    const dir = makeTmpDir();
    writeFileSync(join(dir, 'bun.lockb'), '');

    const result = await isolatedSync(() => resolveTestRuntime(dir));

    expect(result.source).toBe('unresolved');
    expect(result.test).toBeNull();
    expect(result.typecheck).toBeNull();
    expect(result.install).toBeNull();
  });

  /**
   * The remediation must name `.exarchos.yml` or the missing script. The install command stays set,
   * so a caller can still install the dependencies.
   */
  it('resolveTestRuntime_NpmProjectMissingTestRunScript_ReturnsUnresolvedTestWithRemediation', async () => {
    const dir = makeTmpDir();
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({ scripts: { build: 'tsc' } }),
    );

    const result = await isolatedSync(() => resolveTestRuntime(dir));

    expect(result.test).toBeNull();
    expect(result.source).toBe('unresolved');
    expect(result.remediation).toBeDefined();
    expect(result.remediation!.length).toBeGreaterThan(0);
    expect(
      result.remediation!.includes('.exarchos.yml') || result.remediation!.includes('test:run'),
    ).toBe(true);
    expect(result.install).toBe('npm install');
  });

  it('resolveTestRuntime_NpmProjectWithTestRunScript_ReturnsNpmRunTestRun', async () => {
    const dir = makeTmpDir();
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({ scripts: { 'test:run': 'vitest run', typecheck: 'tsc --noEmit' } }),
    );

    const result = await isolatedSync(() => resolveTestRuntime(dir));

    expect(result).toEqual({
      test: 'npm run test:run',
      typecheck: 'npm run typecheck',
      install: 'npm install',
      source: 'detection',
    });
  });

  it('resolveTestRuntime_NpmProjectMissingTypecheckScript_FallsBackToTscNoEmit', async () => {
    const dir = makeTmpDir();
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({ scripts: { 'test:run': 'vitest run' } }),
    );

    const result = await isolatedSync(() => resolveTestRuntime(dir));

    expect(result).toEqual({
      test: 'npm run test:run',
      typecheck: 'tsc --noEmit',
      install: 'npm install',
      source: 'detection',
    });
  });

  it('resolveTestRuntime_PnpmProjectMissingTestScript_ReturnsUnresolvedWithRemediation', async () => {
    const dir = makeTmpDir();
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts: { build: 'tsc' } }));
    writeFileSync(join(dir, 'pnpm-lock.yaml'), '');

    const result = await isolatedSync(() => resolveTestRuntime(dir));

    expect(result.test).toBeNull();
    expect(result.source).toBe('unresolved');
    expect(result.remediation).toBeDefined();
    expect(
      result.remediation!.includes('.exarchos.yml') || result.remediation!.includes('test'),
    ).toBe(true);
  });

  it('resolveTestRuntime_YarnProjectMissingTestScript_ReturnsUnresolvedWithRemediation', async () => {
    const dir = makeTmpDir();
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts: { build: 'tsc' } }));
    writeFileSync(join(dir, 'yarn.lock'), '');

    const result = await isolatedSync(() => resolveTestRuntime(dir));

    expect(result.test).toBeNull();
    expect(result.source).toBe('unresolved');
    expect(result.remediation).toBeDefined();
    expect(
      result.remediation!.includes('.exarchos.yml') || result.remediation!.includes('test'),
    ).toBe(true);
  });

  it('resolveTestRuntime_BunProjectMissingTestScript_StillReturnsBunTest', async () => {
    const dir = makeTmpDir();
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts: { build: 'tsc' } }));
    writeFileSync(join(dir, 'bun.lockb'), '');

    const result = await isolatedSync(() => resolveTestRuntime(dir));

    expect(result).toEqual({
      test: 'bun test',
      typecheck: 'tsc --noEmit',
      install: 'bun install',
      source: 'detection',
    });
  });

  it('resolveTestRuntime_NpmProjectScriptsFieldAbsent_ReturnsUnresolved', async () => {
    const dir = makeTmpDir();
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'no-scripts-here' }));

    const result = await isolatedSync(() => resolveTestRuntime(dir));

    expect(result.test).toBeNull();
    expect(result.source).toBe('unresolved');
    expect(result.remediation).toBeDefined();
    expect(
      result.remediation!.includes('.exarchos.yml') || result.remediation!.includes('test:run'),
    ).toBe(true);
  });

  it('resolveTestRuntime_NpmProjectMalformedPackageJson_HandlesGracefully', async () => {
    const dir = makeTmpDir();
    writeFileSync(join(dir, 'package.json'), '{ "name": "broken", "scripts": {');

    const result = await isolatedSync(() => resolveTestRuntime(dir));

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
  it('resolveTestRuntime_NoEventStore_NoEmissions', async () => {
    const dir = makeTmpDir();
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({ scripts: { 'test:run': 'vitest run' } }),
    );

    const result = await isolatedSync(() => resolveTestRuntime(dir));
    expect(result.source).toBe('detection');
  });

  it('resolveTestRuntime_WithEventStoreNpmDetection_EmitsThreeDetectionEvents', async () => {
    const dir = makeTmpDir();
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({ scripts: { 'test:run': 'vitest run', typecheck: 'tsc --noEmit' } }),
    );
    const append = vi.fn();
    const eventStore = { append };

    const result = await isolatedSync(() => resolveTestRuntime(dir, { eventStore, stream: 'feat-123' }));

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

  it('resolveTestRuntime_WithEventStoreOverride_EmitsOverrideSourcePerOverriddenField', async () => {
    const dir = makeTmpDir();
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({ scripts: { 'test:run': 'vitest run' } }),
    );
    const append = vi.fn();

    await isolatedSync(() => resolveTestRuntime(dir, {
      override: { test: 'custom-test' },
      eventStore: { append },
      stream: 'feat-x',
    }));

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

  it('resolveTestRuntime_WithEventStoreUnresolved_EmitsUnresolvedSourceWithRemediation', async () => {
    const dir = makeTmpDir();
    const append = vi.fn();

    await isolatedSync(() => resolveTestRuntime(dir, { eventStore: { append }, stream: 'feat-u' }));

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

    const result = await isolatedSync(() => resolveTestRuntime(dir, { eventStore: { append }, stream: 'feat-net' }));

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

  it('resolveTestRuntime_WithEventStoreThrows_ResolutionStillSucceeds', async () => {
    const dir = makeTmpDir();
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({ scripts: { 'test:run': 'vitest run' } }),
    );
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const append = vi.fn(() => {
      throw new Error('boom');
    });

    const result = await isolatedSync(() => resolveTestRuntime(dir, { eventStore: { append }, stream: 'feat-y' }));

    expect(result.test).toBe('npm run test:run');
    expect(result.source).toBe('detection');
    warn.mockRestore();
  });

  it('resolveTestRuntime_EventStoreWithoutStream_Throws', async () => {
    const dir = makeTmpDir();
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({ scripts: { 'test:run': 'vitest run' } }),
    );
    const append = vi.fn();

    await expect(isolatedSync(() => resolveTestRuntime(dir, { eventStore: { append } }))).rejects.toThrow(/stream.*required.*eventStore/i);
  });

  it('resolveTestRuntime_StreamPassedToEachAppend', async () => {
    const dir = makeTmpDir();
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({ scripts: { 'test:run': 'vitest run' } }),
    );
    const append = vi.fn();

    await isolatedSync(() => resolveTestRuntime(dir, { eventStore: { append }, stream: 'my-feat-stream' }));

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
  it('testRuntimeResolver_RemediationMessage_IncludesDocLinkOrExample', async () => {
    const dir = makeTmpDir();

    const result = await isolatedSync(() => resolveTestRuntime(dir));

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
    it('tier4_TaskRunner_BeatsBuiltinDetection', async () => {
      const dir = makeTmpDir();
      writeFileSync(join(dir, 'Cargo.toml'), '[package]');
      writeFileSync(join(dir, 'justfile'), 'test:\n\techo hi\n');
      const result = await isolatedSync(() => resolveTestRuntime(dir));
      expect(result.test).toBe('just test');
      expect(result.source).toBe('task-runner');
    });

    it('tier4_TaskRunner_RescuesNodeMissingTestScript', async () => {
      const dir = makeTmpDir();
      writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts: {} }));
      writeFileSync(join(dir, 'Taskfile.yml'), 'tasks:\n  test:\n    cmds: [echo hi]\n');
      const result = await isolatedSync(() => resolveTestRuntime(dir));
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
    it('tier4_TaskRunner_BeatsNodeWithWorkingTestScript', async () => {
      const dir = makeTmpDir();
      writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts: { 'test:run': 'vitest run' } }));
      writeFileSync(join(dir, 'justfile'), 'test:\n\techo hi\n');
      const result = await isolatedSync(() => resolveTestRuntime(dir));
      expect(result.test).toBe('just test');
      expect(result.source).toBe('task-runner');
    });

    /** With no lockfile, the installed-state markers of `INSTALL_METADATA` identify the package manager. */
    it('nodeInstallMetadataFallback_NoLockfile_ResolvesPm', async () => {
      const dir = makeTmpDir();
      writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts: { test: 'vitest run' } }));
      mkdirSync(join(dir, 'node_modules', '.pnpm'), { recursive: true });
      const result = await isolatedSync(() => resolveTestRuntime(dir));
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
  it('ResolveVerificationRuntime_MutationField_HonorsLayeredPrecedence', async () => {
    const rust = makeTmpDir();
    writeFileSync(join(rust, 'Cargo.toml'), '[package]');
    expect((await isolatedSync(() => resolveVerificationRuntime(rust))).mutation).toBe('cargo mutants --in-diff');

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
  it('ResolveVerificationRuntime_LintField_HonorsLayeredPrecedence', async () => {
    const go = makeTmpDir();
    writeFileSync(join(go, 'go.mod'), 'module example.com/x\n');
    expect((await isolatedSync(() => resolveVerificationRuntime(go))).lint).toBe('go vet ./...');

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
  it('ResolveVerificationRuntime_ContractField_ResolvesStructured', async () => {
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
    expect((await isolatedSync(() => resolveVerificationRuntime(none))).contract).toBeNull();
  });

  /**
   * `resolveTestRuntime` returns only `test`, `typecheck`, `install`, `source` and an optional
   * `remediation`. The result must hold no `mutation`, `lint` or `contract` field.
   * An unresolved result still carries the remediation.
   */
  it('ResolveTestRuntime_Alias_BehaviorUnchanged', async () => {
    const dir = makeTmpDir();
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({ scripts: { 'test:run': 'vitest run', typecheck: 'tsc --noEmit' } }),
    );
    const legacy = await isolatedSync(() => resolveTestRuntime(dir));
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
    const un = await isolatedSync(() => resolveTestRuntime(empty));
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

  it('npm-managed root and bun-managed mcp workspace both resolve their test:run script', async () => {
    const rootLike = makeTmpDir();
    writeFileSync(join(rootLike, 'package.json'), pkg);
    writeFileSync(join(rootLike, 'package-lock.json'), '{}');

    const mcpLike = makeTmpDir();
    writeFileSync(join(mcpLike, 'package.json'), pkg);
    writeFileSync(join(mcpLike, 'bun.lock'), '');

    const rootResult = await isolatedSync(() => resolveTestRuntime(rootLike));
    const mcpResult = await isolatedSync(() => resolveTestRuntime(mcpLike));

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
  it('committed root .exarchos.yml loads clean and exposes a top-level `mutation`', async () => {
    const result = await isolatedSync(() => loadExarchosConfig(REPO_ROOT));
    expect(result).not.toBeNull();
    expect(result!.config.mutation).toBe('node tools/audit/core/stryker-adapter.mjs');
  });

  it('resolveVerificationRuntime honors a top-level `mutation` via the config-direct tier', async () => {
    const dir = makeTmpDir();
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({ scripts: { 'test:run': 'vitest run' } }),
    );
    writeFileSync(join(dir, '.exarchos.yml'), 'mutation: echo mutate\n');

    const result = await isolatedSync(() => resolveVerificationRuntime(dir));

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

  it('RunnableCommand_GoModule_SplitsTheDetectedTestCommand', async () => {
    const dir = makeTmpDir();
    writeFileSync(join(dir, 'go.mod'), 'module example.com/fixture\n');

    expect(await isolatedSync(() => resolveRunnableCommand(dir, 'test'))).toEqual({
      kind: 'runnable',
      command: 'go test ./...',
      bin: 'go',
      args: ['test', './...'],
    });
  });

  it('RunnableCommand_ConfiguredCommand_KeepsAQuotedArgumentWhole', async () => {
    const dir = makeTmpDir();
    writeFileSync(join(dir, '.exarchos.yml'), `test: 'pytest -k "slow api"'\n`);

    expect(await isolatedSync(() => resolveRunnableCommand(dir, 'test'))).toEqual({
      kind: 'runnable',
      command: 'pytest -k "slow api"',
      bin: 'pytest',
      args: ['-k', 'slow api'],
    });
  });

  it('RunnableCommand_NoProjectMarkers_IsUnresolvedWithTheRemediation', async () => {
    const dir = makeTmpDir();

    const result = await isolatedSync(() => resolveRunnableCommand(dir, 'test'));

    expect(result.kind).toBe('unresolved');
    expect(result.kind !== 'runnable' && result.reason).toMatch(/No project markers detected/);
  });

  it('RunnableCommand_ToolchainWithoutTypecheck_IsUnresolvedNotInvalid', async () => {
    const dir = makeTmpDir();
    writeFileSync(join(dir, 'go.mod'), 'module example.com/fixture\n');

    const result = await isolatedSync(() => resolveRunnableCommand(dir, 'typecheck'));

    expect(result.kind).toBe('unresolved');
    expect(result.kind !== 'runnable' && result.reason).toMatch(/"typecheck" entry to \.exarchos\.yml/);
  });

  it('RunnableCommand_InvalidConfig_IsInvalidAndDoesNotThrow', async () => {
    const dir = makeTmpDir();
    writeFileSync(join(dir, '.exarchos.yml'), `test: 'pytest; rm -rf build'\n`);

    const result = await isolatedSync(() => resolveRunnableCommand(dir, 'test'));

    expect(result.kind).toBe('invalid');
    expect(result.kind !== 'runnable' && result.reason).toMatch(/toolchain resolver failed/);
  });

  it('RunnableCommand_UnterminatedQuote_IsInvalid', async () => {
    const dir = makeTmpDir();
    writeFileSync(join(dir, '.exarchos.yml'), `test: 'pytest -k "slow'\n`);

    const result = await isolatedSync(() => resolveRunnableCommand(dir, 'test'));

    expect(result.kind).toBe('invalid');
    expect(result.kind !== 'runnable' && result.reason).toMatch(/cannot be parsed/);
  });
});

/**
 * The kill probe runs the scoped test command with `-- <files>` after it. A `test:files` package script
 * is that command when it exists. Otherwise the command is the resolved `test` field, as before.
 */
describe('resolveScopedTestCommand', () => {
  const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
  const tmpDirs: string[] = [];
  function makeTmpDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'scoped-'));
    tmpDirs.push(dir);
    return dir;
  }
  afterEach(() => {
    for (const dir of tmpDirs) rmrf(dir);
    tmpDirs.length = 0;
  });

  function writeScripts(dir: string, scripts: Readonly<Record<string, string>>): void {
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts }));
  }

  it('ScopedTestCommand_NpmProjectWithTheScript_IsTheTestFilesScript', async () => {
    const dir = makeTmpDir();
    writeScripts(dir, { 'test:run': 'vitest run --project unit', 'test:files': 'vitest run' });

    expect((await isolatedSync(() => resolveScopedTestCommand(dir)))?.command).toBe('npm run test:files');
  });

  it('ScopedTestCommand_NpmProjectWithoutTheScript_IsTheResolvedTestCommand', async () => {
    const dir = makeTmpDir();
    writeScripts(dir, { 'test:run': 'vitest run --project unit' });

    expect((await isolatedSync(() => resolveScopedTestCommand(dir)))?.command).toBe('npm run test:run');
    expect((await isolatedSync(() => resolveScopedTestCommand(dir)))?.command).toBe((await isolatedSync(() => resolveTestRuntime(dir))).test);
  });

  it('ScopedTestCommand_BlankScript_IsTheResolvedTestCommand', async () => {
    const dir = makeTmpDir();
    writeScripts(dir, { 'test:run': 'vitest run', 'test:files': '   ' });

    expect((await isolatedSync(() => resolveScopedTestCommand(dir)))?.command).toBe('npm run test:run');
  });

  it.each([
    ['pnpm-lock.yaml', 'pnpm run test:files'],
    ['yarn.lock', 'yarn run test:files'],
    ['bun.lock', 'bun run test:files'],
  ])('ScopedTestCommand_%s_WithTheScript_RunsItThroughThatPackageManager', async (lockfile, expected) => {
    const dir = makeTmpDir();
    writeScripts(dir, { test: 'vitest', 'test:run': 'vitest run', 'test:files': 'vitest run' });
    writeFileSync(join(dir, lockfile), '');

    expect((await isolatedSync(() => resolveScopedTestCommand(dir)))?.command).toBe(expected);
  });

  it.each([
    ['pnpm-lock.yaml', 'pnpm test'],
    ['yarn.lock', 'yarn test'],
    ['bun.lock', 'bun test'],
  ])('ScopedTestCommand_%s_WithoutTheScript_KeepsTheTestCommand', async (lockfile, expected) => {
    const dir = makeTmpDir();
    writeScripts(dir, { test: 'vitest' });
    writeFileSync(join(dir, lockfile), '');

    expect((await isolatedSync(() => resolveScopedTestCommand(dir)))?.command).toBe(expected);
  });

  /** The script names a run of the given files. A configured `test` command names the whole suite, so the script comes first. */
  it('ScopedTestCommand_ConfiguredTestCommand_TheScriptComesFirst', async () => {
    const withScript = makeTmpDir();
    writeScripts(withScript, { 'test:run': 'vitest run', 'test:files': 'vitest run' });
    writeFileSync(join(withScript, '.exarchos.yml'), 'test: npm run test:unit\n');
    const withoutScript = makeTmpDir();
    writeScripts(withoutScript, { 'test:run': 'vitest run' });
    writeFileSync(join(withoutScript, '.exarchos.yml'), 'test: npm run test:unit\n');

    expect((await isolatedSync(() => resolveScopedTestCommand(withScript)))?.command).toBe('npm run test:files');
    expect((await isolatedSync(() => resolveScopedTestCommand(withoutScript)))?.command).toBe('npm run test:unit');
  });

  it('ScopedTestCommand_NonNodeProject_IsTheDetectedTestCommand', async () => {
    const dir = makeTmpDir();
    writeFileSync(join(dir, 'go.mod'), 'module example.com/fixture\n');

    expect((await isolatedSync(() => resolveScopedTestCommand(dir)))?.command).toBe('go test ./...');
  });

  /** A Node project reads only exit 1 as a red run, through the script and through the resolved test command. */
  it('ScopedTestCommand_NodeProject_ReadsExit1AsRed', async () => {
    const withScript = makeTmpDir();
    writeScripts(withScript, { 'test:run': 'vitest run', 'test:files': 'vitest run' });
    const withoutScript = makeTmpDir();
    writeScripts(withoutScript, { 'test:run': 'vitest run' });

    expect(await isolatedSync(() => resolveScopedTestCommand(withScript))).toEqual({ command: 'npm run test:files', testFailureExitCodes: [1] });
    expect(await isolatedSync(() => resolveScopedTestCommand(withoutScript))).toEqual({ command: 'npm run test:run', testFailureExitCodes: [1] });
  });

  /** `cargo test` exits 101 when a test fails, so the detected rust command carries the exit codes of the rust toolchain. */
  it('ScopedTestCommand_RustProject_ReadsExit101AsRed', async () => {
    const dir = makeTmpDir();
    writeFileSync(join(dir, 'Cargo.toml'), '[package]\nname = "fixture"\n');

    expect(await isolatedSync(() => resolveScopedTestCommand(dir))).toEqual({ command: 'cargo test', testFailureExitCodes: [101] });
  });

  /**
   * A configured command is not the command of a known toolchain, so only exit 1 reads as red, also in a Cargo project.
   * The same text as the detected command keeps the exit codes of the detected toolchain.
   */
  it('ScopedTestCommand_ConfiguredCommand_HasNoKnownToolchainUnlessItIsTheDetectedCommand', async () => {
    const other = makeTmpDir();
    writeFileSync(join(other, 'Cargo.toml'), '[package]\nname = "fixture"\n');
    writeFileSync(join(other, '.exarchos.yml'), 'test: cargo nextest run\n');
    const same = makeTmpDir();
    writeFileSync(join(same, 'Cargo.toml'), '[package]\nname = "fixture"\n');
    writeFileSync(join(same, '.exarchos.yml'), 'test: cargo test\n');

    expect(await isolatedSync(() => resolveScopedTestCommand(other))).toEqual({ command: 'cargo nextest run', testFailureExitCodes: [1] });
    expect(await isolatedSync(() => resolveScopedTestCommand(same))).toEqual({ command: 'cargo test', testFailureExitCodes: [101] });
  });

  /** A user toolchain of `.exarchos.yml` has no key for the exit codes, so its own command reads only exit 1 as red. */
  it('ScopedTestCommand_UserToolchain_ReadsExit1AsRed', async () => {
    const dir = makeTmpDir();
    writeFileSync(join(dir, 'Cargo.toml'), '[package]\nname = "fixture"\n');
    writeFileSync(
      join(dir, '.exarchos.yml'),
      'toolchains:\n  - id: rust-workspace\n    markers: [Cargo.toml]\n    commands:\n      test: cargo test --workspace\n',
    );

    expect(await isolatedSync(() => resolveScopedTestCommand(dir))).toEqual({ command: 'cargo test --workspace', testFailureExitCodes: [1] });
  });

  it('ScopedTestCommand_MalformedPackageJson_IsNull', async () => {
    const dir = makeTmpDir();
    writeFileSync(join(dir, 'package.json'), '{ "scripts": { "test:files": ');

    expect(await isolatedSync(() => resolveScopedTestCommand(dir))).toBeNull();
  });

  /**
   * The scoped command is not a field of the resolved runtime. The runtime, its source and its three
   * `command.resolved` events stay the same when the script exists.
   */
  it('ScopedTestCommand_TheScript_ChangesNoRuntimeFieldSourceOrEvent', async () => {
    const dir = makeTmpDir();
    writeScripts(dir, { 'test:run': 'vitest run', 'test:files': 'vitest run', typecheck: 'tsc --noEmit' });
    const append = vi.fn();

    const result = await isolatedSync(() => resolveTestRuntime(dir, { eventStore: { append }, stream: 'feat-scoped' }));

    expect(result).toEqual({
      test: 'npm run test:run',
      typecheck: 'npm run typecheck',
      install: 'npm install',
      source: 'detection',
    });
    expect(append.mock.calls.map((c) => (c[1] as { data: { field: string; command: string } }).data)).toEqual([
      expect.objectContaining({ field: 'test', command: 'npm run test:run' }),
      expect.objectContaining({ field: 'typecheck', command: 'npm run typecheck' }),
      expect.objectContaining({ field: 'install', command: 'npm install' }),
    ]);
  });

  /** This repository runs `test:run` on the `unit` project only, so the probe needs the script to reach `tests/unit`. */
  it('ScopedTestCommand_ThisRepository_IsTheTestFilesScript', async () => {
    expect(await isolatedSync(() => resolveScopedTestCommand(REPO_ROOT))).toEqual({ command: 'npm run test:files', testFailureExitCodes: [1] });
    expect((await isolatedSync(() => resolveTestRuntime(REPO_ROOT))).test).toBe('npm run test:run');
    expect((await isolatedSync(() => resolveTestRuntime(REPO_ROOT))).source).toBe('detection');
  });
});
