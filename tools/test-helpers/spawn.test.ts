// The async spawn helpers keep the `spawnSync` / `execFileSync` contracts that
// test code relied on, and they leave the event loop free while a child runs
// (#2029).
import { randomUUID } from 'node:crypto';
import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  SpawnFailure,
  execAsync,
  execFileAsync,
  isolatedSync,
  spawnAsync,
  spawnAsyncBuffer,
} from './spawn.js';

const NODE = process.execPath;

/** `execFileAsync` returns stdout and rejects on a failed exit, like `execFileSync`. */
describe('execFileAsync', () => {
  /** A zero exit resolves with stdout as text. */
  it('ZeroExit_ResolvesWithStdout', async () => {
    await expect(execFileAsync(NODE, ['-e', 'process.stdout.write("out")'])).resolves.toBe('out');
  });

  /** A non-zero exit rejects with the status and both streams. */
  it('NonZeroExit_RejectsWithStatusAndStreams', async () => {
    const failure = await execFileAsync(NODE, ['-e', 'process.stdout.write("o"); process.stderr.write("e"); process.exit(3)']).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(SpawnFailure);
    expect(failure).toMatchObject({ status: 3, stdout: 'o', stderr: 'e' });
  });

  /** A command that cannot start rejects. */
  it('MissingCommand_Rejects', async () => {
    await expect(execFileAsync('exarchos-no-such-command-2029', [])).rejects.toBeInstanceOf(SpawnFailure);
  });
});

/** `spawnAsync` never rejects and reports what `spawnSync` reports. */
describe('spawnAsync', () => {
  /** A non-zero exit is a status, not a rejection. */
  it('NonZeroExit_ResolvesWithTheStatus', async () => {
    const result = await spawnAsync(NODE, ['-e', 'process.exit(3)']);
    expect(result.status).toBe(3);
    expect(result.error).toBeUndefined();
  });

  /** A command that cannot start resolves with an error and no status. */
  it('MissingCommand_ResolvesWithAnError', async () => {
    const result = await spawnAsync('exarchos-no-such-command-2029', []);
    expect(result.status).toBeNull();
    expect(result.error).toBeInstanceOf(Error);
  });

  /** `input` reaches the child's stdin, which is then closed. */
  it('Input_IsWrittenToStdin', async () => {
    const result = await spawnAsync(NODE, ['-e', 'process.stdin.pipe(process.stdout)'], { input: 'piped' });
    expect(result.stdout).toBe('piped');
  });

  /** `cwd` and `env` reach the child. */
  it('CwdAndEnv_ReachTheChild', async () => {
    const result = await spawnAsync(NODE, ['-e', 'process.stdout.write(process.cwd() + "|" + process.env.SPAWN_PROBE)'], {
      cwd: process.cwd(),
      env: { ...process.env, SPAWN_PROBE: 'set' },
    });
    expect(result.stdout).toBe(`${process.cwd()}|set`);
  });

  /** A child past its `timeout` is killed and reported as timed out. */
  it('Timeout_KillsTheChildAndReportsIt', async () => {
    const result = await spawnAsync(NODE, ['-e', 'setTimeout(() => {}, 60000)'], { timeout: 200 });
    expect(result.status).toBeNull();
    expect(result.signal).toBe('SIGTERM');
    expect(result.error).toMatchObject({ code: 'ETIMEDOUT' });
  });

  /** The call returns before the child has run any code, so nothing ran synchronously. */
  it('ReturnsBeforeTheChildRuns', async () => {
    const marker = join(tmpdir(), `spawn-helper-${randomUUID()}`);
    try {
      const pending = spawnAsync(NODE, ['-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)}, '')`]);
      const ranBeforeReturn = existsSync(marker);
      await pending;
      expect(ranBeforeReturn).toBe(false);
      expect(existsSync(marker)).toBe(true);
    } finally {
      rmSync(marker, { force: true });
    }
  });

  /** The event loop keeps turning while a child runs. */
  it('WhileAChildRuns_TheEventLoopKeepsTurning', async () => {
    let ticks = 0;
    const interval = setInterval(() => {
      ticks += 1;
    }, 5);
    try {
      await spawnAsync(NODE, ['-e', 'setTimeout(() => {}, 300)']);
    } finally {
      clearInterval(interval);
    }
    expect(ticks).toBeGreaterThan(0);
  });
});

/** The other forms keep their sync counterparts' output types. */
describe('spawnAsyncBuffer and execAsync', () => {
  /** `spawnAsyncBuffer` returns raw bytes. */
  it('SpawnAsyncBuffer_ReturnsBytes', async () => {
    const result = await spawnAsyncBuffer(NODE, ['-e', 'process.stdout.write(Buffer.from([0, 255]))']);
    expect(Buffer.isBuffer(result.stdout)).toBe(true);
    expect([...result.stdout]).toEqual([0, 255]);
  });

  /** `execAsync` runs one shell command line. */
  it('ExecAsync_RunsAShellCommandLine', async () => {
    await expect(execAsync(`"${NODE}" -e "process.stdout.write('shell')"`)).resolves.toBe('shell');
  });
});

/** `isolatedSync` yields before and after the one call it makes. */
describe('isolatedSync', () => {
  /** A macrotask queued before the call has run when the call starts. */
  it('YieldsBeforeTheCall', async () => {
    let ran = false;
    setImmediate(() => {
      ran = true;
    });
    await expect(isolatedSync(() => ran)).resolves.toBe(true);
  });

  /** A macrotask queued by the call has run when the promise settles. */
  it('YieldsAfterTheCall', async () => {
    let ran = false;
    await isolatedSync(() =>
      setImmediate(() => {
        ran = true;
      }),
    );
    expect(ran).toBe(true);
  });

  /** A throwing call rejects with the same error. */
  it('ThrowingCall_Rejects', async () => {
    await expect(
      isolatedSync(() => {
        throw new Error('subject failed');
      }),
    ).rejects.toThrow('subject failed');
  });
});
