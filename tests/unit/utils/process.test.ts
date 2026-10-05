import { describe, it, expect } from 'vitest';
import { EventEmitter, once } from 'node:events';
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import {
  needsWindowsShell,
  runCommandSync,
  spawnCommand,
  spawnCommandSync,
  type ChildSpawn,
} from '../../../src/utils/process.js';
import { isolatedSync } from '../../../tools/test-helpers/spawn.js';

/** A {@link ChildSpawn} double that records each launch and returns an idle child. */
function recordingSpawn(): {
  readonly calls: Array<{ command: string; args: readonly string[]; options: SpawnOptions }>;
  readonly spawn: ChildSpawn;
} {
  const calls: Array<{ command: string; args: readonly string[]; options: SpawnOptions }> = [];
  const spawn: ChildSpawn = (command, args, options) => {
    calls.push({ command, args, options });
    return new EventEmitter() as unknown as ChildProcess;
  };
  return { calls, spawn };
}

describe('needsWindowsShell (#1623)', () => {
  it('NeedsWindowsShell_BarePackageManagerOnWin32_True', () => {
    for (const pm of ['npm', 'npx', 'pnpm', 'yarn', 'corepack', 'bun', 'bunx']) {
      expect(needsWindowsShell(pm, 'win32')).toBe(true);
    }
  });

  /**
   * `resolveIntegrationCommand` can return each of these script runners as a bare command.
   * If `needsWindowsShell` returns false for one of them, the integration gate cannot launch it on Windows.
   */
  it('NeedsWindowsShell_ScriptRunnersAgreeWithTheIntegrationGate', () => {
    for (const runner of ['npm', 'pnpm', 'yarn', 'bun']) {
      expect(needsWindowsShell(runner, 'win32'), `${runner} must launch via shell on win32`).toBe(true);
    }
  });

  it('NeedsWindowsShell_BarePackageManagerOnPosix_False', () => {
    expect(needsWindowsShell('npm', 'linux')).toBe(false);
    expect(needsWindowsShell('npx', 'darwin')).toBe(false);
  });

  it('NeedsWindowsShell_NativeBinaryOnWin32_False', () => {
    expect(needsWindowsShell('git', 'win32')).toBe(false);
    expect(needsWindowsShell('cargo', 'win32')).toBe(false);
  });

  it('NeedsWindowsShell_PathOrExtension_False', () => {
    expect(needsWindowsShell('npm.cmd', 'win32')).toBe(false);
    expect(needsWindowsShell('./node_modules/.bin/vitest', 'win32')).toBe(false);
    expect(needsWindowsShell('C:\\tools\\npm', 'win32')).toBe(false);
  });
});

describe('runCommandSync (#1623)', () => {
  /** `node` is not a shim, so this test takes the path with no shell on every host. */
  it('RunCommandSync_NativeCommand_PassesThroughAndReturnsStdout', async () => {
    const out = String(await isolatedSync(() => runCommandSync('node', ['--version'], { encoding: 'utf-8' })));
    expect(out).toMatch(/^v\d+\./);
  });

  it('RunCommandSync_NonZeroExit_Throws', async () => {
    await expect(isolatedSync(() => runCommandSync('node', ['-e', 'process.exit(3)']))).rejects.toThrow();
  });
});

describe('spawnCommandSync (#1623)', () => {
  /** `node` is not a shim, so this test takes the path with no shell on every host. */
  it('SpawnCommandSync_NativeCommand_ReturnsStdoutAndZeroStatus', async () => {
    const r = await isolatedSync(() => spawnCommandSync('node', ['--version'], { encoding: 'utf-8' }));
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/^v\d+\./);
  });

  it('SpawnCommandSync_NonZeroExit_CapturesStatusWithoutThrowing', async () => {
    const r = await isolatedSync(() => spawnCommandSync('node', ['-e', 'process.exit(3)'], { encoding: 'utf-8' }));
    expect(r.status).toBe(3);
  });
});

describe('spawnCommand', () => {
  it('SpawnCommand_BareShimOnWin32_LaunchesThroughTheShellWithQuotedArgs', () => {
    const recorder = recordingSpawn();
    spawnCommand('npx', ['--yes', 'a b'], { stdio: 'pipe' }, { platform: 'win32', spawn: recorder.spawn });
    expect(recorder.calls).toEqual([
      { command: 'npx', args: ['--yes', '"a b"'], options: { stdio: 'pipe', shell: true } },
    ]);
  });

  it('SpawnCommand_NativeCommandOnWin32_LaunchesWithNoShell', () => {
    const recorder = recordingSpawn();
    spawnCommand('git', ['log', 'a b'], {}, { platform: 'win32', spawn: recorder.spawn });
    expect(recorder.calls).toEqual([{ command: 'git', args: ['log', 'a b'], options: {} }]);
  });

  it('SpawnCommand_ShimOnPosix_LaunchesWithNoShell', () => {
    const recorder = recordingSpawn();
    spawnCommand('npx', ['--yes', 'a b'], {}, { platform: 'linux', spawn: recorder.spawn });
    expect(recorder.calls).toEqual([{ command: 'npx', args: ['--yes', 'a b'], options: {} }]);
  });

  it('SpawnCommand_DefaultSpawn_RunsTheChildAndReportsItsExitCode', async () => {
    const child = spawnCommand(process.execPath, ['-e', 'process.exit(3)'], { stdio: 'ignore' });
    const [code] = await once(child, 'close');
    expect(code).toBe(3);
  });
});
