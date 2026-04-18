#!/usr/bin/env node

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import { logger } from './logger.js';
import { resolveStateDir as resolveStateDirFromPaths } from './utils/paths.js';
import { EventStore } from './event-store/store.js';
import { SnapshotStore } from './views/snapshot-store.js';

// Storage backend
import type { StorageBackend } from './storage/backend.js';

// EventStore is now threaded via DispatchContext — no module-level injection needed
import { configureCleanupSnapshotStore } from './workflow/cleanup.js';
import { configureStateStoreBackend } from './workflow/state-store.js';

// New dispatch layer
import { initializeContext } from './core/context.js';
// NOTE: `createMcpServer` is intentionally NOT imported at the top level —
// task 021 made MCP SDK loading dynamic to keep CLI cold-start under the
// 250ms p95 budget. See dynamic import at `createServer()` below.
import { buildCli, runCli } from './adapters/cli.js';
import { isHookCommand, handleHookCommand } from './adapters/hooks.js';
import type { DispatchContext } from './core/dispatch.js';

// NOTE: `./adapters/mcp.js` and the MCP SDK are intentionally NOT imported at
// the top level. They pull the MCP SDK (~60ms module-graph load) and the full
// tool-registration closure. Since the CLI-cold-start path (DR-5 / task 021)
// must stay under the p95=250ms budget, we load them only in two places:
//   1. `createServer()` — explicitly async, used by tests + library callers.
//   2. `adapters/cli.ts`'s `mcp` command — dynamic import inside the action.
// The CLI path for `wf status`, `describe`, hooks etc. never pays that cost.

// ─── Constants ───────────────────────────────────────────────────────────────

export const SERVER_NAME = 'exarchos-mcp';
export const SERVER_VERSION = '2.4.0';

// ─── Mode Detection ─────────────────────────────────────────────────────────

/**
 * Detect whether this process was invoked as the long-running MCP server
 * (`exarchos mcp`) rather than a short-lived CLI command.
 *
 * F-022-2: Use a strict positional check — `mcp` is only an MCP-mode
 * invocation when it is the first positional argument (argv[2]). A looser
 * `argv.includes('mcp')` check is unsafe because feature IDs like
 * `exarchos event append -f mcp ...` or view names like `--view mcp` would
 * flip detection and push short-lived CLI callers onto server-mode
 * (first-wins + sidecar) semantics, silently diverting their writes to a
 * sidecar file instead of serialising onto the main JSONL (DR-5).
 *
 * Exported for unit testing; callers should pass `process.argv` directly.
 */
export function isMcpServerInvocation(argv: readonly string[]): boolean {
  return argv[2] === 'mcp';
}

// ─── Server Options ─────────────────────────────────────────────────────────

export interface CreateServerOptions {
  /** Optional storage backend for test injection. When omitted, JSONL-only mode. */
  backend?: StorageBackend;
}

// ─── Backend Initialization ─────────────────────────────────────────────────

/**
 * Attempt to initialize a SqliteBackend for the given state directory.
 *
 * Returns the initialized backend, or `undefined` if:
 * - better-sqlite3 is not available (missing native binary)
 * - The SQLite DB file is corrupt AND self-healing retry also fails
 *
 * Self-healing: if the DB file is corrupt, it is deleted and initialization
 * is retried once. JSONL files remain the source of truth, so data is
 * rehydrated on the next startup.
 */
