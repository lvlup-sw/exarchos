import { EventStore } from '../event-store/store.js';
import { SnapshotStore } from '../views/snapshot-store.js';
import type { DispatchContext } from './dispatch.js';
import type { StorageBackend } from '../storage/backend.js';
import { loadConfig } from '../config/loader.js';
import { loadProjectConfig } from '../config/yaml-loader.js';
import { resolveConfig } from '../config/resolve.js';
import { registerCustomWorkflows, registerCustomViews, registerCustomTools } from '../config/register.js';
import { createVcsProvider } from '../vcs/factory.js';
import { createConfigHookRunner } from '../hooks/config-hooks.js';

// EventStore is now threaded via DispatchContext — no module-level injection needed
import { configureCleanupSnapshotStore } from '../workflow/cleanup.js';
import { configureStateStoreBackend } from '../workflow/state-store.js';

// ─── Context Options ────────────────────────────────────────────────────────

export interface InitializeContextOptions {
  /** Optional storage backend for test injection. When omitted, JSONL-only mode. */
  readonly backend?: StorageBackend;
  /** Optional project root directory to load exarchos.config.ts/.js from. */
  readonly projectRoot?: string;
  /**
   * When true, the EventStore's `initialize()` blocks until the PID lock can
   * be acquired rather than entering sidecar mode. Intended for short-lived
   * CLI invocations that must serialize writes with any concurrent invocation
   * (DR-5). Leave unset for long-running MCP server paths, which prefer the
   * existing "first-wins + sidecar" semantics.
   */
  readonly waitForLock?: boolean;
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
  await eventStore.initialize(
    options?.waitForLock ? { waitForLock: true } : undefined,
  );

  // SnapshotStore is still module-level (out of scope for EventStore threading)
  configureCleanupSnapshotStore(new SnapshotStore(stateDir));

  const enableTelemetry = process.env.EXARCHOS_TELEMETRY !== 'false';

  // Load YAML project config (.exarchos.yml) before JS/TS config
  const projectConfig = options?.projectRoot
    ? resolveConfig(loadProjectConfig(options.projectRoot))
    : undefined;

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

  // Create VCS provider and hook runner from resolved project config
  const vcsProvider = projectConfig ? createVcsProvider(projectConfig) : undefined;
  const hookRunner = projectConfig ? createConfigHookRunner(projectConfig) : undefined;

  return { stateDir, eventStore, enableTelemetry, config, projectConfig, vcsProvider, hookRunner };
}
