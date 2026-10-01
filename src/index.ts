#!/usr/bin/env node

/**
 * The entry point of the `exarchos` binary. `exarchos mcp` starts the MCP server, and every other command runs as a CLI command.
 * This module does not import `./adapters/mcp/mcp.js` or the MCP SDK at the top level, because CLI cold start has a 250ms p95 budget.
 * Only `createServer()` and the `mcp` action in `adapters/cli/cli.ts` load them, with a dynamic import.
 */

import type { V2McpServer } from './contract/sdk/seam.js';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { logger } from './logger.js';
import { resolveStateDir as resolveStateDirFromPaths, STORE_DB_FILENAME } from './utils/paths.js';
import { EventStore } from './events/store.js';
import { SnapshotStore } from './projections/views/snapshot-store.js';
import { buildDefaultProcessResolver } from './workflow/capabilities/resolver.js';

import type { StorageBackend } from './storage/backend.js';

import { configureCleanupSnapshotStore } from './workflow/cleanup.js';
import { configureStateStoreBackend } from './workflow/state-store.js';

import { initializeContext } from './dispatch/core/context.js';
import { buildCli, runCli, resolvePackageVersion } from './adapters/cli/cli.js';
import { isHookCommand, handleHookCommand } from './adapters/cli/hooks.js';
import type { DispatchContext } from './dispatch/core/dispatch.js';

export const SERVER_NAME = 'exarchos-mcp';
/**
 * The binary version. It must match the root `package.json` version, the version constant in `adapters/mcp/mcp.ts`, and `minBinaryVersion` in `.claude-plugin/plugin.json`.
 */
export const SERVER_VERSION = '2.12.1';

/**
 * Returns true when the process runs as the long-running MCP server (`exarchos mcp`), not as a short CLI command.
 * Only the first positional argument counts. A loose `argv.includes('mcp')` check also matches a feature ID such as `-f mcp`.
 * Pass `process.argv`.
 */
export function isMcpServerInvocation(argv: readonly string[]): boolean {
  return argv[2] === 'mcp';
}

export interface CreateServerOptions {
  /**
   * A storage backend for test injection. The production entry point always uses `initializeBackend()`, which throws when no SQLite driver loads.
   */
  backend?: StorageBackend;
}

/**
 * The loader of the SQLite backend module. Tests inject a stub that simulates a driver that fails to load.
 *
 * @internal
 */
export type SqliteBackendLoader = () => Promise<{
  SqliteBackend: typeof import('./storage/sqlite-backend.js').SqliteBackend;
}>;

const defaultSqliteBackendLoader: SqliteBackendLoader = () =>
  import('./storage/sqlite-backend.js');

/**
 * Opens the SQLite backend for a state directory, or throws. SQLite is the only event-store backend.
 *
 * It throws when the directory holds `*.events.jsonl` files and no SQLite database. That is v2.10 state, and a new empty database next to it orphans the old workflows.
 * It throws when neither `better-sqlite3` nor `bun:sqlite` loads.
 *
 * It does not catch a `SqliteCorruptError` from `initialize()`. A corrupt database has no recovery path, and an automatic rebuild destroys the evidence.
 * The file name comes from `STORE_DB_FILENAME`, so this path cannot drift from the other store-path computations.
 */
