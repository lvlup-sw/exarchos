// ─── Detect Test Commands Tests ─────────────────────────────────────────────

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { detectTestCommands } from './detect-test-commands.js';

describe('detectTestCommands', () => {
  const tmpDirs: string[] = [];

  async function makeTmpDir(): Promise<string> {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'detect-test-cmds-'));
    tmpDirs.push(dir);
    return dir;
  }

  afterEach(async () => {
    for (const dir of tmpDirs) {
      await rm(dir, { recursive: true, force: true });
    }
    tmpDirs.length = 0;
  });

  it('DetectTestCommands_PackageJson_ReturnsNpmCommands', async () => {
    const dir = await makeTmpDir();
    await writeFile(path.join(dir, 'package.json'), '{}');

    const result = detectTestCommands(dir);

    expect(result).toEqual({ test: 'npm run test:run', typecheck: 'npm run typecheck' });
  });

  it('DetectTestCommands_Csproj_ReturnsDotnetTest', async () => {
    const dir = await makeTmpDir();
    await writeFile(path.join(dir, 'Foo.csproj'), '<Project/>');

    const result = detectTestCommands(dir);

    expect(result).toEqual({ test: 'dotnet test', typecheck: null });
  });

  it('DetectTestCommands_CargoToml_ReturnsCargoTest', async () => {
    const dir = await makeTmpDir();
    await writeFile(path.join(dir, 'Cargo.toml'), '[package]');

    const result = detectTestCommands(dir);

    expect(result).toEqual({ test: 'cargo test', typecheck: null });
  });

  it('DetectTestCommands_PyprojectToml_ReturnsPytest', async () => {
    const dir = await makeTmpDir();
    await writeFile(path.join(dir, 'pyproject.toml'), '[project]');

    const result = detectTestCommands(dir);

    expect(result).toEqual({ test: 'pytest', typecheck: null });
  });

  it('DetectTestCommands_NoMarkerFile_ReturnsNull', async () => {
    const dir = await makeTmpDir();

    const result = detectTestCommands(dir);

    expect(result).toEqual({ test: null, typecheck: null });
  });

  it('DetectTestCommands_Override_ReturnsOverride', async () => {
    const dir = await makeTmpDir();
    await writeFile(path.join(dir, 'package.json'), '{}');

    const result = detectTestCommands(dir, 'dotnet test');

    expect(result).toEqual({ test: 'dotnet test', typecheck: null });
  });

  it('DetectTestCommands_MultipleMarkers_PrefersPriorityOrder', async () => {
    const dir = await makeTmpDir();
    await writeFile(path.join(dir, 'package.json'), '{}');
    await writeFile(path.join(dir, 'Cargo.toml'), '[package]');

    const result = detectTestCommands(dir);

    expect(result).toEqual({ test: 'npm run test:run', typecheck: 'npm run typecheck' });
  });

  it('DetectTestCommands_Override_RejectsUnsafeChars', async () => {
    const dir = await makeTmpDir();

    expect(() => detectTestCommands(dir, 'npm test; rm -rf /')).toThrow('Invalid testCommand');
    expect(() => detectTestCommands(dir, 'test && evil')).toThrow('Invalid testCommand');
    expect(() => detectTestCommands(dir, 'test | grep')).toThrow('Invalid testCommand');
    expect(() => detectTestCommands(dir, 'test$(whoami)')).toThrow('Invalid testCommand');
  });
});