export async function initializeBackend(
  stateDir: string,
): Promise<StorageBackend | undefined> {
  const dbPath = path.join(stateDir, 'exarchos.db');

  try {
    const { SqliteBackend } = await import('./storage/sqlite-backend.js');
    const backend = new SqliteBackend(dbPath);

    try {
      backend.initialize();
      return backend;
    } catch (initErr) {
      // Close the failed backend to release file handles before deleting
      try { backend.close(); } catch { /* ignore close error on failed backend */ }

      // Corrupt DB: delete and retry once (self-healing from JSONL source of truth)
      logger.warn(
        { err: initErr instanceof Error ? initErr.message : String(initErr) },
        'SQLite DB corrupt — deleting and retrying',
      );

      try {
        fs.unlinkSync(dbPath);
      } catch (delErr) {
        if ((delErr as NodeJS.ErrnoException).code !== 'ENOENT') {
          logger.warn({ err: delErr instanceof Error ? delErr.message : String(delErr) }, 'Failed to delete corrupt DB file');
        }
      }

      // Also clean up WAL and SHM files
      for (const suffix of ['-wal', '-shm']) {
        try { fs.unlinkSync(dbPath + suffix); } catch (delErr) {
          if ((delErr as NodeJS.ErrnoException).code !== 'ENOENT') {
            logger.warn({ err: delErr instanceof Error ? delErr.message : String(delErr) }, `Failed to delete ${suffix} file`);
          }
        }
      }

      try {
        const retryBackend = new SqliteBackend(dbPath);
        retryBackend.initialize();
        logger.info('SQLite DB self-healed from JSONL source of truth');
        return retryBackend;
      } catch (retryErr) {
        logger.warn(
          { err: retryErr instanceof Error ? retryErr.message : String(retryErr) },
          'SQLite retry failed — falling back to JSONL-only mode',
        );
        return undefined;
      }
    }
  } catch (importErr) {
    // better-sqlite3 not available (missing native binary)
    logger.warn(
      { err: importErr instanceof Error ? importErr.message : String(importErr) },
      'better-sqlite3 not available — running in JSONL-only mode',
    );
    return undefined;
  }
}

// ─── Backend Cleanup ────────────────────────────────────────────────────────

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

// ─── Server Factory (backward compat) ────────────────────────────────────────

/**
 * Creates an MCP server with the given state directory and options.
 *
 * Async wrapper that initializes DispatchContext inline and delegates to
 * `createMcpServer()`. The underlying MCP SDK + tool-registration graph is
 * loaded lazily via dynamic import so that CLI cold-start paths
 * (e.g. `exarchos wf status`) do not pay the ~60ms MCP-SDK module-load cost.
 *
 * For new code, prefer `initializeContext()` +
 * `import('./adapters/mcp.js').createMcpServer()` directly.
 */
export async function createServer(
  stateDir: string,
  options?: CreateServerOptions,
): Promise<McpServer> {
  const backend = options?.backend;

  // Configure module-level stores (EventStore is threaded via DispatchContext)
  configureStateStoreBackend(backend);

  const eventStore = new EventStore(stateDir, { backend });

  // SnapshotStore is still module-level (out of scope for EventStore threading)
  configureCleanupSnapshotStore(new SnapshotStore(stateDir));

  const enableTelemetry = process.env.EXARCHOS_TELEMETRY !== 'false';

  const ctx: DispatchContext = { stateDir, eventStore, enableTelemetry };

  // Lazy-load the MCP adapter so the CLI cold-start path doesn't incur the
  // MCP-SDK import cost. See module-level note on top of file.
  const { createMcpServer } = await import('./adapters/mcp.js');
  return createMcpServer(ctx);
}

// ─── State Directory Resolution ──────────────────────────────────────────────

export async function resolveStateDir(): Promise<string> {
  return resolveStateDirFromPaths();
}

// ─── Hook CLI Utilities ──────────────────────────────────────────────────
// Inlined from cli.ts to avoid importing the full module (and its eval deps).

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

// ─── Main Entry Point ────────────────────────────────────────────────────────