export async function initializeBackend(
  stateDir: string,
  loadSqliteBackend: SqliteBackendLoader = defaultSqliteBackendLoader,
): Promise<StorageBackend> {
  const dbPath = path.join(stateDir, STORE_DB_FILENAME);

  let stateEntries: string[];
  try {
    stateEntries = fs.readdirSync(stateDir);
  } catch {
    stateEntries = [];
  }
  const hasLegacyJsonl = stateEntries.some((name) => name.endsWith('.events.jsonl'));
  const hasSqliteDb = stateEntries.some(
    (name) => name === STORE_DB_FILENAME || name === 'events.db',
  );
  if (hasLegacyJsonl && !hasSqliteDb) {
    throw new Error(
      `Legacy v2.10 JSONL state directory detected at ${stateDir}. ` +
        `v2.11 has removed the JSONL importer — either stay on v2.10 ` +
        `to use this state, or wipe the state directory to start fresh on v2.11.`,
    );
  }

  let SqliteBackend: typeof import('./storage/sqlite-backend.js').SqliteBackend;
  try {
    ({ SqliteBackend } = await loadSqliteBackend());
  } catch (importErr) {
    const reason = importErr instanceof Error ? importErr.message : String(importErr);
    throw new Error(
      `SQLite driver unavailable — install better-sqlite3 (Node) or run under bun (bun:sqlite). ` +
        `Both drivers failed to load: ${reason}.`,
    );
  }

  const backend = new SqliteBackend(dbPath);
  backend.initialize();
  return backend;
}

/**
 * Register a process exit handler that closes the storage backend.
 */
export function registerBackendCleanup(backend: StorageBackend): void {
  process.on('exit', () => {
    try {
      backend.close();
    } catch (err) {
      logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'Failed to close storage backend on exit');
    }
  });
}

/**
 * Creates an MCP server for a state directory. It builds the DispatchContext inline and calls `createMcpServer()`.
 * It loads the MCP adapter lazily, so CLI cold start does not pay the MCP SDK load cost.
 *
 * The context carries the storage backend, so consumers do not import `bun:sqlite`.
 * The context turns on slim `tools/list` registration. Each tool shows its short `slimDescription`, and `describe` gives the full detail.
 * For new code, use `initializeContext()` and `createMcpServer()` directly.
 */
export async function createServer(
  stateDir: string,
  options?: CreateServerOptions,
): Promise<V2McpServer> {
  const backend = options?.backend;

  configureStateStoreBackend(backend);

  const eventStore = new EventStore(stateDir, { backend });

  configureCleanupSnapshotStore(new SnapshotStore(stateDir));

  const enableTelemetry = process.env.EXARCHOS_TELEMETRY !== 'false';

  const capabilityResolver = buildDefaultProcessResolver();

  const ctx: DispatchContext = { stateDir, eventStore, enableTelemetry, capabilityResolver, storage: backend, slimRegistration: true };

  const { createMcpServer } = await import('./adapters/mcp/mcp.js');
  return createMcpServer(ctx);
}

export async function resolveStateDir(): Promise<string> {
  return resolveStateDirFromPaths();
}

/**
 * Parses hook stdin as a JSON object, and returns `{}` for empty input.
 * The hook helpers copy the `cli.ts` helpers, so the hook path does not import `cli.ts` and its eval dependencies.
 */
function hookParseStdinJson(input: string): Record<string, unknown> {
  const trimmed = input.trim();
  if (trimmed.length === 0) return {};
  const parsed: unknown = JSON.parse(trimmed);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new TypeError('Expected JSON object, received ' + (Array.isArray(parsed) ? 'array' : typeof parsed));
  }
  return parsed as Record<string, unknown>;
}

function hookOutputJson(obj: unknown): void {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

function hookReadStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    if (process.stdin.isTTY) { resolve(''); return; }
    const chunks: Buffer[] = [];
    process.stdin.on('data', (chunk: Buffer) => chunks.push(chunk));
    process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    process.stdin.on('error', reject);
  });
}

/**
 * Runs the binary. Some commands take a fast path and never open the SQLite backend.
 *
 * Hook commands run with tight timeouts and need only the state directory.
 * `--version`, `-V` and a plain `version` print the version. Concurrent backend opens can race on WAL recovery and fail with SQLITE_BUSY_RECOVERY.
 *
 * `run-tests` runs the consumer test command for the PostToolUse hook. It is not a hook command, because hook commands only observe.
 * `verify-worktree-boundary` is the PreToolUse guard. It denies a write outside the worktree with exit code 2, and allows when stdin is a TTY.
 *
 * Every other command opens the backend and goes through Commander. Only the MCP tool registration reads `slimRegistration` from the context.
 * A `preAction` hook starts the hook-event merge and the lifecycle compaction for `mcp` only. The command-name check still works with flags before `mcp`.
 */
