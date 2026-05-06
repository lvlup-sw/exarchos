import { spawn } from 'node:child_process';
import { register, unregister } from './process-tracker.js';

/**
 * Target-agnostic CLI invoker for the process-fidelity harness.
 *
 * Design: docs/designs/2026-04-19-process-fidelity-harness.md §5.3
 *
 * - Non-zero exit codes do NOT throw; the caller asserts on `exitCode`.
 * - Timeouts reject with an Error; the child is SIGKILLed before rejection.
 * - Every spawned child is registered with the process-tracker so leaks can
 *   be detected by `expectNoLeakedProcesses()`.
 */

export interface RunCliOpts {
  /** Binary or interpreter to execute (e.g. `'node'`, `'exarchos-install'`). */
  command: string;
  /** Arguments passed to the command. */
  args?: string[];
  /** Env vars merged over `process.env`. Values here override the parent env. */
  env?: Record<string, string>;
  /** Working directory for the child. Defaults to `process.cwd()`. */
  cwd?: string;
  /** Data piped to the child's stdin; stdin is closed after writing. */
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
 * Spawn `command` with `args`, collect stdout/stderr, and resolve with the
 * structured result. Rejects only on timeout.
 */
export function runCli(opts: RunCliOpts): Promise<CliResult> {
  const {
    command,
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

    // Register IMMEDIATELY after spawn so a leak detector never misses a
    // short-lived crash between spawn and the first I/O handler.
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
        // child may already have exited
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
      // If the process was killed by a signal, Node reports code === null.
      // Surface a numeric exitCode so callers never have to handle null: use
      // 128 + signal convention for signalled exits, else default to 1.
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
 * Minimal signal-name → number mapping for the subset we care about when
 * synthesising an exitCode for signalled exits. Returns undefined if unknown,
 * which the caller treats as 0.
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
