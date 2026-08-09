import type { ChildProcess } from 'node:child_process';
// SDK v2 (DR-0/DR-26). These were the last live `@modelcontextprotocol/sdk`
// (v1) imports in the repository, and the package they resolved was EXTRANEOUS —
// declared by no manifest and absent from package-lock.json — so the suite passed
// only against a stale pre-migration `node_modules` and would not survive
// `npm ci`. The generation matters beyond resolution: a v1 client paired with a
// v2 server presents as a HANG rather than an error, so a cross-generation
// fixture is a latent trap, not a loud one.
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import * as processTracker from './process-tracker.js';

/**
 * Options controlling how `spawnMcpClient` spawns and initializes the MCP
 * server subprocess.
 *
 * See design §5.2 for field semantics.
 */
export interface SpawnMcpClientOpts {
  /**
   * Executable name (resolved on PATH). Defaults to `'exarchos'`.
   *
   * v2.9 ships a single `exarchos` binary with subcommand mode dispatch
   * (see `servers/exarchos-mcp/src/adapters/cli.ts` §"MCP server mode
   * command"). The MCP server is reached via `exarchos mcp`, NOT a
   * separate `exarchos-mcp` binary. To override (e.g. for tests that
   * need a mock stdio server), pass an explicit `command` AND remember
   * that any provided `args` will be prepended with `'mcp'` only when
   * the default command is in effect — see `args` below.
   */
  command?: string;
  /**
   * Argv passed to the child. When `command` is left at its default
   * (`'exarchos'`), the spawned argv is `['mcp', ...args]` so callers
   * never need to repeat the subcommand. When `command` is overridden,
   * `args` is passed through verbatim.
   */
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

const DEFAULT_COMMAND = 'exarchos';
const DEFAULT_SUBCOMMAND = 'mcp';
const DEFAULT_TIMEOUT_MS = 10_000;
const FORCE_KILL_GRACE_MS = 3_000;

/**
 * Spawns an MCP server binary over stdio and returns a connected `Client`.
 *
 * Defaults (v2.9 mode-dispatch pattern):
 *   - `command`: `'exarchos'` — the single shipped binary.
 *   - `args`: `['mcp', ...userArgs]` — `mcp` selects the MCP server mode
 *     (see `servers/exarchos-mcp/src/adapters/cli.ts`). Any args the
 *     caller supplies are appended after `mcp`. When the caller overrides
 *     `command` (e.g. with `'node'` for a mock server), `args` is passed
 *     through verbatim and `mcp` is NOT prepended.
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
    args: callerArgs = [],
    env: extraEnv,
    stateDir,
    timeout = DEFAULT_TIMEOUT_MS,
  } = opts;
  // When the caller leaves `command` at its default we are spawning the
  // mode-dispatched `exarchos` binary, so prepend the `mcp` subcommand.
  // Explicit overrides (tests using `node mock-server.mjs`, alternative
  // wrappers, etc.) get their args verbatim.
  const usingDefaultCommand = opts.command === undefined;
  const args = usingDefaultCommand
    ? [DEFAULT_SUBCOMMAND, ...callerArgs]
    : callerArgs;

  // Merge extra env with an optional state-dir shortcut. The actual env
  // var the binary reads is `WORKFLOW_STATE_DIR` (see
  // servers/exarchos-mcp/src/utils/paths.ts:54). Pre-fix we set
  // `EXARCHOS_STATE_DIR`, which the binary silently ignored — every
  // spawnMcpClient call quietly shared the host's default state dir
  // (`~/.exarchos/state` or `~/.claude/workflow-state`), invalidating
  // the F6.1 reconstructability test (both "independent" servers were
  // reading the same store). Set both for safety: `WORKFLOW_STATE_DIR`
  // is the load-bearing one, `EXARCHOS_STATE_DIR` is preserved in case
  // any downstream tool grows that surface.
  const env: Record<string, string> = { ...(extraEnv ?? {}) };
  if (stateDir !== undefined) {
    env.WORKFLOW_STATE_DIR = stateDir;
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
  // leak detection. Verified against @modelcontextprotocol/client 2.0.0.
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