async function main() {
  const hookCommand = process.argv[2];
  if (hookCommand !== undefined && isHookCommand(hookCommand)) {
    const result = await handleHookCommand(
      hookCommand,
      process.argv,
      hookReadStdin,
      hookParseStdinJson,
      hookOutputJson,
    );
    if (result.handled && result.exitCode) {
      process.exitCode = result.exitCode;
    }
    return;
  }

  const versionArg = process.argv[2];
  if (versionArg === '--version' || versionArg === '-V') {
    process.stdout.write(`${resolvePackageVersion()}\n`);
    return;
  }

  if (versionArg === 'version' && process.argv[3] === undefined) {
    process.stdout.write(`${resolvePackageVersion()}\n`);
    return;
  }

  if (process.argv[2] === 'run-tests') {
    const { handleRunTests } = await import('./lifecycle/run-tests.js');
    process.exitCode = handleRunTests(process.argv.slice(3), { cwd: process.cwd() });
    return;
  }

  if (process.argv[2] === 'verify-worktree-boundary') {
    const { handleVerifyWorktreeBoundary } = await import(
      './lifecycle/verify-worktree-boundary.js'
    );
    const stdin = process.stdin.isTTY ? '' : fs.readFileSync(0, 'utf8');
    process.exitCode = handleVerifyWorktreeBoundary(stdin);
    return;
  }

  const stateDir = await resolveStateDir();

  fs.mkdirSync(stateDir, { recursive: true });

  const backend = await initializeBackend(stateDir);
  registerBackendCleanup(backend);

  const ctx: DispatchContext = {
    ...(await initializeContext(stateDir, {
      backend,
      projectRoot: process.cwd(),
    })),
    slimRegistration: true,
  };

  const program = buildCli(ctx);

  program.hook('preAction', async (_thisCommand, actionCommand) => {
    if (actionCommand.name() !== 'mcp') return;

    {
      const { startPeriodicMerge } = await import('./storage/sidecar-scheduler.js');
      const drainHandle = await startPeriodicMerge(stateDir, ctx.eventStore, undefined, { immediate: true });
      process.on('exit', () => drainHandle.stop());
    }

    void import('./storage/lifecycle.js')
      .then(({ checkCompaction, rotateTelemetry, DEFAULT_LIFECYCLE_POLICY }) => {
        void checkCompaction(backend, stateDir, DEFAULT_LIFECYCLE_POLICY).catch((err) => {
          logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'Lifecycle compaction failed');
        });
        void rotateTelemetry(backend, stateDir, DEFAULT_LIFECYCLE_POLICY).catch((err) => {
          logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'Telemetry rotation failed');
        });
      })
      .catch((err) => {
        logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'Failed to load lifecycle module');
      });
  });

  await runCli(program, process.argv);
}

/**
 * Returns true when this module runs directly, not as an import. It compares `import.meta.url` with `process.argv[1]`.
 * `fileURLToPath()` decodes the percent-encoded URL. Both sides use forward slashes, because a Windows launcher can give either separator.
 * `argv[1]` goes through `realpathSync`, because ESM reports the real path of an `npm link` symlink target.
 * Without these steps, `main()` silently does not run.
 */
export function isDirectExecution(metaUrl: string, argv1: string | undefined): boolean {
  if (!argv1) return false;
  const modulePath = fileURLToPath(metaUrl).replace(/\\/g, '/');
  const resolvedArgv = (() => {
    try {
      return realpathSync(argv1).replace(/\\/g, '/');
    } catch {
      return argv1.replace(/\\/g, '/');
    }
  })();
  return (
    modulePath.endsWith(resolvedArgv) ||
    modulePath.endsWith(resolvedArgv.replace(/\.ts$/, '.js'))
  );
}

if (isDirectExecution(import.meta.url, process.argv[1])) {
  main().catch((err) => {
    logger.fatal({ err }, 'MCP server fatal error');
    process.exit(1);
  });
}
