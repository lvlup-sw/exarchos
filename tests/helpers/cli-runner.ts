/**
 * A CLI invoker for the process-fidelity harness. It runs any command, and the default is the
 * one `exarchos` binary with its subcommands.
 */
import { spawn } from 'node:child_process';
import { register, unregister } from './process-tracker.js';

export interface RunCliOpts {
  /**
   * The binary or interpreter to run. The default is `'exarchos'`, the one shipped binary.
   * A test passes a different value, such as `'node'` for an inline script.
   */
  command?: string;
  /** Arguments passed to the command. */
  args?: string[];
  /** Env vars merged over `process.env`. Values here override the parent env. */
  env?: Record<string, string>;
  /** Working directory for the child. Defaults to `process.cwd()`. */
  cwd?: string;
  /** Data written to the stdin of the child. The stream closes after the write. */
  stdin?: string;
  /** Max runtime in ms before SIGKILL + reject. Defaults to 30_000. */
  timeout?: number;
}

export interface CliResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Spawns `command` with `args`, collects stdout and stderr, and resolves with the result.
 * A non-zero exit code does not reject: the caller asserts on `exitCode`. A timeout sends
 * SIGKILL and then rejects, and a spawn `error` event such as `ENOENT` also rejects.
 * `runCli` ignores a kill error, because the child can be gone already.
 *
 * `runCli` registers the child with the process tracker immediately after the spawn. Thus
 * `expectNoLeakedProcesses()` sees a child that crashes before the first I/O handler.
 *
 * When a signal ends the child, Node reports a `null` code. The result then holds
 * `128 + <signal number>`, so `exitCode` is always a number.
 *
 * @example
 *   await runCli({ args: ['install-skills'] });
 */
export function runCli(opts: RunCliOpts): Promise<CliResult> {
  const {
    command = 'exarchos',
    args = [],
    env,
    cwd = process.cwd(),
    stdin,
    timeout = DEFAULT_TIMEOUT_MS,
  } = opts;

  const mergedEnv: NodeJS.ProcessEnv = { ...process.env, ...env };

  return new Promise<CliResult>((resolve, reject) => {
    const start = Date.now();
    const child = spawn(command, args, {
      env: mergedEnv,
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    register(child);

    let stdout = '';
    let stderr = '';
    let settled = false;

    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });

    const timer = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      try {
        child.kill('SIGKILL');
      } catch {
      }
      unregister(child);
      reject(
        new Error(
          `runCli: timeout — command '${command}' did not exit within ${timeout}ms`,
        ),
      );
    }, timeout);

    child.on('error', (err) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      unregister(child);
      reject(err);
    });

    child.on('close', (code, signal) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      unregister(child);
      const exitCode =
        typeof code === 'number'
          ? code
          : signal
            ? 128 + (signalNumber(signal) ?? 0)
            : 1;
      resolve({
        stdout,
        stderr,
        exitCode,
        durationMs: Date.now() - start,
      });
    });

    if (typeof stdin === 'string' && child.stdin) {
      child.stdin.write(stdin);
      child.stdin.end();
    } else if (child.stdin) {
      child.stdin.end();
    }
  });
}

/**
 * Maps a signal name to its number, for the few signals that `runCli` expects. It returns
 * `undefined` for an unknown signal, which the caller treats as 0.
 */
function signalNumber(signal: NodeJS.Signals): number | undefined {
  const table: Partial<Record<NodeJS.Signals, number>> = {
    SIGHUP: 1,
    SIGINT: 2,
    SIGQUIT: 3,
    SIGKILL: 9,
    SIGTERM: 15,
  };
  return table[signal];
}
