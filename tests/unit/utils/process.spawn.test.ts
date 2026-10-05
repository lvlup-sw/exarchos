/**
 * Spawn tests that the Windows CI lane runs by name, so `.github/workflows/ci.yml` holds this file path.
 * The long-lived and metacharacter cases spawn a real child on the host platform.
 * The win32 shim cases drive `resolveSpawnPlan` and a captured spawn seam with
 * `platform: 'win32'`, so a POSIX host also checks the win32 plan.
 */
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
} from '../../../src/utils/process.js';

/** An in-memory child that the capture seam returns, so no real process starts. */
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
  /**
   * The child idles until the test kills it.
   * The exit must then carry a signal or a non-zero code.
   */
  it('AsyncSpawn_HarnessCli_LongLived', async () => {
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
    expect(exit.signal !== null || exit.code !== 0).toBe(true);
  }, 20000);

  /**
   * A `.cmd` shim runs through `cmd.exe` with its resolved path, verbatim arguments
   * and caret-escaped metacharacters. A `.ps1` shim runs through `powershell.exe -File`.
   * No plan sets `shell: true`, which is the CVE-2024-27980 hazard.
   * The last part checks that `spawnHarnessChild` passes the `.cmd` plan to the spawn seam.
   */
  it('AsyncSpawn_Win32Shim_ResolvedNoShell', async () => {
    const planCmd = resolveSpawnPlan(
      { command: 'myharness', args: ['a & b'], cwd: 'C:/wt', env: { FOO: 'bar' } },
      'win32',
      (c) => (c === 'myharness' ? 'C:/shims/myharness.cmd' : null),
    );
    expect(planCmd.ok).toBe(true);
    if (planCmd.ok) {
      const { file, args, options } = planCmd.plan;
      expect(file.toLowerCase()).toContain('cmd');
      expect(options.shell).not.toBe(true);
      expect(options.windowsVerbatimArguments).toBe(true);
      const body = args.join(' ');
      expect(args).toContain('/c');
      expect(body).toContain('myharness.cmd');
      expect(body).toContain('^&');
    }

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

  /**
   * The child writes the argument that it receives to a temp file, and the test compares the text.
   * No `pwned` file can exist, because no shell reads the metacharacters.
   */
  it('AsyncSpawn_MetacharArg_PassedLiterally_NoShellInterpolation', async () => {
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
      expect(fs.existsSync(path.join(process.cwd(), 'pwned'))).toBe(false);
    } finally {
      if (fs.existsSync(outFile)) fs.rmSync(outFile);
    }
  }, 20000);

  /**
   * An `'error'` after `'spawn'` can arrive with no `'exit'`.
   * Then `exit` must resolve with a null code and signal, or a supervisor that awaits it hangs.
   * The 1000 ms race makes a regression fail fast.
   */
  it('AsyncSpawn_PostSettleError_ResolvesExit_NeverHangs', async () => {
    const capture = makeCaptureSpawn();
    const pending = spawnHarnessChild(
      { command: process.execPath, args: ['-e', ''], cwd: process.cwd(), stdio: 'ignore' },
      { platform: 'linux', spawn: capture.spawnFn },
    );
    capture.child()?.emit('spawn');
    const handle = await pending;
    expect(handle.pid).toBe(4242);

    capture.child()?.emit('error', new Error('async i/o failure after spawn'));

    const exit = await Promise.race([
      handle.exit,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('child.exit never resolved (post-settle error dropped)')), 1000),
      ),
    ]);
    expect(exit).toEqual({ code: null, signal: null });
  });

  /** The first terminal wins: an `'error'` after a real `'exit'` does not change the result. */
  it('AsyncSpawn_PostSettleError_DoesNotOverrideRealExit', async () => {
    const capture = makeCaptureSpawn();
    const pending = spawnHarnessChild(
      { command: process.execPath, args: ['-e', ''], cwd: process.cwd(), stdio: 'ignore' },
      { platform: 'linux', spawn: capture.spawnFn },
    );
    capture.child()?.emit('spawn');
    const handle = await pending;

    capture.child()?.emit('exit', 7, null);
    capture.child()?.emit('error', new Error('late error after a real exit'));

    const exit = await handle.exit;
    expect(exit).toEqual({ code: 7, signal: null });
  });

  /**
   * On the host, a command that does not resolve rejects with a `SpawnError`.
   * With `platform: 'win32'`, the planner returns `COMMAND_NOT_FOUND` for such a bare command.
   */
  it('AsyncSpawn_Unknown_StructuredError', async () => {
    await expect(
      spawnHarnessChild({
        command: 'exarchos-definitely-not-a-real-binary-xyz-123',
        args: [],
        cwd: process.cwd(),
        stdio: 'ignore',
      }),
    ).rejects.toBeInstanceOf(SpawnError);

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
