import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli } from './cli-runner.js';
import { listAlive, clear } from './process-tracker.js';

/**
 * Tests for the target-agnostic CLI invoker `runCli`.
 *
 * Design: docs/designs/2026-04-19-process-fidelity-harness.md §5.3
 *
 * These tests deliberately invoke `node -e '<inline script>'` rather than any
 * project binary so that the suite has no dependency beyond `node` itself.
 */

afterEach(() => {
  // Defensive: ensure tracker state does not leak between tests. runCli must
  // unregister on close, so under normal conditions this is a no-op.
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
    // Non-zero exit codes must NOT throw — the caller asserts on exitCode.
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
    // Read everything from stdin and echo to stdout, then exit.
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

  it('RunCli_Timeout_RejectsAndKillsChild', async () => {
    const start = Date.now();

    await expect(
      runCli({
        command: 'node',
        args: ['-e', 'setInterval(() => {}, 1000)'],
        timeout: 200,
      }),
    ).rejects.toThrow(/timeout/i);

    const elapsed = Date.now() - start;
    // Must reject reasonably close to the configured timeout, not wait forever.
    expect(elapsed).toBeLessThan(5000);

    // After rejection, no child from runCli must remain alive.
    // Give the OS a tick to finalize the kill.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(listAlive()).toHaveLength(0);
  });

  it('RunCli_EnvOverride_MergedWithCurrentEnv', async () => {
    // Set a sentinel in the parent env, override one var, and confirm both the
    // current-env value and the override are visible in the child.
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

  it('RunCli_Cwd_SpawnsChildInGivenDirectory', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'run-cli-cwd-'));
    try {
      const result = await runCli({
        command: 'node',
        args: ['-e', 'process.stdout.write(process.cwd())'],
        cwd: tmp,
      });

      // Realpath-match: macOS `/tmp` often resolves to `/private/tmp`, so
      // we only require that the reported cwd ends with the tmp basename.
      expect(result.stdout.endsWith(tmp) || tmp.endsWith(result.stdout)).toBe(
        true,
      );
      expect(result.exitCode).toBe(0);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('RunCli_Duration_ReportedInMilliseconds', async () => {
    // Child that sleeps ~150ms, so we can verify durationMs is in ms scale.
    const result = await runCli({
      command: 'node',
      args: ['-e', 'setTimeout(() => {}, 150)'],
    });

    expect(result.exitCode).toBe(0);
    expect(typeof result.durationMs).toBe('number');
    // Must be at least the sleep time (minus a small scheduler slop) and
    // must clearly be in ms scale, not seconds (< 60s).
    expect(result.durationMs).toBeGreaterThanOrEqual(100);
    expect(result.durationMs).toBeLessThan(60_000);
  });

  it('RunCli_RegistersWithProcessTracker_UnregistersOnExit', async () => {
    expect(listAlive()).toHaveLength(0);

    // Observe tracker state mid-flight by starting a child that lives briefly
    // and polling listAlive() while it runs. We can't reliably sample "during"
    // from outside the promise, so we use a moderately long child and a
    // parallel poll.
    const script = 'setTimeout(() => {}, 300)';

    const pending = runCli({
      command: 'node',
      args: ['-e', script],
    });

    // Sample while child is still running.
    // Poll a few times to avoid a flake on slow spawn.
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

    // Give close handler a tick to unregister.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(listAlive()).toHaveLength(0);
  });
});
