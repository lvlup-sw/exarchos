// ─── detectTestCommands Characterization Tests ──────────────────────────────
//
// Per Michael Feathers, "Working Effectively with Legacy Code": these tests
// pin the CURRENT behavior of detectTestCommands so the upcoming refactor
// (#1199, test-runtime-resolver consolidation) can be verified to be a true
// no-op at this seam. They MUST stay green throughout the refactor.
//
// Do not "fix" anything observed here — these are a regression backstop.
// ────────────────────────────────────────────────────────────────────────────

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { detectTestCommands } from './detect-test-commands.js';

describe('detectTestCommands (characterization)', () => {
  const tmpDirs: string[] = [];

  function makeTmpDir(): string {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'detect-test-cmds-char-'));
    tmpDirs.push(dir);
    return dir;
  }

  afterEach(() => {
    for (const dir of tmpDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
    tmpDirs.length = 0;
  });

  it('detect_NodeProject_ReturnsNpmRunTestRun', () => {
    const dir = makeTmpDir();
    writeFileSync(path.join(dir, 'package.json'), '{}');

    const result = detectTestCommands(dir);

    expect(result).toEqual({ test: 'npm run test:run', typecheck: 'npm run typecheck' });
  });

  it('detect_PythonProject_ReturnsPytest', () => {
    const dir = makeTmpDir();
    writeFileSync(path.join(dir, 'pyproject.toml'), '[project]');

    const result = detectTestCommands(dir);

    expect(result).toEqual({ test: 'pytest', typecheck: null });
  });

  it('detect_RustProject_ReturnsCargoTest', () => {
    const dir = makeTmpDir();
    writeFileSync(path.join(dir, 'Cargo.toml'), '[package]');

    const result = detectTestCommands(dir);

    expect(result).toEqual({ test: 'cargo test', typecheck: null });
  });

  it('detect_DotNetProject_ReturnsDotnetTest', () => {
    const dir = makeTmpDir();
    writeFileSync(path.join(dir, 'Foo.csproj'), '<Project/>');

    const result = detectTestCommands(dir);

    expect(result).toEqual({ test: 'dotnet test', typecheck: null });
  });

  it('detect_NoMarkers_ReturnsNullCommands', () => {
    const dir = makeTmpDir();

    const result = detectTestCommands(dir);

    expect(result).toEqual({ test: null, typecheck: null });
  });

  it('detect_OverrideProvided_ReturnsOverride', () => {
    const dir = makeTmpDir();
    // Markers present should not matter — override wins.
    writeFileSync(path.join(dir, 'package.json'), '{}');

    const result = detectTestCommands(dir, 'npm run test:custom');

    expect(result).toEqual({ test: 'npm run test:custom', typecheck: null });
  });

  it('detect_OverrideWithUnsafeChars_Throws', () => {
    const dir = makeTmpDir();

    // Each disallowed shell metacharacter must trigger the allowlist guard.
    const unsafeOverrides = [
      'npm test; rm -rf /',     // ;
      'npm test | grep foo',    // |
      'npm test && evil',       // &
      'npm test$VAR',           // $
      'npm test`whoami`',       // backtick
      'npm test (foo)',         // ( and )
      'npm test {foo}',         // { and }
      'npm test !foo',          // !
      'npm test <input',        // <
      'npm test >output',       // >
    ];

    for (const override of unsafeOverrides) {
      expect(() => detectTestCommands(dir, override)).toThrow(/Invalid testCommand/);
    }
  });
});
