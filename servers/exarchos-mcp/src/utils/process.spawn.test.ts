import { describe, it, expect } from 'vitest';
import { type SpawnOptions } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  isPidAlive,
  resolveSpawnPlan,
  spawnHarnessChild,
  SpawnError,
  type SpawnedChild,
} from './process.js';

/**
 * These are the win32-fragile spawn tests the DR-8 Windows CI lane gates on.
 * They are authored OS-native: the long-lived / metachar cases spawn a real
 * child on the current platform (real backslash/8.3/shim behavior on win32,
 * real `shell:false` on POSIX), and the win32 shim-resolution SHAPE is asserted
 * cross-platform by driving the pure planner / a captured spawn seam with an
 * injected `platform: 'win32'` — so the resolution/no-shell logic is verified on
 * the POSIX host, not mocked away as a POSIX-literal.
 */

/** A minimal in-memory child the capture seam returns, so no real process spawns. */
class FakeChild implements SpawnedChild {
  pid: number | undefined = 4242;
  killedWith: NodeJS.Signals | number | undefined;
  private readonly handlers = new Map<string, ((...a: never[]) => void)[]>();

  on(event: string, listener: (...a: never[]) => void): void {
    const existing = this.handlers.get(event) ?? [];
    existing.push(listener);
    this.handlers.set(event, existing);
  }

  emit(event: string, ...args: unknown[]): void {
    for (const handler of this.handlers.get(event) ?? []) {
      (handler as (...a: unknown[]) => void)(...args);
    }
  }

  kill(signal?: NodeJS.Signals | number): boolean {
    this.killedWith = signal ?? 'SIGTERM';
    return true;
  }
}

interface CapturedCall {
  readonly file: string;
  readonly args: readonly string[];
  readonly options: SpawnOptions;
}

function makeCaptureSpawn() {
  const calls: CapturedCall[] = [];
  let last: FakeChild | undefined;
  const spawnFn = (file: string, args: readonly string[], options: SpawnOptions): SpawnedChild => {
    const child = new FakeChild();
    last = child;
    calls.push({ file, args, options });
    return child;
  };
  return { spawnFn, calls, child: (): FakeChild | undefined => last };
}