async function main() {
  // ─── Hook Command Fast Path ────────────────────────────────────────────────
  // Hook commands (session-start, pre-compact, guard, etc.) are invoked as
  // subprocesses by Claude Code with tight timeouts (5-10s). They only need
  // lightweight state-dir access, not the full SQLite backend or hydration.
  // Intercept them here before the expensive initialization path.
  const hookCommand = process.argv[2];
  if (isHookCommand(hookCommand)) {
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

  const stateDir = await resolveStateDir();

  // Ensure state directory exists
  fs.mkdirSync(stateDir, { recursive: true });

  // Initialize SQLite backend with graceful fallback
  const backend = await initializeBackend(stateDir);

  if (backend) {
    // Hydrate SQLite from JSONL source of truth and migrate legacy files
    const { hydrateAll } = await import('./storage/hydration.js');
    const { migrateLegacyStateFiles, migrateLegacyOutbox, cleanupLegacyFiles } = await import('./storage/migration.js');

    await hydrateAll(backend, stateDir);
    await migrateLegacyStateFiles(backend, stateDir);
    await migrateLegacyOutbox(backend, stateDir);
    await cleanupLegacyFiles(stateDir);

    registerBackendCleanup(backend);
  }

  // DR-5: short-lived CLI invocations must block on the PID lock rather than
  // enter sidecar mode, so two concurrent `exarchos event append` calls
  // serialize onto the main JSONL. The long-running MCP server path still
  // prefers first-wins + sidecar semantics because competing hook subprocesses
  // cannot afford to wait. See `isMcpServerInvocation` for the rationale
  // behind the strict positional check.
  const isMcpMode = isMcpServerInvocation(process.argv);
  const ctx = await initializeContext(stateDir, {
    backend,
    projectRoot: process.cwd(),
    waitForLock: !isMcpMode,
  });

  // Unified entry point — all routing via Commander CLI.
  // `exarchos mcp` starts the MCP server; other commands are CLI mode.
  // No args shows help. DR-5: runCli installs exitOverride and funnels
  // Commander parse errors through the shared INVALID_INPUT contract so
  // the CLI facade rejects malformed input with the same `error.code` as
  // the MCP dispatch path.
  const program = buildCli(ctx);

  // ─── Execution-Mode Detection (F-021-5) ────────────────────────────────────
  // Server-mode-only work (sidecar-event merge + lifecycle compaction) runs
  // via a commander `preAction` hook instead of a positional `argv[2]` check.
  // The hook fires immediately before the `mcp` subcommand's `action()` and
  // is a no-op for every other command, which keeps CLI cold-start (`wf
  // status`, `vw *`, `schema`, etc.) free of the work that only makes sense
  // when the process stays alive. See DR-5 / task 021 cold-start budget.
  //
  // Future global flags like `--verbose` in front of `mcp` would have broken
  // the old `argv[2] === 'mcp'` check; the `actionCommand.name()` lookup is
  // robust to flag positioning. Coordinates with F-022-2.
  program.hook('preAction', async (_thisCommand, actionCommand) => {
    if (actionCommand.name() !== 'mcp') return;

    if (!ctx.eventStore.inSidecarMode) {
      const { startPeriodicMerge } = await import('./storage/sidecar-scheduler.js');
      const drainHandle = await startPeriodicMerge(stateDir, ctx.eventStore, undefined, { immediate: true });
      process.on('exit', () => drainHandle.stop());
    }

    // Lifecycle management: compact old workflows and rotate telemetry (fire-and-forget)
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

  // F-024: runCli installs exitOverride and funnels Commander parse errors
  // through the shared INVALID_INPUT contract.
  await runCli(program, process.argv);
}

/**
 * Decide whether this module is being executed directly (vs imported as a
 * library) by comparing `import.meta.url` to `process.argv[1]`.
 *
 * Two encoding hazards have to be handled:
 *   1. `import.meta.url` is a standard file:// URL, so path segments containing
 *      spaces or non-ASCII characters are percent-encoded (`%20` etc.) while
 *      `process.argv[1]` is a raw OS path. `fileURLToPath()` decodes and
 *      converts the URL into a platform path string.
 *   2. On Windows, decoded paths use backslashes but `argv[1]` may come
 *      through either separator style depending on the launcher. We normalize
 *      both sides to forward slashes before comparison.
 *
 * Without these, Windows users hit a silent CLI no-op — `main()` never ran
 * because `endsWith` never matched. See #1085.
 *
 * Exported for unit testing; callers should pass `import.meta.url` and
 * `process.argv[1]` directly.
 */
export function isDirectExecution(metaUrl: string, argv1: string | undefined): boolean {
  if (!argv1) return false;
  const modulePath = fileURLToPath(metaUrl).replace(/\\/g, '/');
  const normalizedArgv = argv1.replace(/\\/g, '/');
  return (
    modulePath.endsWith(normalizedArgv) ||
    modulePath.endsWith(normalizedArgv.replace(/\.ts$/, '.js'))
  );
}

if (isDirectExecution(import.meta.url, process.argv[1])) {
  main().catch((err) => {
    logger.fatal({ err }, 'MCP server fatal error');
    process.exit(1);
  });
}
