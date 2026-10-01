// The one way test code starts a child process (#2029).
//
// A synchronous spawn blocks the vitest worker's event loop. While the loop is
// blocked, the worker cannot read the reply to its own `onTaskUpdate` call, and
// that call fails after 60 s. The block also adds up across tests, because the
// runner does not yield between them. So a file of quick tests can still block
// for a minute on a slow host, and the run then fails with no test named.
//
// These helpers spawn asynchronously, so the loop stays free however slow the
// child is. `isolatedSync` is for a test whose subject IS a synchronous spawn
// API: it yields before and after the one call, so that call is the whole
// blocked stretch. `tests/architecture/worker-loop-and-clock.test.ts` keeps
// every other synchronous spawn out of test code.
import { spawn } from 'node:child_process';
import { setImmediate as yieldToEventLoop } from 'node:timers/promises';

import { needsWindowsShell } from '../../src/utils/process.js';

/** What a test may ask of a child process. */
export interface SpawnOptions {
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  /** Written to the child's stdin, which is then closed. */
  readonly input?: string | Buffer;
  /** Kills the child after this many milliseconds, as `spawnSync` does. */
  readonly timeout?: number;
  readonly killSignal?: NodeJS.Signals;
  readonly shell?: boolean | string;
}

/** The outcome of one child process, in the shape `spawnSync` returns. */
export interface SpawnResult<T extends string | Buffer = string> {
  readonly status: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: T;
  readonly stderr: T;
  /** Set when the child could not start, or when it hit `timeout`. */
  readonly error?: Error;
}

/** Thrown by {@link execFileAsync} when the child does not exit with 0. */
export class SpawnFailure extends Error {
  readonly status: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;

  constructor(command: string, result: SpawnResult) {
    super(`Command failed: ${command}\n${result.error?.message ?? result.stderr}`);
    this.name = 'SpawnFailure';
    this.status = result.status;
    this.signal = result.signal;
    this.stdout = result.stdout;
    this.stderr = result.stderr;
  }
}

/** The command and arguments to start, with Windows package-manager shims run through a shell. */
function plan(
  command: string,
  args: readonly string[],
  options: SpawnOptions,
): { file: string; argv: string[]; shell: boolean | string } {
  if (options.shell === undefined && needsWindowsShell(command)) {
    return { file: command, argv: args.map((a) => (/\s/.test(a) ? `"${a}"` : a)), shell: true };
  }
  return { file: command, argv: [...args], shell: options.shell ?? false };
}

/** Runs a child to completion and never rejects; the raw-bytes form of {@link spawnAsync}. */
export function spawnAsyncBuffer(
  command: string,
  args: readonly string[] = [],
  options: SpawnOptions = {},
): Promise<SpawnResult<Buffer>> {
  const { file, argv, shell } = plan(command, args, options);
  return new Promise((resolve) => {
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let error: Error | undefined;
    let settled = false;
    const child = spawn(file, argv, {
      cwd: options.cwd,
      env: options.env,
      shell,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const timer =
      options.timeout === undefined
        ? undefined
        : setTimeout(() => {
            error = Object.assign(new Error(`spawn ${command} ETIMEDOUT`), { code: 'ETIMEDOUT' });
            child.kill(options.killSignal ?? 'SIGTERM');
          }, options.timeout);
    const finish = (status: number | null, signal: NodeJS.Signals | null): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      resolve({
        status,
        signal,
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr),
        ...(error === undefined ? {} : { error }),
      });
    };
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.stdin.on('error', () => undefined);
    child.on('error', (err) => {
      error = err;
      finish(null, null);
    });
    child.on('close', (status, signal) => finish(status, signal));
    child.stdin.end(options.input);
  });
}

/** Runs a child to completion and never rejects, like `spawnSync` with `encoding: 'utf8'`. */
export async function spawnAsync(
  command: string,
  args: readonly string[] = [],
  options: SpawnOptions = {},
): Promise<SpawnResult> {
  const raw = await spawnAsyncBuffer(command, args, options);
  return { ...raw, stdout: raw.stdout.toString('utf8'), stderr: raw.stderr.toString('utf8') };
}

/** Returns stdout, and rejects with {@link SpawnFailure} unless the child exits with 0, like `execFileSync`. */
export async function execFileAsync(
  command: string,
  args: readonly string[] = [],
  options: SpawnOptions = {},
): Promise<string> {
  const result = await spawnAsync(command, args, options);
  if (result.status !== 0 || result.error !== undefined) {
    throw new SpawnFailure([command, ...args].join(' '), result);
  }
  return result.stdout;
}

/** Runs one shell command line and returns stdout, like `execSync`. */
export function execAsync(commandLine: string, options: SpawnOptions = {}): Promise<string> {
  return execFileAsync(commandLine, [], { ...options, shell: options.shell ?? true });
}

/**
 * Calls one synchronous spawn API on its own, for a test whose subject is that API.
 * It yields to the event loop before and after the call, so the call cannot join
 * a longer blocked stretch.
 */
export async function isolatedSync<T>(call: () => T): Promise<T> {
  await yieldToEventLoop();
  try {
    return call();
  } finally {
    await yieldToEventLoop();
  }
}
