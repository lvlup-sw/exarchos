// ─── Test Runtime Resolver Tests ────────────────────────────────────────────

import { describe, it, expect, afterEach } from 'vitest';
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
    writeFileSync(join(dir, 'package.json'), '{}');

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
    writeFileSync(join(dir, 'package.json'), '{}');

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
    writeFileSync(join(dir, 'package.json'), '{}');
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
    writeFileSync(join(dir, 'package.json'), '{}');
    writeFileSync(join(dir, 'pnpm-lock.yaml'), '');

    const result = resolveTestRuntime(dir);

    expect(result).toEqual({
      test: 'pnpm test',
      typecheck: 'tsc --noEmit',
      install: 'pnpm install --frozen-lockfile',
      source: 'detection',
    });
  });

  it('resolveTestRuntime_YarnProject_DetectsYarnLockfile', () => {
    const dir = makeTmpDir();
    writeFileSync(join(dir, 'package.json'), '{}');
    writeFileSync(join(dir, 'yarn.lock'), '');

    const result = resolveTestRuntime(dir);

    expect(result).toEqual({
      test: 'yarn test',
      typecheck: 'tsc --noEmit',
      install: 'yarn install --immutable',
      source: 'detection',
    });
  });

  it('resolveTestRuntime_NpmProject_NoAltLockfile_ReturnsNpmCommands', () => {
    const dir = makeTmpDir();
    writeFileSync(join(dir, 'package.json'), '{}');
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
    writeFileSync(join(dir, 'package.json'), '{}');
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
});
