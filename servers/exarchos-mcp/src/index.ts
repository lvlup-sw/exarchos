#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { homedir } from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';

import { logger } from './logger.js';
import { expandTilde } from './utils/paths.js';
import { EventStore } from './event-store/store.js';
import { SnapshotStore } from './views/snapshot-store.js';

// Storage backend
import type { StorageBackend } from './storage/backend.js';

// EventStore configuration — workflow modules require explicit injection
import { configureWorkflowEventStore } from './workflow/tools.js';
import { configureNextActionEventStore } from './workflow/next-action.js';
import { configureCancelEventStore } from './workflow/cancel.js';
import { configureCleanupEventStore, configureCleanupSnapshotStore } from './workflow/cleanup.js';
import { configureQueryEventStore } from './workflow/query.js';
import { configureQualityEventStore } from './quality/hints.js';
import { configureStateStoreBackend } from './workflow/state-store.js';

// New dispatch layer
import { initializeContext } from './core/context.js';
import { createMcpServer } from './adapters/mcp.js';
import { buildCli } from './adapters/cli.js';
import type { DispatchContext } from './core/dispatch.js';

// Hook CLI commands invoked by Claude Code hooks (hooks.json).
// These are detected early in main() and routed through a lightweight path
// that avoids the expensive backend initialization and heavy eval deps.
const HOOK_COMMANDS = new Set([
  'pre-compact', 'session-start', 'guard', 'task-gate', 'teammate-gate',
  'subagent-context', 'session-end',
]);

// ─── Constants ───────────────────────────────────────────────────────────────

export const SERVER_NAME = 'exarchos-mcp';
export const SERVER_VERSION = '2.4.0';

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
 * Synchronous wrapper that initializes DispatchContext inline and delegates
 * to createMcpServer(). Kept for backward compatibility with existing tests.
 *
 * For new code, prefer initializeContext() + createMcpServer() directly.
 */
export function createServer(
  stateDir: string,
  options?: CreateServerOptions,
): McpServer {
  const backend = options?.backend;

  // Configure module-level stores (same as initializeContext, but synchronous)
  configureStateStoreBackend(backend);

  const eventStore = new EventStore(stateDir, { backend });

  configureWorkflowEventStore(eventStore);
  configureNextActionEventStore(eventStore);
  configureCancelEventStore(eventStore);
  configureCleanupEventStore(eventStore);
  configureCleanupSnapshotStore(new SnapshotStore(stateDir));
  configureQueryEventStore(eventStore);
  configureQualityEventStore(eventStore);

  const enableTelemetry = process.env.EXARCHOS_TELEMETRY !== 'false';

  const ctx: DispatchContext = { stateDir, eventStore, enableTelemetry };
  return createMcpServer(ctx);
}

// ─── State Directory Resolution ──────────────────────────────────────────────

export async function resolveStateDir(): Promise<string> {
  if (process.env.WORKFLOW_STATE_DIR) {
    return expandTilde(process.env.WORKFLOW_STATE_DIR);
  }

  return path.join(homedir(), '.claude', 'workflow-state');
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
  if (hookCommand && HOOK_COMMANDS.has(hookCommand)) {
    // Parse --plugin-root from argv if present (used by SessionStart hook)
    const pluginRootIdx = process.argv.indexOf('--plugin-root');
    if (pluginRootIdx !== -1 && process.argv[pluginRootIdx + 1]) {
      process.env.EXARCHOS_PLUGIN_ROOT = process.argv[pluginRootIdx + 1];
    }

    // Lightweight hook router — avoids importing cli.ts which transitively
    // pulls in promptfoo/playwright via eval handlers.
    const { resolveStateDir: resolveStateDirSync } = await import('./workflow/state-store.js');

    const rawInput = await hookReadStdin();
    const stdinData = hookParseStdinJson(rawInput);

    type HookResult = { error?: { code: string; message: string }; [key: string]: unknown };

    const handlers: Record<string, () => Promise<HookResult>> = {
      'pre-compact': async () => {
        const { handlePreCompact } = await import('./cli-commands/pre-compact.js');
        return handlePreCompact(stdinData, resolveStateDirSync());
      },
      'session-start': async () => {
        const { handleSessionStart } = await import('./cli-commands/session-start.js');
        const os = await import('node:os');
        return handleSessionStart(stdinData, resolveStateDirSync(), path.join(os.homedir(), '.claude', 'teams'));
      },
      'guard': async () => {
        const { handleGuard } = await import('./cli-commands/guard.js');
        return handleGuard(stdinData);
      },
      'task-gate': async () => {
        const { handleTaskGate } = await import('./cli-commands/gates.js');
        return handleTaskGate(stdinData);
      },
      'teammate-gate': async () => {
        const { handleTeammateGate } = await import('./cli-commands/gates.js');
        return handleTeammateGate(stdinData);
      },
      'subagent-context': async () => {
        const { handleSubagentContext } = await import('./cli-commands/subagent-context.js');
        return handleSubagentContext(stdinData);
      },
      'session-end': async () => {
        const { handleSessionEnd } = await import('./cli-commands/session-end.js');
        return handleSessionEnd(stdinData, resolveStateDirSync());
      },
    };

    const handler = handlers[hookCommand];
    const result = await handler();

    hookOutputJson(result);

    if (result.error) {
      const isGateCommand = hookCommand === 'task-gate' || hookCommand === 'teammate-gate';
      process.exitCode = isGateCommand && result.error.code === 'GATE_FAILED' ? 2 : 1;
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

    // Merge sidecar event files written by hook subprocesses
    const { mergeSidecarEvents } = await import('./storage/sidecar-merger.js');
    const sidecarStore = new EventStore(stateDir, { backend });
    await mergeSidecarEvents(stateDir, sidecarStore).catch((err) => {
      logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'Sidecar merge failed');
    });

    registerBackendCleanup(backend);
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

  // Use new dispatch layer
  const ctx = await initializeContext(stateDir, {
    backend,
    projectRoot: process.cwd(),
  });

  // Unified entry point — all routing via Commander CLI.
  // `exarchos mcp` starts the MCP server; other commands are CLI mode.
  // No args shows help.
  const program = buildCli(ctx);
  await program.parseAsync(process.argv);
}

// Only run main when executed directly (not when imported for testing)
const isDirectExecution =
  process.argv[1] &&
  (import.meta.url.endsWith(process.argv[1]) ||
    import.meta.url.endsWith(process.argv[1].replace(/\.ts$/, '.js')));

if (isDirectExecution) {
  main().catch((err) => {
    logger.fatal({ err }, 'MCP server fatal error');
    process.exit(1);
  });
}
