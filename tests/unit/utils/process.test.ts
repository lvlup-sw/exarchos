import { describe, it, expect } from 'vitest';
import { EventEmitter, once } from 'node:events';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import {
  isWindowsBatchFile,
  needsWindowsShell,
  runCommandSync,
  windowsBatchLaunch,
  spawnCommand,
  spawnCommandSync,
  type ChildSpawn,
} from '../../../src/utils/process.js';
import { isolatedSync } from '../../../tools/test-helpers/spawn.js';
import { rmrf } from '../../../tools/test-helpers/temp-dir.js';

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

/**
 * A resolved `.cmd` or `.bat` file, such as a shim in `node_modules/.bin`, cannot launch through `execFile` on
 * win32 since CVE-2024-27980. `runCommandSync` runs it through `cmd.exe` with each token escaped.
 */
describe('runCommandSync with a win32 batch file', () => {
  it('IsWindowsBatchFile_CmdOrBatPathOnWin32_True', () => {
    expect(isWindowsBatchFile('C:\\repo\\node_modules\\.bin\\depcruise.cmd', 'win32')).toBe(true);
    expect(isWindowsBatchFile('C:\\tools\\build.BAT', 'win32')).toBe(true);
    expect(isWindowsBatchFile('npm.cmd', 'win32')).toBe(true);
  });

  it('IsWindowsBatchFile_OtherCommandOrPosix_False', () => {
    expect(isWindowsBatchFile('npm', 'win32')).toBe(false);
    expect(isWindowsBatchFile('C:\\tools\\git.exe', 'win32')).toBe(false);
    expect(isWindowsBatchFile('/repo/node_modules/.bin/depcruise', 'linux')).toBe(false);
    expect(isWindowsBatchFile('/repo/build.cmd', 'linux')).toBe(false);
  });

  /**
   * The launch is `cmd.exe /d /c` with one body. The path keeps each space and metacharacter as one token with a caret.
   * It gets no quotes, because cmd.exe does not group a path with escaped quotes. An argument is quoted and escaped.
   */
  it('WindowsBatchLaunch_EscapesEachTokenIntoOneCmdBody', () => {
    const launch = windowsBatchLaunch('C:\\my repo (x86)\\node_modules\\.bin\\depcruise.cmd', ['--validate', 'a&b', 'two words']);

    expect(launch.file.toLowerCase()).toContain('cmd');
    expect(launch.args.slice(0, 2)).toEqual(['/d', '/c']);
    expect(launch.args[2]).toBe(
      'C:\\my^ repo^ ^(x86^)\\node_modules\\.bin\\depcruise.cmd --validate a^&b ^"two words^"',
    );
  });

  /**
   * On a win32 host, a real batch file runs through `runCommandSync` and gives its stdout and its arguments.
   * The file is in a directory with a space and parentheses, as a shim under a user profile with a space is.
   */
  it.runIf(process.platform === 'win32')('RunCommandSync_BatchFileOnWin32_RunsThroughCmd', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'batch file (x86)-'));
    try {
      const batch = path.join(dir, 'echo-args.cmd');
      fs.writeFileSync(batch, '@echo off\r\necho got %~1 %~2\r\n', 'utf-8');

      const out = String(await isolatedSync(() => runCommandSync(batch, ['one', 'two words'], { encoding: 'utf-8' })));

      expect(out.trim()).toBe('got one two words');
    } finally {
      rmrf(dir);
    }
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
