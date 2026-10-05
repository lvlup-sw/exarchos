/**
 * Spawns an MCP server over stdio for a test and returns a connected client.
 * The client comes from the v2 SDK (`@modelcontextprotocol/client`), the same generation
 * as the server. A v1 client with a v2 server hangs and reports no error.
 */
import type { ChildProcess } from 'node:child_process';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import * as processTracker from './process-tracker.js';

/** Options for `spawnMcpClient`. */
export interface SpawnMcpClientOpts {
  /**
   * Executable name, resolved on PATH. The default is `'exarchos'`, the one shipped binary.
   * `exarchos mcp` starts the MCP server. No separate `exarchos-mcp` binary exists.
   * An explicit `command` spawns a different server, such as a mock stdio server.
   */
  command?: string;
  /**
   * Arguments for the child. With the default `command`, the child gets `['mcp', ...args]`.
   * With an explicit `command`, the child gets `args` unchanged.
   */
  args?: string[];
  /** Extra variables. The transport merges them over its default environment for the child. */
  env?: Record<string, string>;
  /**
   * Sets `WORKFLOW_STATE_DIR`, which the binary reads, and `EXARCHOS_STATE_DIR` in the
   * child environment.
   */
  stateDir?: string;
  /** Time in ms to wait for `initialize` before the call rejects. */
  timeout?: number;
}

/** The result of `spawnMcpClient`. */
export interface SpawnedMcpClient {
  /** The client, connected and initialized. */
  client: Client;
  /**
   * The child process. The function reads it from the private `_process` field of the
   * transport. That field name is correct for `@modelcontextprotocol/client` 2.0.0.
   */
  server: ChildProcess;
  /**
   * Closes the client and waits for the child to exit. After `FORCE_KILL_GRACE_MS` it
   * sends `SIGKILL`. Then it unregisters the child. A second call does nothing.
   */
  terminate(): Promise<void>;
  /** The stderr chunks of the child, appended as they arrive. */
  stderr: string[];
}

const DEFAULT_COMMAND = 'exarchos';
const DEFAULT_SUBCOMMAND = 'mcp';
const DEFAULT_TIMEOUT_MS = 10_000;
const FORCE_KILL_GRACE_MS = 3_000;

/**
 * Spawns an MCP server over stdio and returns a connected `Client`.
 *
 * The function returns only after the MCP `initialize` handshake. If the child exits or
 * the timeout expires first, it kills the child, unregisters it and rejects. The exit
 * error includes the captured stderr.
 *
 * The function starts the transport before `Client.connect` and registers the child with
 * the process tracker immediately, so `expectNoLeakedProcesses` can find it. A guard
 * makes the second `start()` call, from `Client.connect`, do nothing. The stderr listener
 * attaches before the start, so the function loses no early chunk.
 */
export async function spawnMcpClient(
  opts: SpawnMcpClientOpts = {},
): Promise<SpawnedMcpClient> {
  const {
    command = DEFAULT_COMMAND,
    args: callerArgs = [],
    env: extraEnv,
    stateDir,
    timeout = DEFAULT_TIMEOUT_MS,
  } = opts;
  const usingDefaultCommand = opts.command === undefined;
  const args = usingDefaultCommand
    ? [DEFAULT_SUBCOMMAND, ...callerArgs]
    : callerArgs;

  const env: Record<string, string> = { ...(extraEnv ?? {}) };
  if (stateDir !== undefined) {
    env.WORKFLOW_STATE_DIR = stateDir;
    env.EXARCHOS_STATE_DIR = stateDir;
  }

  const transport = new StdioClientTransport({
    command,
    args,
    ...(Object.keys(env).length > 0 ? { env } : {}),
    stderr: 'pipe',
  });

  const stderr: string[] = [];
  transport.stderr?.on('data', (chunk: Buffer | string) => {
    const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    if (text.length > 0) {
      stderr.push(text);
    }
  });

  const originalStart = transport.start.bind(transport);
  let started = false;
  transport.start = async (): Promise<void> => {
    if (started) {
      return;
    }
    started = true;
    await originalStart();
  };

  try {
    await transport.start();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `spawnMcpClient: failed to spawn '${command}': ${msg}`,
    );
  }

  const transportInternals = transport as unknown as { _process?: unknown };
  const candidate = transportInternals._process;
  if (
    !candidate ||
    typeof candidate !== 'object' ||
    typeof (candidate as ChildProcess).kill !== 'function' ||
    typeof (candidate as ChildProcess).pid !== 'number'
  ) {
    throw new Error(
      "spawnMcpClient: transport did not expose a ChildProcess after start() — " +
        "@modelcontextprotocol/client internals may have changed (verified against 2.0.0)",
    );
  }
  const child = candidate as ChildProcess;
  processTracker.register(child);

  const client = new Client(
    { name: 'exarchos-test-harness', version: '0.0.0' },
    { capabilities: {} },
  );

  let exitedBeforeConnect = false;
  const exitPromise: Promise<void> = new Promise((resolve) => {
    child.once('exit', () => {
      exitedBeforeConnect = true;
      resolve();
    });
  });

  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise: Promise<never> = new Promise((_resolve, reject) => {
    timeoutHandle = setTimeout(() => {
      reject(
        new Error(
          `spawnMcpClient: initialize timed out after ${timeout}ms (command='${command}')`,
        ),
      );
    }, timeout);
    timeoutHandle.unref?.();
  });

  const connectPromise = client.connect(transport).then(() => 'ok' as const);

  try {
    const outcome = await Promise.race([
      connectPromise,
      exitPromise.then(() => 'exited' as const),
      timeoutPromise,
    ]);

    if (outcome === 'exited' || exitedBeforeConnect) {
      const joined = stderr.join('').trim();
      const suffix = joined.length > 0 ? `: ${joined}` : '';
      throw new Error(
        `spawnMcpClient: server process exited before initialize completed${suffix}`,
      );
    }
  } catch (err) {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
    try {
      await transport.close();
    } catch {
    }
    if (child.exitCode === null && child.signalCode === null) {
      try {
        child.kill('SIGKILL');
      } catch {
      }
    }
    await new Promise<void>((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) {
        resolve();
        return;
      }
      child.once('exit', () => resolve());
    });
    processTracker.unregister(child);
    throw err;
  }

  if (timeoutHandle) {
    clearTimeout(timeoutHandle);
  }

  let terminated = false;
  const terminate = async (): Promise<void> => {
    if (terminated) {
      return;
    }
    terminated = true;

    const exitDone = new Promise<void>((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) {
        resolve();
        return;
      }
      child.once('exit', () => resolve());
    });

    try {
      await client.close();
    } catch {
    }

    await Promise.race([
      exitDone,
      new Promise<void>((resolve) => {
        const h = setTimeout(resolve, FORCE_KILL_GRACE_MS);
        h.unref?.();
      }),
    ]);

    if (child.exitCode === null && child.signalCode === null) {
      try {
        child.kill('SIGKILL');
      } catch {
      }
      await exitDone;
    }

    processTracker.unregister(child);
  };

  return {
    client,
    server: child,
    stderr,
    terminate,
  };
}
