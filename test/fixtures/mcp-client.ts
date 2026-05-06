import type { ChildProcess } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import * as processTracker from './process-tracker.js';

/**
 * Options controlling how `spawnMcpClient` spawns and initializes the MCP
 * server subprocess.
 *
 * See design §5.2 for field semantics.
 */
export interface SpawnMcpClientOpts {
  /** Executable name (resolved on PATH). Defaults to `'exarchos-mcp'`. */
  command?: string;
  /** Argv passed to the child. */
  args?: string[];
  /** Extra env vars merged with the child's default environment. */
  env?: Record<string, string>;
  /** Shortcut for `env.EXARCHOS_STATE_DIR`. */
  stateDir?: string;
  /** Millis to wait for `initialize` to complete before rejecting. */
  timeout?: number;
}

/**
 * Handle returned by `spawnMcpClient`. The `client` is already connected and
 * initialized; `server` is the spawned process; `stderr` is a live-updating
 * buffer of stderr lines; `terminate()` tears everything down safely and is
 * idempotent.
 *
 * See design §5.2.
 */
export interface SpawnedMcpClient {
  client: Client;
  server: ChildProcess;
  terminate(): Promise<void>;
  stderr: string[];
}

const DEFAULT_COMMAND = 'exarchos-mcp';
const DEFAULT_TIMEOUT_MS = 10_000;
const FORCE_KILL_GRACE_MS = 3_000;

/**
 * Spawns an MCP server binary over stdio and returns a connected `Client`.
 *
 * Guarantees (per design §5.2):
 *   - Returns only after `client.connect(transport)` completes (i.e. after
 *     the MCP `initialize` handshake).
 *   - `terminate()` is idempotent — repeat calls are no-ops.
 *   - If the child process exits before initialize completes, the returned
 *     promise rejects with an `Error` that includes the captured stderr.
 *   - The child is registered with the fixture-internal process tracker
 *     immediately after spawn and unregistered after `terminate()` observes
 *     exit, so `expectNoLeakedProcesses` can detect stragglers.
 */
export async function spawnMcpClient(
  opts: SpawnMcpClientOpts = {},
): Promise<SpawnedMcpClient> {
  const {
    command = DEFAULT_COMMAND,
    args = [],
    env: extraEnv,
    stateDir,
    timeout = DEFAULT_TIMEOUT_MS,
  } = opts;

  // Merge extra env with an optional EXARCHOS_STATE_DIR shortcut. The
  // transport applies its own default-env allowlist; we only pass through
  // the explicit overrides here.
  const env: Record<string, string> = { ...(extraEnv ?? {}) };
  if (stateDir !== undefined) {
    env.EXARCHOS_STATE_DIR = stateDir;
  }

  const transport = new StdioClientTransport({
    command,
    args,
    env: Object.keys(env).length > 0 ? env : undefined,
    stderr: 'pipe',
  });

  // ── stderr capture ───────────────────────────────────────────────────────
  // Pipe stderr chunks into a live-updating string array. We attach the
  // listener before `start()` runs because the transport's stderr getter
  // returns a PassThrough immediately — chunks produced early in the
  // child's life are not lost.
  const stderr: string[] = [];
  transport.stderr?.on('data', (chunk: Buffer | string) => {
    const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    if (text.length > 0) {
      stderr.push(text);
    }
  });

  // ── start-once guard on the transport ────────────────────────────────────
  // `Client.connect(transport)` internally calls `transport.start()`. We
  // need to start the transport ourselves first so we can register the
  // spawned child with the process tracker before any async gap allows a
  // crash to escape detection. A guarded override makes the second call
  // (from inside Client.connect) a no-op.
  const originalStart = transport.start.bind(transport);
  let started = false;
  transport.start = async (): Promise<void> => {
    if (started) {
      return;
    }
    started = true;
    await originalStart();
  };

  // Start now so the process exists before we race against timeout / exit.
  try {
    await transport.start();
  } catch (err) {
    // Spawn itself failed (e.g. ENOENT). Nothing to clean up — the
    // transport never exposed a process.
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `spawnMcpClient: failed to spawn '${command}': ${msg}`,
    );
  }

  // Reach into the transport for the ChildProcess reference. The SDK does
  // not expose it publicly, but we need it for lifecycle management and
  // leak detection. Verified against @modelcontextprotocol/sdk 1.29.
  const transportInternals = transport as unknown as { _process?: ChildProcess };
  const child = transportInternals._process;
  if (!child) {
    throw new Error(
      'spawnMcpClient: transport did not expose a child process after start()',
    );
  }
  processTracker.register(child);

  // ── connect race: initialize vs timeout vs premature exit ────────────────
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
    // Do not keep the event loop alive solely for this timer.
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
    // Teardown on any failure path: ensure the child dies and is
    // unregistered so the leak detector stays accurate.
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
    try {
      await transport.close();
    } catch {
      // ignore close errors during error teardown
    }
    // Transport.close may have already killed the child, but make sure.
    if (child.exitCode === null && child.signalCode === null) {
      try {
        child.kill('SIGKILL');
      } catch {
        // ignore
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

  // ── terminate: idempotent teardown ───────────────────────────────────────
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
      // client.close() closes the transport which may reject if the
      // process already exited; we still want terminate() to succeed.
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
        // ignore
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
