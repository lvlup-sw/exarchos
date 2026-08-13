import { describe, it, expect } from 'vitest';
import { needsWindowsShell, runCommandSync, spawnCommandSync } from '../../../src/utils/process.js';

describe('needsWindowsShell (#1623)', () => {
  it('NeedsWindowsShell_BarePackageManagerOnWin32_True', () => {
    for (const pm of ['npm', 'npx', 'pnpm', 'yarn', 'corepack', 'bun', 'bunx']) {
      expect(needsWindowsShell(pm, 'win32')).toBe(true);
    }
  });

  it('NeedsWindowsShell_ScriptRunnersAgreeWithTheIntegrationGate', () => {
    // `resolveIntegrationCommand` classifies these as script runners, so each
    // one can be spawned as a bare command by `check_integration_suite`. Any
    // runner it will spawn must also be recognised as a win32 shim, or the gate
    // fails to launch on Windows for that toolchain.
    for (const runner of ['npm', 'pnpm', 'yarn', 'bun']) {
      expect(needsWindowsShell(runner, 'win32'), `${runner} must launch via shell on win32`).toBe(true);
    }
  });

  it('NeedsWindowsShell_BarePackageManagerOnPosix_False', () => {
    expect(needsWindowsShell('npm', 'linux')).toBe(false);
    expect(needsWindowsShell('npx', 'darwin')).toBe(false);
  });

  it('NeedsWindowsShell_NativeBinaryOnWin32_False', () => {
    // git/cargo are real .exe shims — they launch without a shell.
    expect(needsWindowsShell('git', 'win32')).toBe(false);
    expect(needsWindowsShell('cargo', 'win32')).toBe(false);
  });

  it('NeedsWindowsShell_PathOrExtension_False', () => {
    // Explicit paths / already-extensioned names are launched as given.
    expect(needsWindowsShell('npm.cmd', 'win32')).toBe(false);
    expect(needsWindowsShell('./node_modules/.bin/vitest', 'win32')).toBe(false);
    expect(needsWindowsShell('C:\\tools\\npm', 'win32')).toBe(false);
  });
});

describe('runCommandSync (#1623)', () => {
  it('RunCommandSync_NativeCommand_PassesThroughAndReturnsStdout', () => {
    // On the POSIX CI host this exercises the non-shell pass-through path
    // against a real binary; the win32 shell branch is covered end-to-end by
    // the un-skipped test-adequacy integration test on windows-latest.
    const out = String(runCommandSync('node', ['--version'], { encoding: 'utf-8' }));
    expect(out).toMatch(/^v\d+\./);
  });

  it('RunCommandSync_NonZeroExit_Throws', () => {
    expect(() => runCommandSync('node', ['-e', 'process.exit(3)'])).toThrow();
  });
});

describe('spawnCommandSync (#1623)', () => {
  it('SpawnCommandSync_NativeCommand_ReturnsStdoutAndZeroStatus', () => {
    // POSIX CI host exercises the non-shell pass-through; the win32 `.cmd`-shim
    // branch is covered end-to-end by the post-merge spawn on windows-latest.
    const r = spawnCommandSync('node', ['--version'], { encoding: 'utf-8' });
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/^v\d+\./);
  });

  it('SpawnCommandSync_NonZeroExit_CapturesStatusWithoutThrowing', () => {
    // Unlike runCommandSync, the spawn sibling does NOT throw — it surfaces the
    // exit code so callers (post-merge) can branch on it.
    const r = spawnCommandSync('node', ['-e', 'process.exit(3)'], { encoding: 'utf-8' });
    expect(r.status).toBe(3);
  });
});
