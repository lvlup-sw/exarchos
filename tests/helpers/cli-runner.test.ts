/**
 * Tests for `runCli`, the CLI invoker. All tests but one run `node -e '<inline script>'`.
 * The other test expects the spawn of the default command to fail. Thus no test needs a
 * project binary, and the suite depends only on `node`.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli } from './cli-runner.js';
import { listAlive, clear, killAll } from './process-tracker.js';
import { rmrf } from '../../tools/test-helpers/temp-dir.js';

/**
 * The hook stops each live child in the tracker before it clears the tracker. `runCli`
 * unregisters a child on close, so `killAll` usually does nothing. If a child outlives its
 * test, a clear with no kill leaks the process.
 */
afterEach(async () => {
  await killAll({ timeoutMs: 1000 });
  clear();
});

describe('runCli', () => {
  it('RunCli_SuccessfulCommand_ReturnsZeroExitCode', async () => {
    const result = await runCli({
      command: 'node',
      args: ['-e', 'process.exit(0)'],
    });

    expect(result.exitCode).toBe(0);
  });

  it('RunCli_NonZeroExit_ReturnsStructuredResultNotThrow', async () => {
    const result = await runCli({
      command: 'node',
      args: ['-e', 'process.exit(7)'],
    });

    expect(result.exitCode).toBe(7);
    expect(typeof result.stdout).toBe('string');
    expect(typeof result.stderr).toBe('string');
  });

  it('RunCli_CapturesStdoutAndStderr_Separately', async () => {
    const result = await runCli({
      command: 'node',
      args: [
        '-e',
        "process.stdout.write('stdout-line'); process.stderr.write('stderr-line');",
      ],
    });

    expect(result.stdout).toBe('stdout-line');
    expect(result.stderr).toBe('stderr-line');
    expect(result.exitCode).toBe(0);
  });

  it('RunCli_Stdin_PipesToChild', async () => {
    const script = [
      "let buf = '';",
      "process.stdin.on('data', (chunk) => { buf += chunk.toString(); });",
      "process.stdin.on('end', () => { process.stdout.write(buf); });",
    ].join(' ');

    const result = await runCli({
      command: 'node',
      args: ['-e', script],
      stdin: 'hello-from-test',
    });

    expect(result.stdout).toBe('hello-from-test');
    expect(result.exitCode).toBe(0);
  });

  /**
   * After the rejection, the tracker must hold no live child. `runCli` unregisters the child
   * before it rejects, so this check does not prove that the kill stopped the child.
   */
  it('RunCli_Timeout_RejectsAndKillsChild', async () => {
    await expect(
      runCli({
        command: 'node',
        args: ['-e', 'setInterval(() => {}, 1000)'],
        timeout: 200,
      }),
    ).rejects.toThrow(/timeout/i);

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(listAlive()).toHaveLength(0);
  });

  /** The child must see a variable of the parent environment and the override. */
  it('RunCli_EnvOverride_MergedWithCurrentEnv', async () => {
    const parentSentinel = `RUN_CLI_PARENT_${Date.now()}`;
    process.env.RUN_CLI_PARENT_SENTINEL = parentSentinel;

    try {
      const result = await runCli({
        command: 'node',
        args: [
          '-e',
          "process.stdout.write(JSON.stringify({ parent: process.env.RUN_CLI_PARENT_SENTINEL, override: process.env.RUN_CLI_OVERRIDE }));",
        ],
        env: { RUN_CLI_OVERRIDE: 'override-value' },
      });

      const parsed = JSON.parse(result.stdout) as {
        parent: string;
        override: string;
      };
      expect(parsed.parent).toBe(parentSentinel);
      expect(parsed.override).toBe('override-value');
    } finally {
      delete process.env.RUN_CLI_PARENT_SENTINEL;
    }
  });

  /** On macOS, `/tmp` is a symlink to `/private/tmp`, so the test compares the real paths. */
  it('RunCli_Cwd_SpawnsChildInGivenDirectory', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'run-cli-cwd-'));
    try {
      const result = await runCli({
        command: 'node',
        args: ['-e', 'process.stdout.write(process.cwd())'],
        cwd: tmp,
      });

      expect(realpathSync(result.stdout)).toBe(realpathSync(tmp));
      expect(result.exitCode).toBe(0);
    } finally {
      rmrf(tmp);
    }
  });

  it('RunCli_Duration_ReportedInMilliseconds', async () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValueOnce(10_000).mockReturnValueOnce(10_150);
    try {
      const result = await runCli({
        command: 'node',
        args: ['-e', 'process.exit(0)'],
      });

      expect(result.exitCode).toBe(0);
      expect(result.durationMs).toBe(150);
    } finally {
      clock.mockRestore();
    }
  });

  /**
   * The test omits `command` and sets PATH to an empty directory. The spawn then fails with
   * `ENOENT`, and the error must name `exarchos`. Thus the test needs no installed binary.
   */
  it('runCli_defaultCommand_resolvesToExarchos', async () => {
    const isolatedPath = mkdtempSync(join(tmpdir(), 'run-cli-default-cmd-'));
    try {
      await expect(
        runCli({
          args: ['version'],
          env: { PATH: isolatedPath },
          timeout: 5_000,
        }),
      ).rejects.toThrow(/exarchos/);
    } finally {
      rmrf(isolatedPath);
    }
  });

  /**
   * The test cannot read the tracker from inside the `runCli` promise. Thus it starts a child
   * that lives 300 ms and polls `listAlive()` in parallel. The poll repeats, because a spawn
   * can be slow.
   */
  it('RunCli_RegistersWithProcessTracker_UnregistersOnExit', async () => {
    expect(listAlive()).toHaveLength(0);

    const script = 'setTimeout(() => {}, 300)';

    const pending = runCli({
      command: 'node',
      args: ['-e', script],
    });

    let sawAlive = false;
    for (let i = 0; i < 30; i++) {
      if (listAlive().length >= 1) {
        sawAlive = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(sawAlive).toBe(true);

    await pending;

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(listAlive()).toHaveLength(0);
  });
});
