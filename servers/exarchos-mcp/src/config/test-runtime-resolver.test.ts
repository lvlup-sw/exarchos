// ─── Test Runtime Resolver Tests ────────────────────────────────────────────

import { describe, it, expect, afterEach, vi } from 'vitest';
import fc from 'fast-check';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  resolveTestRuntime,
  resolveVerificationRuntime,
} from './test-runtime-resolver.js';
import { loadExarchosConfig } from './load-exarchos-config.js';
import { ExarchosConfigSchema } from './exarchos-config-schema.js';
import { FullExarchosConfigSchema } from './yaml-schema.js';

describe('resolveTestRuntime', () => {
  const tmpDirs: string[] = [];

  function makeTmpDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'resolver-'));
    tmpDirs.push(dir);
    return dir;
  }

  afterEach(() => {
    for (const dir of tmpDirs) {
      rmSync(dir, { recursive: true, force: true });
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

  it('resolveTestRuntime_BunProjectWithTestRunScript_HonorsTestRunViaBunRun', () => {
    // A vitest-on-bun repo (like servers/exarchos-mcp): a bun lockfile plus an
    // explicit `test:run` script. The resolver must run the committed script
    // via `bun run test:run` rather than shelling into Bun's native runner over
    // the vitest suite — otherwise the two supported workspaces diverge onto
    // different runners. `typecheck` honors its script the same way.
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

  it('resolveTestRuntime_BunProjectWithTestRunButNoTypecheck_FallsBackToTsc', () => {
    // Honoring `test:run` must not conjure a `typecheck` script that isn't
    // there — typecheck still falls back to a bare `tsc --noEmit`.
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

  it('resolveTestRuntime_YarnClassicProject_UsesFrozenLockfile', () => {
    // No Berry signals (.yarnrc.yml, .yarn/releases/, packageManager) → Classic.
    // `--immutable` is Berry-only; Classic projects must get `--frozen-lockfile`.
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

  // ─── T06: Script-existence checks (closes #1174 mechanism) ────────────────

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
    // Remediation must mention either .exarchos.yml or the missing script name.
    expect(
      result.remediation!.includes('.exarchos.yml') || result.remediation!.includes('test:run'),
    ).toBe(true);
    // install command stays populated so callers can still install deps.
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

  // ─── T13: Config precedence (override > config > detection) ──────────────

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
    // typecheck/install fall through to detection, populated not null
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

  it('resolveTestRuntime_DetectionUnresolved_PreservesConfigInstallAndTypecheck', () => {
    // #1199 shepherd fix: when detection produces an `unresolvedReason`
    // (e.g., npm package without a `test:run` script) but config supplied
    // typecheck/install, those values must be honored — not overwritten by
    // the detection-only result. Per documented precedence override > config
    // > detection, a still-usable install command should not be silently
    // dropped just because the test command can't be determined.
    const dir = makeTmpDir();
    writeFileSync(
      join(dir, 'package.json'),
      // No `test:run` script → npm path triggers unresolvedReason.
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
    // Config-supplied install/typecheck survive the unresolved-test path.
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

  // ─── T16 (#1199): command.resolved event emission ─────────────────────────

  it('resolveTestRuntime_NoEventStore_NoEmissions', () => {
    const dir = makeTmpDir();
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({ scripts: { 'test:run': 'vitest run' } }),
    );

    // No eventStore option — must succeed without emission and without error.
    const result = resolveTestRuntime(dir);
    expect(result.source).toBe('detection');
    // Sanity: no spy, nothing to assert on. The fact that this returns is the assertion.
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

  it('resolveTestRuntime_WithEventStoreConfig_EmitsConfigSource', () => {
    const dir = makeTmpDir();
    // No package.json or other markers — detection produces nothing.
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
    // Empty dir, no config -> unresolved.
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

  it('resolveTestRuntime_DotNetDetection_PartialFieldsEmitUnresolvedWithRemediation', async () => {
    // #1199 shepherd cycle 2 (sentry MEDIUM): for projects whose detection
    // produces only a `test` command (.NET, Rust, Python), the per-field
    // events for `typecheck` and `install` MUST satisfy the discriminated
    // schema's invariant `source: 'unresolved' ⇒ non-empty remediation`.
    // Previously these events shipped without a remediation field, which the
    // schema (post-CR5 hardening) rejects at write time.
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
      // Field-specific remediation, not the project-wide one.
      expect(evt?.data.remediation).toContain(field);
    }

    // Schema validation — the new discriminated union must accept all three
    // events.
    const { CommandResolvedEventSchema } = await import('../event-store/schemas.js');
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

  // ─── T-17 (DR-8a): remediation copy must teach next step ───────────────
  // Empty repos and missing-script repos surface `source: 'unresolved'`
  // with a `remediation` string. That string is the *only* breadcrumb a
  // dispatched agent gets — it must include either an inline example
  // showing what to write or a link to the user-facing docs explaining
  // .exarchos.yml. A bare "configure your project" message is not enough.
  it('testRuntimeResolver_RemediationMessage_IncludesDocLinkOrExample', () => {
    const dir = makeTmpDir();

    const result = resolveTestRuntime(dir);

    expect(result.source).toBe('unresolved');
    expect(result.remediation).toBeDefined();
    const message = result.remediation!;
    // A concrete, actionable hint: either a YAML snippet a caller could
    // paste, or a doc anchor the caller can follow. We accept either form
    // so future docs reorganization doesn't constrain the message.
    const hasInlineYamlExample = /test:\s/.test(message);
    const hasDocLink = /https?:\/\/|skills-src\/|docs\//.test(message);
    expect(
      hasInlineYamlExample || hasDocLink,
      `remediation must include an inline YAML example (a "test:" key) or a doc link, got: ${message}`,
    ).toBe(true);
  });

  // ── Layered resolver tiers 3 (user toolchains) + 4 (task runners) ─────────
  describe('layered tiers', () => {
    it('tier3_UserToolchain_OverridesBuiltinDetection', () => {
      const dir = makeTmpDir();
      writeFileSync(join(dir, 'package.json'), '{}'); // built-in would say node
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

    it('tier4_TaskRunner_BeatsBuiltinDetection', () => {
      const dir = makeTmpDir();
      writeFileSync(join(dir, 'Cargo.toml'), '[package]'); // built-in → cargo test
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

    it('tier4_TaskRunner_BeatsNodeWithWorkingTestScript', () => {
      // A committed task runner is a deliberate project interface, so it wins
      // over a node repo's own test:run script (intended behavior, M5).
      const dir = makeTmpDir();
      writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts: { 'test:run': 'vitest run' } }));
      writeFileSync(join(dir, 'justfile'), 'test:\n\techo hi\n');
      const result = resolveTestRuntime(dir);
      expect(result.test).toBe('just test');
      expect(result.source).toBe('task-runner');
    });

    it('nodeInstallMetadataFallback_NoLockfile_ResolvesPm', () => {
      // No lockfile, but installed-state markers identify the PM (vendored
      // INSTALL_METADATA fallback, M3).
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

// ─── task 017: resolveVerificationRuntime (widened field set) ────────────────

describe('resolveVerificationRuntime', () => {
  const tmpDirs: string[] = [];

  function makeTmpDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'verif-'));
    tmpDirs.push(dir);
    return dir;
  }

  afterEach(() => {
    for (const dir of tmpDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
    tmpDirs.length = 0;
  });

  it('ResolveVerificationRuntime_MutationField_HonorsLayeredPrecedence', () => {
    // tier 5 (detection): a Rust repo seeds `cargo mutants --in-diff`.
    const rust = makeTmpDir();
    writeFileSync(join(rust, 'Cargo.toml'), '[package]');
    expect(resolveVerificationRuntime(rust).mutation).toBe('cargo mutants --in-diff');

    // tier 3 (user toolchain) beats built-in detection.
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

    // tier 2 (config direct) beats user toolchain.
    const cfg = makeTmpDir();
    writeFileSync(join(cfg, 'Cargo.toml'), '[package]');
    const tc2 = resolveVerificationRuntime(cfg, {
      loadConfig: () => ({ config: { mutation: 'config-mutation' }, source: '/x/.exarchos.yml' }),
    });
    expect(tc2.mutation).toBe('config-mutation');

    // tier 1 (override) beats everything.
    const ovr = makeTmpDir();
    writeFileSync(join(ovr, 'Cargo.toml'), '[package]');
    const tc1 = resolveVerificationRuntime(ovr, {
      override: { mutation: 'override-mutation' },
      loadConfig: () => ({ config: { mutation: 'config-mutation' }, source: '/x/.exarchos.yml' }),
    });
    expect(tc1.mutation).toBe('override-mutation');
  });

  it('ResolveVerificationRuntime_LintField_HonorsLayeredPrecedence', () => {
    // tier 5: Go seeds `go vet ./...`.
    const go = makeTmpDir();
    writeFileSync(join(go, 'go.mod'), 'module example.com/x\n');
    expect(resolveVerificationRuntime(go).lint).toBe('go vet ./...');

    // tier 2 (config direct) beats detection.
    const cfg = makeTmpDir();
    writeFileSync(join(cfg, 'go.mod'), 'module example.com/x\n');
    expect(
      resolveVerificationRuntime(cfg, {
        loadConfig: () => ({ config: { lint: 'golangci-lint run' }, source: '/x/.exarchos.yml' }),
      }).lint,
    ).toBe('golangci-lint run');

    // tier 1 (override) wins.
    const ovr = makeTmpDir();
    writeFileSync(join(ovr, 'go.mod'), 'module example.com/x\n');
    expect(
      resolveVerificationRuntime(ovr, {
        override: { lint: 'override-lint' },
        loadConfig: () => ({ config: { lint: 'golangci-lint run' }, source: '/x/.exarchos.yml' }),
      }).lint,
    ).toBe('override-lint');
  });

  it('ResolveVerificationRuntime_ContractField_ResolvesStructured', () => {
    const dir = makeTmpDir();
    // config-direct structured contract: { codegen, diff }.
    const result = resolveVerificationRuntime(dir, {
      loadConfig: () => ({
        config: { contract: { codegen: 'buf generate', diff: 'buf breaking' } },
        source: '/x/.exarchos.yml',
      }),
    });
    expect(result.contract).toEqual({ codegen: 'buf generate', diff: 'buf breaking' });

    // override wins, structured.
    const ovr = makeTmpDir();
    const overridden = resolveVerificationRuntime(ovr, {
      override: { contract: { codegen: 'override-codegen', diff: 'override-diff' } },
      loadConfig: () => ({
        config: { contract: { codegen: 'buf generate', diff: 'buf breaking' } },
        source: '/x/.exarchos.yml',
      }),
    });
    expect(overridden.contract).toEqual({ codegen: 'override-codegen', diff: 'override-diff' });

    // No contract tool anywhere → null (artifact-keyed seeds attach elsewhere).
    const none = makeTmpDir();
    writeFileSync(join(none, 'Cargo.toml'), '[package]');
    expect(resolveVerificationRuntime(none).contract).toBeNull();
  });

  it('ResolveTestRuntime_Alias_BehaviorUnchanged', () => {
    // The alias projects the widened runtime down to the exact legacy shape:
    // { test, typecheck, install, source, remediation? } — no widened fields.
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
    // The alias result MUST NOT leak widened fields onto the legacy shape.
    expect('mutation' in legacy).toBe(false);
    expect('lint' in legacy).toBe(false);
    expect('contract' in legacy).toBe(false);

    // Unresolved path: alias still carries remediation.
    const empty = makeTmpDir();
    const un = resolveTestRuntime(empty);
    expect(un.source).toBe('unresolved');
    expect(un.remediation).toBeDefined();
  });

  // fast-check property: per-field independence + first-non-null-layer-wins.
  it('property_PerFieldIndependence_AndFirstNonNullLayerWins', () => {
    const cmd = fc.constantFrom('alpha', 'beta', 'gamma', 'delta');
    const field = fc.constantFrom('test', 'typecheck', 'install', 'mutation', 'lint');
    fc.assert(
      fc.property(
        // an override value for ONE field, and a config value for a DIFFERENT field
        field,
        cmd,
        field,
        cmd,
        (overrideField, overrideVal, configField, configVal) => {
          const dir = makeTmpDir();
          writeFileSync(join(dir, 'Cargo.toml'), '[package]'); // detection baseline
          const result = resolveVerificationRuntime(dir, {
            override: { [overrideField]: overrideVal },
            loadConfig: () => ({ config: { [configField]: configVal }, source: '/x/.exarchos.yml' }),
          });
          // The override field always wins on its own field (first non-null layer).
          const r = result as unknown as Record<string, string | null>;
          expect(r[overrideField]).toBe(overrideVal);
          // Per-field independence: a different config field is NOT clobbered by
          // the override on overrideField. (When configField === overrideField,
          // override still wins — also asserted by the first check.)
          if (configField !== overrideField) {
            expect(r[configField]).toBe(configVal);
          }
        },
      ),
      { numRuns: 60 },
    );
  });
});

// ─── task 001: verification: is a foreign key on the toolchain path ──────────
//
// The toolchain loader (`loadExarchosConfig` → readAndValidate) validates the
// SAME `.exarchos.yml` via `FullExarchosConfigSchema = ExarchosConfigSchema
// .merge(ProjectConfigSchema).strict()`. Project-concern keys (`review:` /
// `agents:` / now `verification:`) live in `ProjectConfigSchema`, so they ride
// through the merged schema on the toolchain path while the bare,
// toolchain-only `ExarchosConfigSchema` (the resolver's own view) rejects them
// all equally. These tests pin that `verification:` is tolerated on the
// toolchain path by the SAME mechanism that already tolerates `review:`.

describe('ExarchosConfigSchema verification-key tolerance', () => {
  it('ExarchosConfigSchema_ForeignVerificationKey_ToleratedOnToolchainPath', () => {
    // A config carrying toolchain keys AND a `verification:` block must parse on
    // the toolchain-loader path (FullExarchosConfigSchema) exactly as a
    // `review:` sibling does today — the project-concern key is tolerated, not
    // rejected.
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

    // Same verdict for both sibling project-concern keys: accepted.
    expect(verifResult.success).toBe(true);
    expect(reviewResult.success).toBe(true);
    expect(verifResult.success).toBe(reviewResult.success);

    // The toolchain key survives alongside the tolerated project-concern key.
    if (verifResult.success) {
      expect(verifResult.data.test).toBe('bun test');
      expect(verifResult.data.verification?.policy?.low).toEqual(['check_static_analysis']);
    }

    // The bare toolchain-only schema (the resolver's own view) treats
    // `verification:` and `review:` IDENTICALLY — both are foreign to it, so
    // both are rejected by the SAME `.strict()` mechanism. (This is why the
    // loader uses the merged schema, not the bare one.)
    expect(ExarchosConfigSchema.safeParse(withVerification).success).toBe(false);
    expect(ExarchosConfigSchema.safeParse(withReview).success).toBe(false);
  });
});

describe('supported-workspace test-runtime consistency (WFQ-015 / exit-proof c)', () => {
  const tmpDirs: string[] = [];
  function makeTmpDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'ws-consistency-'));
    tmpDirs.push(dir);
    return dir;
  }
  afterEach(() => {
    for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
    tmpDirs.length = 0;
  });

  // Both supported workspaces commit a `test:run` vitest script; they differ
  // only in package manager (repo root → npm lockfile, servers/exarchos-mcp →
  // bun lockfile). The resolver must land BOTH on their committed `test:run`
  // script so they run the SAME suite under the SAME timeout policy, rather
  // than the bun workspace silently falling through to `bun test` (Bun's
  // native runner over vitest files). This is the toolchain-truth exit proof.
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

    // Same intended target: each runs the committed `test:run` script.
    expect(rootResult.test).toBe('npm run test:run');
    expect(mcpResult.test).toBe('bun run test:run');
    expect(rootResult.test?.endsWith('run test:run')).toBe(true);
    expect(mcpResult.test?.endsWith('run test:run')).toBe(true);

    // Neither falls through to a native package-manager test runner.
    expect(mcpResult.test).not.toBe('bun test');
    expect(rootResult.test).not.toBe('npm test');

    // Both resolve via detection (built-in registry tier), not unresolved.
    expect(rootResult.source).toBe('detection');
    expect(mcpResult.source).toBe('detection');
  });
});

describe('top-level mutation config shape (WFQ-013 / DOC-5)', () => {
  const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../');
  const tmpDirs: string[] = [];
  function makeTmpDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'doc5-'));
    tmpDirs.push(dir);
    return dir;
  }
  afterEach(() => {
    for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
    tmpDirs.length = 0;
  });

  it('committed root .exarchos.yml loads clean and exposes a top-level `mutation`', () => {
    // WFQ-013/DOC-5: `mutation` is a valid TOP-LEVEL key. The committed root
    // config declares it, so loading must not throw (a stale strict schema
    // would reject the unknown key) and the value must survive to
    // `config.mutation` — the exact shape the documentation now advertises.
    const result = loadExarchosConfig(REPO_ROOT);
    expect(result).not.toBeNull();
    expect(result!.config.mutation).toBe('node servers/exarchos-mcp/scripts/stryker-adapter.mjs');
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
