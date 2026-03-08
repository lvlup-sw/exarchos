import { EventStore } from '../event-store/store.js';
import { SnapshotStore } from '../views/snapshot-store.js';
import type { DispatchContext } from './dispatch.js';
import type { StorageBackend } from '../storage/backend.js';
import { loadConfig } from '../config/loader.js';
import { registerCustomWorkflows, registerCustomViews, registerCustomTools } from '../config/register.js';

// EventStore configuration — workflow modules require explicit injection
import { configureWorkflowEventStore } from '../workflow/tools.js';
import { configureNextActionEventStore } from '../workflow/next-action.js';
import { configureCancelEventStore } from '../workflow/cancel.js';
import { configureCleanupEventStore, configureCleanupSnapshotStore } from '../workflow/cleanup.js';
import { configureQueryEventStore } from '../workflow/query.js';
import { configureQualityEventStore } from '../quality/hints.js';
import { configureStateStoreBackend } from '../workflow/state-store.js';

// ─── Context Options ────────────────────────────────────────────────────────

export interface InitializeContextOptions {
  /** Optional storage backend for test injection. When omitted, JSONL-only mode. */
  readonly backend?: StorageBackend;
  /** Optional project root directory to load exarchos.config.ts/.js from. */
  readonly projectRoot?: string;
}

// ─── Context Initialization ─────────────────────────────────────────────────

/**
 * Creates a DispatchContext by initializing the EventStore, configuring
 * module-level stores, and determining telemetry settings.
 *
 * Extracted from createServer() to enable shared initialization between
 * MCP and CLI adapters.
 */
export async function initializeContext(
  stateDir: string,
  options?: InitializeContextOptions,
): Promise<DispatchContext> {
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

  const enableTelemetry = process.env.EXARCHOS_TELEMETRY !== 'false';

  // Load config from project root if provided
  const config = options?.projectRoot
    ? await loadConfig(options.projectRoot)
    : undefined;

  // Register custom workflows, views, and tools from config
  if (config) {
    if (config.workflows || config.events) {
      registerCustomWorkflows(config);
    }
    if (config.views && options?.projectRoot) {
      await registerCustomViews(config, options.projectRoot);
    }
    if (config.tools && options?.projectRoot) {
      await registerCustomTools(config, options.projectRoot);
    }
  }

  return { stateDir, eventStore, enableTelemetry, config };
}