describe('spawnHarnessChild — cross-OS async spawn (DR-4 / DR-8)', () => {
  it('AsyncSpawn_HarnessCli_LongLived', async () => {
    // Spawn a long-lived child (idles forever), confirm it is running, then kill
    // it and await the exit terminal.
    const handle = await spawnHarnessChild({
      command: process.execPath,
      args: ['-e', 'setInterval(() => {}, 1e9)'],
      cwd: process.cwd(),
      stdio: 'ignore',
    });

    expect(typeof handle.pid).toBe('number');
    expect(isPidAlive(handle.pid as number)).toBe(true);

    handle.kill();
    const exit = await handle.exit;
    // Terminated by our signal — either a signal terminal (POSIX) or a non-zero
    // code (win32); in all cases the exit promise resolves.
    expect(exit.signal !== null || exit.code !== 0).toBe(true);
  }, 20000);

  it('AsyncSpawn_Win32Shim_ResolvedNoShell', async () => {
    // A `.cmd` global shim is resolved to its real path and launched through
    // cmd.exe with verbatim args — never `shell: true`.
    const planCmd = resolveSpawnPlan(
      { command: 'myharness', args: ['a & b'], cwd: 'C:/wt', env: { FOO: 'bar' } },
      'win32',
      (c) => (c === 'myharness' ? 'C:/shims/myharness.cmd' : null),
    );
    expect(planCmd.ok).toBe(true);
    if (planCmd.ok) {
      const { file, args, options } = planCmd.plan;
      expect(file.toLowerCase()).toContain('cmd'); // ComSpec, not the shim run directly
      expect(options.shell).not.toBe(true); // the CVE-2024-27980 hazard is refused
      expect(options.windowsVerbatimArguments).toBe(true);
      const body = args.join(' ');
      expect(args).toContain('/c');
      expect(body).toContain('myharness.cmd'); // resolved shim path is present
      expect(body).toContain('^&'); // metachar caret-escaped, not shell-interpolated
    }

    // A `.ps1` shim resolves to `powershell.exe -File <resolved>` — again no shell.
    const planPs = resolveSpawnPlan(
      { command: 'myharness', args: ['x'], cwd: 'C:/wt' },
      'win32',
      () => 'C:/shims/myharness.ps1',
    );
    expect(planPs.ok).toBe(true);
    if (planPs.ok) {
      expect(planPs.plan.file.toLowerCase()).toContain('powershell');
      expect(planPs.plan.args).toContain('-File');
      expect(planPs.plan.args).toContain('C:/shims/myharness.ps1');
      expect(planPs.plan.options.shell).not.toBe(true);
    }

    // End-to-end wiring: spawnHarnessChild hands the real spawn NO `shell: true`.
    const capture = makeCaptureSpawn();
    const pending = spawnHarnessChild(
      { command: 'myharness', args: ['a & b'], cwd: 'C:/wt', stdio: 'ignore' },
      {
        platform: 'win32',
        resolveWin32Command: () => 'C:/shims/myharness.cmd',
        spawn: capture.spawnFn,
      },
    );
    capture.child()?.emit('spawn');
    const handle = await pending;
    expect(handle.pid).toBe(4242);
    expect(capture.calls).toHaveLength(1);
    expect(capture.calls[0].file.toLowerCase()).toContain('cmd');
    expect(capture.calls[0].options.shell).not.toBe(true);
    expect(capture.calls[0].options.windowsVerbatimArguments).toBe(true);
  });

  it('AsyncSpawn_MetacharArg_PassedLiterally_NoShellInterpolation', async () => {
    // An arg loaded with shell metacharacters must reach the child verbatim —
    // no shell layer interpolates it. The child writes its received argv[1] to a
    // temp file so we can compare the exact bytes.
    const outFile = path.join(
      os.tmpdir(),
      `exarchos-spawn-metachar-${process.pid}-${Date.now()}.txt`,
    );
    const metachar = 'a & b ; rm -rf / | echo $HOME `whoami` > pwned';
    try {
      const handle = await spawnHarnessChild({
        command: process.execPath,
        args: ['-e', 'require("fs").writeFileSync(process.argv[2], process.argv[1])', metachar, outFile],
        cwd: process.cwd(),
        stdio: 'ignore',
      });
      const exit = await handle.exit;
      expect(exit.code).toBe(0);
      expect(fs.readFileSync(outFile, 'utf-8')).toBe(metachar);
      // And nothing the metacharacters could have triggered actually ran.
      expect(fs.existsSync(path.join(process.cwd(), 'pwned'))).toBe(false);
    } finally {
      if (fs.existsSync(outFile)) fs.rmSync(outFile);
    }
  }, 20000);

  it('AsyncSpawn_PostSettleError_ResolvesExit_NeverHangs', async () => {
    // A child that emits `'error'` AFTER it already `'spawn'`ed (an async I/O
    // failure) may never emit `'exit'`. The supervisor awaits `child.exit`, so a
    // dropped post-settle error would leave that promise pending forever and hang
    // the whole launch (runLifecycle's `await child.exit`). The handle's `exit`
    // must instead resolve with a synthetic terminal (R-6).
    const capture = makeCaptureSpawn();
    const pending = spawnHarnessChild(
      { command: process.execPath, args: ['-e', ''], cwd: process.cwd(), stdio: 'ignore' },
      { platform: 'linux', spawn: capture.spawnFn },
    );
    // The child spawns successfully → the handle resolves.
    capture.child()?.emit('spawn');
    const handle = await pending;
    expect(handle.pid).toBe(4242);

    // Now a LATER error fires with NO subsequent 'exit'. Without the fix, `exit`
    // hangs; with it, `exit` resolves to a synthetic terminal.
    capture.child()?.emit('error', new Error('async i/o failure after spawn'));

    // A hard timeout so a regression manifests as a fast failure, not a hang.
    const exit = await Promise.race([
      handle.exit,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('child.exit never resolved (post-settle error dropped)')), 1000),
      ),
    ]);
    expect(exit).toEqual({ code: null, signal: null });
  });

  it('AsyncSpawn_PostSettleError_DoesNotOverrideRealExit', async () => {
    // If a real 'exit' already landed, a later 'error' must NOT clobber it — the
    // first terminal wins.
    const capture = makeCaptureSpawn();
    const pending = spawnHarnessChild(
      { command: process.execPath, args: ['-e', ''], cwd: process.cwd(), stdio: 'ignore' },
      { platform: 'linux', spawn: capture.spawnFn },
    );
    capture.child()?.emit('spawn');
    const handle = await pending;

    capture.child()?.emit('exit', 7, null); // the genuine terminal
    capture.child()?.emit('error', new Error('late error after a real exit'));

    const exit = await handle.exit;
    expect(exit).toEqual({ code: 7, signal: null });
  });

  it('AsyncSpawn_Unknown_StructuredError', async () => {
    // An unresolvable command surfaces as a rejected SpawnError, not an uncaught
    // throw. POSIX: the real spawn emits ENOENT → SPAWN_FAILED.
    await expect(
      spawnHarnessChild({
        command: 'exarchos-definitely-not-a-real-binary-xyz-123',
        args: [],
        cwd: process.cwd(),
        stdio: 'ignore',
      }),
    ).rejects.toBeInstanceOf(SpawnError);

    // win32 branch: an unresolvable bare command → structured COMMAND_NOT_FOUND
    // from the pure planner (exercised on the POSIX host via injected platform).
    const planned = resolveSpawnPlan(
      { command: 'ghost-harness', args: [], cwd: 'C:/wt' },
      'win32',
      () => null,
    );
    expect(planned.ok).toBe(false);
    if (!planned.ok) {
      expect(planned.error).toBeInstanceOf(SpawnError);
      expect(planned.error.code).toBe('COMMAND_NOT_FOUND');
    }
  });
});
