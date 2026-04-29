// ─── Test Runtime Resolver Tests ────────────────────────────────────────────

import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { resolveTestRuntime } from './test-runtime-resolver.js';

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
});
