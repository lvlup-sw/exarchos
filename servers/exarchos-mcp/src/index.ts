#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { homedir } from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';

import { TOOL_REGISTRY, buildRegistrationSchema, buildToolDescription } from './registry.js';
import { formatResult, type ToolResult } from './format.js';
import { logger } from './logger.js';

// Composite handlers
import { handleWorkflow } from './workflow/composite.js';
import { handleEvent } from './event-store/composite.js';
import { handleOrchestrate } from './orchestrate/composite.js';
import { handleView } from './views/composite.js';
import { handleSync } from './sync/composite.js';

// EventStore configuration — workflow modules require explicit injection
// (non-workflow modules use lazy init via getStore())
import { configureWorkflowEventStore } from './workflow/tools.js';
import { configureNextActionEventStore } from './workflow/next-action.js';
import { configureCancelEventStore } from './workflow/cancel.js';
import { configureCleanupEventStore, configureCleanupSnapshotStore } from './workflow/cleanup.js';
import { configureQueryEventStore } from './workflow/query.js';
import { configureQualityEventStore } from './quality/hints.js';
import { configureStateStoreBackend } from './workflow/state-store.js';
import { EventStore } from './event-store/store.js';
import { SnapshotStore } from './views/snapshot-store.js';

// Storage backend
import type { StorageBackend } from './storage/backend.js';

// Telemetry middleware
import { withTelemetry } from './telemetry/middleware.js';

// ─── Constants ───────────────────────────────────────────────────────────────

export const SERVER_NAME = 'exarchos-mcp';
export const SERVER_VERSION = '1.0.0';

// ─── Composite Handler Map ──────────────────────────────────────────────────

type CompositeHandler = (
  args: Record<string, unknown>,
  stateDir: string,
) => Promise<ToolResult>;

const COMPOSITE_HANDLERS: Readonly<Record<string, CompositeHandler>> = {
  exarchos_workflow: handleWorkflow,
  exarchos_event: handleEvent,
  exarchos_orchestrate: handleOrchestrate,
  exarchos_view: handleView,
  exarchos_sync: handleSync,
};

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

// ─── Server Factory ──────────────────────────────────────────────────────────

export function createServer(
  stateDir: string,
  options?: CreateServerOptions,
): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });
  const backend = options?.backend;

  // Configure the module-level storage backend for state operations
  configureStateStoreBackend(backend);

  const eventStore = new EventStore(stateDir, { backend });

  // Configure module-level EventStore for workflow modules (no lazy init)
  configureWorkflowEventStore(eventStore);
  configureNextActionEventStore(eventStore);
  configureCancelEventStore(eventStore);
  configureCleanupEventStore(eventStore);
  configureCleanupSnapshotStore(new SnapshotStore(stateDir));
  configureQueryEventStore(eventStore);
  configureQualityEventStore(eventStore);

  // Register composite tools from registry
  const enableTelemetry = process.env.EXARCHOS_TELEMETRY !== 'false';

  for (const tool of TOOL_REGISTRY) {
    const handler = COMPOSITE_HANDLERS[tool.name];
    if (!handler) continue;

    const inputSchema = buildRegistrationSchema(tool.actions);
    const description = buildToolDescription(tool);

    const baseHandler = async (args: Record<string, unknown>) =>
      formatResult(await handler(args, stateDir));

    // Use registerTool() so the strict ZodObject is passed as inputSchema
    // directly, preserving .strict() validation that rejects unrecognized keys.
    // The server.tool() overload treats ZodObjects as annotations, not schemas.
    server.registerTool(
      tool.name,
      { description, inputSchema },
      enableTelemetry
        ? withTelemetry(baseHandler, tool.name, eventStore)
        : baseHandler,
    );
  }

  return server;
}

// ─── State Directory Resolution ──────────────────────────────────────────────

export async function resolveStateDir(): Promise<string> {
  if (process.env.WORKFLOW_STATE_DIR) {
    return process.env.WORKFLOW_STATE_DIR;
  }

  return path.join(homedir(), '.claude', 'workflow-state');
}

// ─── Main Entry Point ────────────────────────────────────────────────────────

async function main() {
  const stateDir = await resolveStateDir();

  // Ensure state directory exists
  fs.mkdirSync(stateDir, { recursive: true });

  // Initialize SQLite backend with graceful fallback
  const backend = await initializeBackend(stateDir);

  if (backend) {
    // Hydrate SQLite from JSONL source of truth and migrate legacy files
    const { hydrateAll } = await import('./storage/hydration.js');
    const { migrateLegacyStateFiles, migrateLegacyOutbox } = await import('./storage/migration.js');

    await hydrateAll(backend, stateDir);
    await migrateLegacyStateFiles(backend, stateDir);
    await migrateLegacyOutbox(backend, stateDir);

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

  const server = createServer(stateDir, { backend });
  const transport = new StdioServerTransport();
  await server.connect(transport);
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
